// app/api/scrape/employee/route.ts
//
// Employee performance SD3 scraper — pulls the Employee Performance Consolidated
// report (Detail mode) for the most-recently-completed fiscal week (Sat→Fri),
// for ALL salons in a single CSV request, and upserts one row per
// (weekEnd, storeId, payId) into SD_EMP_WEEKLY.
//
// Endpoint: /rest/dailyemployeesummary/consolidated.csv?selectEmployees=true&isDetail=true
//   - Single request returns every salon (no per-salon loop).
//   - Weekly only: start=Saturday, end=Friday.
//   - Token is passed in the URL (CSV download), not the Authorization header.
//
// Storage: SD_EMP_WEEKLY tab, upserted by (weekEnd, storeId, payId).
//   Multi-salon employees get one row per salon; SD3's "Totals/Averages" rows
//   are dropped (the dashboard aggregates per its own logic, consistent with
//   the daily-first architecture).
//
// Manual override:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   pulls that specific week
//   ?secret=...                         required (or Bearer header)

import { NextResponse } from 'next/server'
import {
  authenticate,
  fetchSalons,
  fetchEmployeePerformanceCsv,
} from '@/lib/sd3'
import { upsertSheet } from '@/lib/sheets'
import { parseCsv, rowsToObjectsAt, num, returnRate } from '@/lib/csv'
import { lastCompletedFiscalWeek, todayET } from '@/lib/fiscal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SD_EMP_WEEKLY_TAB = 'SD_EMP_WEEKLY'

// The Employee Performance CSV header is on line 5 (0-based index 4):
// 4 title/filter lines precede it. Data rows follow; 4 footnote lines trail.
const EMP_HEADER_ROW_INDEX = 4

// Output sheet columns (field names chosen to match the dashboard's EmpData shape).
const COLUMNS = [
  'weekEnd',        // YYYY-MM-DD (Friday)
  'salonNum',       // public salon number, e.g. "3062"
  'storeId',        // internal SD3 store id (joined from listx)
  'globalId',       // Global EE ID
  'payId',          // Pay ID (join key to payroll + AM floor hours)
  'employeeName',   // "Last, First"
  'position',       // S / M / A
  'floorHours',
  'custCount',
  'hcTime',         // Avg HC Time (minutes)
  'cph',            // Cuts Per Hour
  'productPct',     // Stnd Prod %
  'mbc',            // Avg Min Btwn Cust w/ Cust Waiting
  'nonCutMph',      // Total NonCut Time MPH
  'productivity',
  'payrollPct',
  'nr',             // Stylist New Cust Return %  (null if low-sample ***)
  'rr',             // Stylist Repeat Cust Return % (null if low-sample ***)
  'scrapedAt',
] as const

// SD3 CSV header names → our fields
function rowFromCsv(
  o: Record<string, string>,
  weekEnd: string,
  storeIdMap: Record<string, number>
): Record<string, any> | null {
  const salonNum = (o['Salon #'] || '').trim()
  const position = (o['Position'] || '').trim()

  // Skip Totals/Averages rows (salon cell reads " Totals/Averages") and any
  // footnote lines (salon cell is not one of our known salon numbers).
  const storeId = storeIdMap[salonNum]
  if (!storeId) return null
  if (!position) return null

  return {
    weekEnd,
    salonNum,
    storeId,
    globalId: (o['Global EE ID'] || '').trim(),
    payId: (o['Pay ID'] || '').trim(),
    employeeName: (o['Employee Name'] || '').trim(),
    position,
    floorHours: num(o['Floor Hours']) ?? '',
    custCount: num(o['Cust Count']) ?? '',
    hcTime: num(o['Avg HC Time']) ?? '',
    cph: num(o['Cuts Per Hour']) ?? '',
    productPct: num(o['Stnd Prod %']) ?? '',
    mbc: num(o['Avg Min Btwn Cust w/ Cust Waiting']) ?? '',
    nonCutMph: num(o['Total NonCut Time MPH']) ?? '',
    productivity: num(o['Productivity']) ?? '',
    payrollPct: num(o['Payroll %']) ?? '',
    nr: returnRate(o['Stylist New Cust Return %']) ?? '',
    rr: returnRate(o['Stylist Repeat Cust Return %']) ?? '',
    scrapedAt: new Date().toISOString(),
  }
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

export async function GET(request: Request) {
  const startedAt = Date.now()

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const startParam = url.searchParams.get('start')
  const endParam = url.searchParams.get('end')

  let weekStart: string
  let weekEnd: string
  if (startParam && endParam) {
    weekStart = startParam
    weekEnd = endParam
  } else {
    const w = lastCompletedFiscalWeek(todayET())
    weekStart = w.start
    weekEnd = w.end
  }

  const results = {
    weekStart,
    weekEnd,
    employeesProcessed: 0,
    rowsUpserted: 0,
    updated: 0,
    inserted: 0,
    skipped: 0,
    error: null as string | null,
  }

  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    const storeIdMap: Record<string, number> = {}
    for (const s of salons) storeIdMap[s.salonNum] = s.storeId
    const storeIds = salons.map(s => s.storeId)

    console.log(
      `[scrape/employee] ${weekStart}→${weekEnd} — single CSV pull, ${storeIds.length} salons`
    )

    // Single request returns all salons as CSV text.
    const csvText = await fetchEmployeePerformanceCsv(
      session,
      storeIds,
      weekStart,
      weekEnd
    )

    const rows = parseCsv(csvText)
    const objects = rowsToObjectsAt(rows, EMP_HEADER_ROW_INDEX)

    const dataRows: Record<string, any>[] = []
    for (const o of objects) {
      const row = rowFromCsv(o, weekEnd, storeIdMap)
      if (row) dataRows.push(row)
      else results.skipped++
    }
    results.employeesProcessed = dataRows.length

    if (dataRows.length > 0) {
      const upsertResult = await upsertSheet(
        SD_EMP_WEEKLY_TAB,
        [...COLUMNS],
        ['weekEnd', 'storeId', 'payId'],
        dataRows
      )
      results.rowsUpserted = dataRows.length
      results.updated = upsertResult.updated
      results.inserted = upsertResult.inserted
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[scrape/employee] ✓ ${weekStart}→${weekEnd} — ${results.employeesProcessed} rows, ` +
        `${results.inserted} inserted, ${results.updated} updated, ` +
        `${results.skipped} skipped, ${durationMs}ms`
    )

    return NextResponse.json({ ok: true, durationMs, ...results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    results.error = msg
    console.error('[scrape/employee] fatal:', msg)
    return NextResponse.json({ ok: false, ...results }, { status: 500 })
  }
}