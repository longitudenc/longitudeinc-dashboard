// app/api/scrape/weekly/route.ts
//
// Weekly SD3 scraper — pulls the most-recently-completed fiscal week (Sat→Fri)
// for every salon, aggregates via the SD3 grouped endpoint + Sat/Sun daily split,
// and upserts one row per salon into SD_WEEKLY.
//
// Schedule: Saturday 4:30 AM ET (after the week closes Friday night)
// Storage:  SD_WEEKLY tab, upserted by (weekEnd, storeId)
//
// Manual override:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   pulls that specific week
//   ?secret=...                         required (or Bearer header)

import { NextResponse } from 'next/server'
import {
  authenticate,
  fetchSalons,
  fetchGroupedSummary,
  fetchDailyStoreSummary,
  batchMap,
} from '@/lib/sd3'
import { upsertSheet } from '@/lib/sheets'
import { aggregatePeriod, type AggregatedPeriod } from '@/lib/aggregate'
import { lastCompletedFiscalWeek, todayET } from '@/lib/fiscal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SD_WEEKLY_TAB = 'SD_WEEKLY'

const COLUMNS = [
  'weekEnd',
  'weekStart',
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
  // raw rate bases for exact NR/RR/S-S-Wait/nonOci pooling — added 2026-06
  'nrReturnCount', 'nrVisitCount', 'rrReturnCount', 'rrVisitCount',
  'nonOciWaitCount', 'nonOciCustCount',
  'scrapedAt',
] as const

function rowFromAggregate(agg: AggregatedPeriod): Record<string, any> {
  return {
    weekEnd: agg.endDate,
    weekStart: agg.startDate,
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
    nrReturnCount: agg.nrReturnCount,
    nrVisitCount: agg.nrVisitCount,
    rrReturnCount: agg.rrReturnCount,
    rrVisitCount: agg.rrVisitCount,
    nonOciWaitCount: agg.nonOciWaitCount,
    nonOciCustCount: agg.nonOciCustCount,
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
      `[scrape/weekly] ${weekStart}→${weekEnd} — pulling ${salons.length} salons (batches of 4)`
    )

    // Process salons in batches of 4. Weekly is fast even without batching,
    // but using batchMap everywhere keeps behavior consistent and protects
    // against future SD3 slowdowns.
    const fetchedRows = await batchMap(salons, 4, async salon => {
      try {
        const [grouped, daily] = await Promise.all([
          fetchGroupedSummary(session, salon.storeId, weekStart, weekEnd),
          fetchDailyStoreSummary(session, salon.storeId, weekStart, weekEnd),
        ])
        if (!grouped) return null
        const agg = aggregatePeriod(grouped, daily, weekStart, weekEnd)
        return rowFromAggregate(agg)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.errors.push({
          salonNum: salon.salonNum,
          storeId: salon.storeId,
          error: msg,
        })
        console.error(`[scrape/weekly] failed for ${salon.salonNum}:`, msg)
        return null
      }
    })

    const rows = fetchedRows.filter(
      (r): r is Record<string, any> => r !== null
    )
    results.salonsProcessed = rows.length

    if (rows.length > 0) {
      const upsertResult = await upsertSheet(
        SD_WEEKLY_TAB,
        [...COLUMNS],
        ['weekEnd', 'storeId'],
        rows
      )
      results.rowsUpserted = rows.length
      results.updated = upsertResult.updated
      results.inserted = upsertResult.inserted
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[scrape/weekly] ✓ ${weekStart}→${weekEnd} — ${results.salonsProcessed} salons, ` +
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
    console.error('[scrape/weekly] fatal:', msg)
    return NextResponse.json(
      { ok: false, error: msg, ...results },
      { status: 500 }
    )
  }
}