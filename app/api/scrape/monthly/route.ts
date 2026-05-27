// app/api/scrape/monthly/route.ts

import { NextResponse } from 'next/server'
import {
  authenticate,
  fetchSalons,
  fetchGroupedSummary,
  fetchDailyStoreSummary,
} from '@/lib/sd3'
import { upsertSheet } from '@/lib/sheets'
import { aggregatePeriod, type AggregatedPeriod } from '@/lib/aggregate'
import {
  lastCompletedFiscalMonth,
  yesterdayET,
  isLastFridayOfMonth,
} from '@/lib/fiscal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SD_MONTHLY_TAB = 'SD_MONTHLY'

const COLUMNS = [
  'monthEnd',
  'monthStart',
  'storeId',
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

function rowFromAggregate(agg: AggregatedPeriod): Record<string, any> {
  return {
    monthEnd: agg.endDate,
    monthStart: agg.startDate,
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
  const force = url.searchParams.get('force') === '1'

  let monthStart: string
  let monthEnd: string

  if (startParam && endParam) {
    monthStart = startParam
    monthEnd = endParam
  } else {
    const yest = yesterdayET()
    const isMonthEnd = isLastFridayOfMonth(yest)

    if (!isMonthEnd && !force) {
      const durationMs = Date.now() - startedAt
      console.log(
        `[scrape/monthly] yesterday (${yest}) is not a month-end Friday — skipping. ${durationMs}ms`
      )
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `yesterday (${yest}) is not the final Friday of a calendar month`,
        yesterday: yest,
        durationMs,
      })
    }

    const m = lastCompletedFiscalMonth(yest)
    monthStart = m.start
    monthEnd = m.end
  }

  const results = {
    monthStart,
    monthEnd,
    salonsProcessed: 0,
    rowsUpserted: 0,
    updated: 0,
    inserted: 0,
    errors: [] as { salonNum: string; storeId: number; error: string }[],
  }

  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)

    console.log(
      `[scrape/monthly] ${monthStart}→${monthEnd} — pulling ${salons.length} salons`
    )

    const fetches = salons.map(async salon => {
      try {
        const [grouped, daily] = await Promise.all([
          fetchGroupedSummary(session, salon.storeId, monthStart, monthEnd),
          fetchDailyStoreSummary(session, salon.storeId, monthStart, monthEnd),
        ])
        if (!grouped) return null
        const agg = aggregatePeriod(grouped, daily, monthStart, monthEnd)
        return rowFromAggregate(agg)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.errors.push({
          salonNum: salon.salonNum,
          storeId: salon.storeId,
          error: msg,
        })
        console.error(`[scrape/monthly] failed for ${salon.salonNum}:`, msg)
        return null
      }
    })

    const rows = (await Promise.all(fetches)).filter(
      (r): r is Record<string, any> => r !== null
    )
    results.salonsProcessed = rows.length

    if (rows.length > 0) {
      const upsertResult = await upsertSheet(
        SD_MONTHLY_TAB,
        [...COLUMNS],
        ['monthEnd', 'storeId'],
        rows
      )
      results.rowsUpserted = rows.length
      results.updated = upsertResult.updated
      results.inserted = upsertResult.inserted
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[scrape/monthly] ✓ ${monthStart}→${monthEnd} — ${results.salonsProcessed} salons, ` +
        `${results.inserted} inserted, ${results.updated} updated, ` +
        `${results.errors.length} errors, ${durationMs}ms`
    )

    return NextResponse.json({
      ok: results.errors.length === 0,
      durationMs,
      ...results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scrape/monthly] fatal:', msg)
    return NextResponse.json(
      { ok: false, error: msg, ...results },
      { status: 500 }
    )
  }
}