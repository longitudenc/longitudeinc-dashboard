// app/api/scrape/payroll/route.ts
//
// Payroll consolidated SD3 scraper — pulls the Payroll Consolidated report for
// the most-recently-completed fiscal week (Sat→Fri) for ALL salons in a single
// CSV request, and upserts one row per (weekEnd, storeId, payId) into SD_PAYROLL.
//
// Endpoint: /rest/payrollweekresult/consolidated.csv
//   - Single request returns every salon (no per-salon loop).
//   - Weekly only: start=Saturday, end=Friday. No pre-run options.
//   - Token is passed in the URL (CSV download), not the Authorization header.
//   - Header on line 1, no preamble, no footer.
//
// Storage: SD_PAYROLL tab, upserted by (weekEnd, storeId, payId).
//
// Feeds: Manager Bonus (floor-hours qualifying threshold) and AM Bonus.
// We keep the hours breakdown plus the incentive/tip fields the dashboard uses;
// the full 39-column CSV is not all stored — easy to add columns later.
//
// Manual override:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   pulls that specific week
//   ?secret=...                         required (or Bearer header)

import { NextResponse } from 'next/server'
import {
  authenticate,
  fetchSalons,
  fetchPayrollCsv,
} from '@/lib/sd3'
import { upsertSheet } from '@/lib/sheets'
import { parseCsv, rowsToObjectsAt, num } from '@/lib/csv'
import { lastCompletedFiscalWeek, todayET } from '@/lib/fiscal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SD_PAYROLL_TAB = 'SD_PAYROLL'

// Payroll CSV header is on line 1 (0-based index 0).
const PAYROLL_HEADER_ROW_INDEX = 0

const COLUMNS = [
  'weekEnd',          // YYYY-MM-DD (Friday)
  'salonNum',
  'storeId',
  'globalId',         // Global Employee ID
  'payId',            // Payroll ID (join key to employee perf + AM hours)
  'employeeName',     // "LAST, FIRST M"
  'baseWage',
  'floorHours',       // qualifying hours for bonus thresholds
  'closingHours',
  'trainingHours',
  'adminHours',
  'receptionHours',
  'totalHoursWorked',
  'vacationHours',
  'holidayHours',
  'sickHours',
  'totalHours',
  'overtimeHours',
  'subTotalPay',
  'productivityIncentive',
  'productIncentive',
  'newReturnIncentive',
  'totalTips',
  'effectiveWageNoOt',
  'effectiveWageOt',
  'scrapedAt',
] as const

function rowFromCsv(
  o: Record<string, string>,
  weekEnd: string,
  storeIdMap: Record<string, number>
): Record<string, any> | null {
  const salonNum = (o['Salon #'] || '').trim()
  const storeId = storeIdMap[salonNum]
  if (!storeId) return null // skip any non-salon row

  return {
    weekEnd,
    salonNum,
    storeId,
    globalId: (o['Global Employee ID'] || '').trim(),
    payId: (o['Payroll ID'] || '').trim(),
    employeeName: (o['Employee Name'] || '').trim(),
    baseWage: num(o['Base Wage']) ?? '',
    floorHours: num(o['Floor Hours']) ?? '',
    closingHours: num(o['Closing Hours']) ?? '',
    trainingHours: num(o['Training Hours']) ?? '',
    adminHours: num(o['Admin Hours']) ?? '',
    receptionHours: num(o['Reception Hours']) ?? '',
    totalHoursWorked: num(o['Total Hours Worked']) ?? '',
    vacationHours: num(o['Vacation Hours']) ?? '',
    holidayHours: num(o['Holiday Hours']) ?? '',
    sickHours: num(o['Sick Hours']) ?? '',
    totalHours: num(o['Total Hours']) ?? '',
    overtimeHours: num(o['Overtime Hours']) ?? '',
    subTotalPay: num(o['Sub-Total Pay']) ?? '',
    productivityIncentive: num(o['Productivity Incentive']) ?? '',
    productIncentive: num(o['Product Incentive']) ?? '',
    newReturnIncentive: num(o['New Return Incentive']) ?? '',
    totalTips: num(o['Total Tips']) ?? '',
    effectiveWageNoOt: num(o['Effective Wage w/o Overtime']) ?? '',
    effectiveWageOt: num(o['Effective Wage w/ Overtime']) ?? '',
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
      `[scrape/payroll] ${weekStart}→${weekEnd} — single CSV pull, ${storeIds.length} salons`
    )

    const csvText = await fetchPayrollCsv(session, storeIds, weekStart, weekEnd)

    const rows = parseCsv(csvText)
    const objects = rowsToObjectsAt(rows, PAYROLL_HEADER_ROW_INDEX)

    const dataRows: Record<string, any>[] = []
    for (const o of objects) {
      const row = rowFromCsv(o, weekEnd, storeIdMap)
      if (row) dataRows.push(row)
      else results.skipped++
    }
    results.employeesProcessed = dataRows.length

    if (dataRows.length > 0) {
      const upsertResult = await upsertSheet(
        SD_PAYROLL_TAB,
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
      `[scrape/payroll] ✓ ${weekStart}→${weekEnd} — ${results.employeesProcessed} rows, ` +
        `${results.inserted} inserted, ${results.updated} updated, ` +
        `${results.skipped} skipped, ${durationMs}ms`
    )

    return NextResponse.json({ ok: true, durationMs, ...results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    results.error = msg
    console.error('[scrape/payroll] fatal:', msg)
    return NextResponse.json({ ok: false, ...results }, { status: 500 })
  }
}