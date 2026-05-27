// app/api/scrape/manual/route.ts
//
// Manual SD3 scrape — POST endpoint for triggering arbitrary date ranges.
// Powers the dashboard "Refresh Now" button and one-time backfills.
//
// Supports three modes:
//   ?mode=daily&date=YYYY-MM-DD                                — re-scrape one day
//   ?mode=daily&start=YYYY-MM-DD&end=YYYY-MM-DD                — backfill date range (loops daily)
//   ?mode=weekly&start=YYYY-MM-DD&end=YYYY-MM-DD               — pull one specific fiscal week
//   ?mode=monthly&start=YYYY-MM-DD&end=YYYY-MM-DD              — pull one specific fiscal month
//
// Auth: requires ?secret= or Bearer header (same as the other scrape routes).

import { NextResponse } from 'next/server'
import {
  authenticate,
  fetchSalons,
  fetchDailyStoreSummary,
  fetchGroupedSummary,
  batchMap,
  type SD3DailyStoreSummary,
} from '@/lib/sd3'
import { upsertSheet } from '@/lib/sheets'
import { aggregatePeriod, type AggregatedPeriod } from '@/lib/aggregate'
import { addDays, fromISODate, toISODate } from '@/lib/fiscal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ── Tabs & columns ───────────────────────────────────────────

const SD_DAILY_TAB = 'SD_DAILY'
const SD_WEEKLY_TAB = 'SD_WEEKLY'
const SD_MONTHLY_TAB = 'SD_MONTHLY'

const DAILY_COLUMNS = [
  'date',
  'storeId',
  'customerCount',
  'newCustomerCount',
  'newCustomerVisitCount',
  'newCustomerReturnCount',
  'repeatCustomerVisitCount',
  'repeatCustomerReturnCount',
  'serviceSales',
  'productSales',
  'grossHaircutSales',
  'floorHours',
  'approximatePayrollAmount',
  'trainingPay',
  'haircutCount',
  'haircutOnlyInvoiceCount',
  'haircutOnlyServiceMinutes',
  'waitOver15MinsCount',
  'nonOciWaitOver15MinsCount',
  'nonOciCustomerCount',
  'ociCompletedInvoiceCount',
  'nonCutWithCustWaitingMinutes',
  'totalCustomerWaitMinutes',
  'longestWaitMinutes',
  'voidCount',
  'redoAmount',
  'serviceDiscounts',
  'productDiscounts',
  'scrapedAt',
] as const

const PERIOD_COLUMNS = [
  'cc',
  'newCust',
  'newCustPct',
  'serviceSales',
  'productSales',
  'totalSales',
  'floorHours',
  'payrollAmount',
  'trainingPay',
  'cph',
  'payrollPct',
  'payrollPctNoTraining',
  'productPct',
  'hcTime',
  'mbc',
  'avgWaitTime',
  'waits',
  'nonOciWaits',
  'ssWaits',
  'nr',
  'rr',
  'scrapedAt',
] as const

const WEEKLY_COLUMNS = ['weekEnd', 'weekStart', 'storeId', ...PERIOD_COLUMNS] as const
const MONTHLY_COLUMNS = ['monthEnd', 'monthStart', 'storeId', ...PERIOD_COLUMNS] as const

// ── Row builders ─────────────────────────────────────────────

function dailyRow(s: SD3DailyStoreSummary): Record<string, any> {
  const row: Record<string, any> = {}
  for (const col of DAILY_COLUMNS) row[col] = s[col] ?? ''
  row.date = s.date
  row.storeId = s.storeId
  row.scrapedAt = new Date().toISOString()
  return row
}

function periodRow(
  agg: AggregatedPeriod,
  endKey: 'weekEnd' | 'monthEnd',
  startKey: 'weekStart' | 'monthStart'
): Record<string, any> {
  return {
    [endKey]: agg.endDate,
    [startKey]: agg.startDate,
    storeId: agg.storeId,
    cc: agg.cc,
    newCust: agg.newCust,
    newCustPct: agg.newCustPct,
    serviceSales: agg.serviceSales,
    productSales: agg.productSales,
    totalSales: agg.totalSales,
    floorHours: agg.floorHours,
    payrollAmount: agg.payrollAmount,
    trainingPay: agg.trainingPay,
    cph: agg.cph,
    payrollPct: agg.payrollPct,
    payrollPctNoTraining: agg.payrollPctNoTraining,
    productPct: agg.productPct,
    hcTime: agg.hcTime,
    mbc: agg.mbc,
    avgWaitTime: agg.avgWaitTime,
    waits: agg.waits,
    nonOciWaits: agg.nonOciWaits,
    ssWaits: agg.ssWaits,
    nr: agg.nr,
    rr: agg.rr,
    scrapedAt: new Date().toISOString(),
  }
}

// ── Auth ─────────────────────────────────────────────────────

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

// ── Date range expansion ─────────────────────────────────────

/** Inclusive list of ISO dates from start through end. */
function expandDateRange(start: string, end: string): string[] {
  const out: string[] = []
  const last = fromISODate(end)
  let cursor = fromISODate(start)
  while (cursor.getTime() <= last.getTime()) {
    out.push(toISODate(cursor))
    cursor = fromISODate(addDays(toISODate(cursor), 1))
  }
  return out
}

// ── Handlers per mode ────────────────────────────────────────

async function runDaily(date: string) {
  const session = await authenticate()
  const salons = await fetchSalons(session)

  const fetched = await batchMap(salons, 4, async salon => {
    try {
      const rows = await fetchDailyStoreSummary(session, salon.storeId, date, date)
      return rows.map(r => dailyRow(r))
    } catch (err) {
      console.error(`[scrape/manual:daily] ${salon.salonNum} ${date}:`, err)
      return [] as Record<string, any>[]
    }
  })

  const rows = fetched.flat()
  if (rows.length === 0) {
    return { date, salonsProcessed: 0, updated: 0, inserted: 0 }
  }

  const upsertResult = await upsertSheet(
    SD_DAILY_TAB,
    [...DAILY_COLUMNS],
    ['date', 'storeId'],
    rows
  )
  return {
    date,
    salonsProcessed: rows.length,
    updated: upsertResult.updated,
    inserted: upsertResult.inserted,
  }
}

async function runWeekly(weekStart: string, weekEnd: string) {
  const session = await authenticate()
  const salons = await fetchSalons(session)

  const fetched = await batchMap(salons, 4, async salon => {
    try {
      const [grouped, daily] = await Promise.all([
        fetchGroupedSummary(session, salon.storeId, weekStart, weekEnd),
        fetchDailyStoreSummary(session, salon.storeId, weekStart, weekEnd),
      ])
      if (!grouped) return null
      const agg = aggregatePeriod(grouped, daily, weekStart, weekEnd)
      return periodRow(agg, 'weekEnd', 'weekStart')
    } catch (err) {
      console.error(`[scrape/manual:weekly] ${salon.salonNum}:`, err)
      return null
    }
  })

  const rows = fetched.filter((r): r is Record<string, any> => r !== null)
  if (rows.length === 0) {
    return { weekStart, weekEnd, salonsProcessed: 0, updated: 0, inserted: 0 }
  }

  const upsertResult = await upsertSheet(
    SD_WEEKLY_TAB,
    [...WEEKLY_COLUMNS],
    ['weekEnd', 'storeId'],
    rows
  )
  return {
    weekStart,
    weekEnd,
    salonsProcessed: rows.length,
    updated: upsertResult.updated,
    inserted: upsertResult.inserted,
  }
}

async function runMonthly(monthStart: string, monthEnd: string) {
  const session = await authenticate()
  const salons = await fetchSalons(session)

  const fetched = await batchMap(salons, 4, async salon => {
    try {
      const [grouped, daily] = await Promise.all([
        fetchGroupedSummary(session, salon.storeId, monthStart, monthEnd),
        fetchDailyStoreSummary(session, salon.storeId, monthStart, monthEnd),
      ])
      if (!grouped) return null
      const agg = aggregatePeriod(grouped, daily, monthStart, monthEnd)
      return periodRow(agg, 'monthEnd', 'monthStart')
    } catch (err) {
      console.error(`[scrape/manual:monthly] ${salon.salonNum}:`, err)
      return null
    }
  })

  const rows = fetched.filter((r): r is Record<string, any> => r !== null)
  if (rows.length === 0) {
    return { monthStart, monthEnd, salonsProcessed: 0, updated: 0, inserted: 0 }
  }

  const upsertResult = await upsertSheet(
    SD_MONTHLY_TAB,
    [...MONTHLY_COLUMNS],
    ['monthEnd', 'storeId'],
    rows
  )
  return {
    monthStart,
    monthEnd,
    salonsProcessed: rows.length,
    updated: upsertResult.updated,
    inserted: upsertResult.inserted,
  }
}

// ── GET handler ──────────────────────────────────────────────

export async function GET(request: Request) {
  const startedAt = Date.now()

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const mode = (url.searchParams.get('mode') || '').toLowerCase()
  const dateParam = url.searchParams.get('date')
  const startParam = url.searchParams.get('start')
  const endParam = url.searchParams.get('end')

  try {
    if (mode === 'daily') {
      // Either a single date (?date=) or a range (?start=&end=)
      if (dateParam) {
        const result = await runDaily(dateParam)
        return NextResponse.json({
          ok: true,
          mode: 'daily',
          durationMs: Date.now() - startedAt,
          ...result,
        })
      }
      if (startParam && endParam) {
        const dates = expandDateRange(startParam, endParam)
        console.log(
          `[scrape/manual:daily] backfill ${startParam} → ${endParam} (${dates.length} days)`
        )
        const perDay = []
        for (const d of dates) {
          const r = await runDaily(d)
          perDay.push(r)
        }
        const totalInserted = perDay.reduce((s, r) => s + r.inserted, 0)
        const totalUpdated = perDay.reduce((s, r) => s + r.updated, 0)
        return NextResponse.json({
          ok: true,
          mode: 'daily-range',
          startDate: startParam,
          endDate: endParam,
          daysProcessed: dates.length,
          totalInserted,
          totalUpdated,
          durationMs: Date.now() - startedAt,
        })
      }
      return NextResponse.json(
        { ok: false, error: 'daily mode requires ?date= or ?start=&end=' },
        { status: 400 }
      )
    }

    if (mode === 'weekly') {
      if (!startParam || !endParam) {
        return NextResponse.json(
          { ok: false, error: 'weekly mode requires ?start=&end=' },
          { status: 400 }
        )
      }
      const result = await runWeekly(startParam, endParam)
      return NextResponse.json({
        ok: true,
        mode: 'weekly',
        durationMs: Date.now() - startedAt,
        ...result,
      })
    }

    if (mode === 'monthly') {
      if (!startParam || !endParam) {
        return NextResponse.json(
          { ok: false, error: 'monthly mode requires ?start=&end=' },
          { status: 400 }
        )
      }
      const result = await runMonthly(startParam, endParam)
      return NextResponse.json({
        ok: true,
        mode: 'monthly',
        durationMs: Date.now() - startedAt,
        ...result,
      })
    }

    return NextResponse.json(
      {
        ok: false,
        error:
          'Missing or invalid ?mode=. Valid modes: daily, weekly, monthly.',
      },
      { status: 400 }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scrape/manual] fatal:', msg)
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    )
  }
}