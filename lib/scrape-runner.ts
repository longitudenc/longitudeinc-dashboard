// lib/scrape-runner.ts
//
// Shared scrape implementations. Used by:
//   - /api/scrape/daily,weekly,monthly,manual route handlers
//   - /api/cron/run dispatcher (in-process, no HTTP)
//
// Each function returns a plain JSON-serializable result object.

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
import { yesterdayET, lastCompletedFiscalWeek, lastCompletedFiscalMonth, todayET, isLastFridayOfMonth } from '@/lib/fiscal'

// ── Tab + column definitions ─────────────────────────────────

const SD_DAILY_TAB = 'SD_DAILY'
const SD_WEEKLY_TAB = 'SD_WEEKLY'
const SD_MONTHLY_TAB = 'SD_MONTHLY'

const DAILY_COLUMNS = [
  'date', 'storeId', 'customerCount', 'newCustomerCount', 'newCustomerVisitCount',
  'newCustomerReturnCount', 'repeatCustomerVisitCount', 'repeatCustomerReturnCount',
  'serviceSales', 'productSales', 'grossHaircutSales', 'floorHours',
  'approximatePayrollAmount', 'trainingPay', 'haircutCount', 'haircutOnlyInvoiceCount',
  'haircutOnlyServiceMinutes', 'waitOver15MinsCount', 'nonOciWaitOver15MinsCount',
  'nonOciCustomerCount', 'ociCompletedInvoiceCount', 'nonCutWithCustWaitingMinutes',
  'totalCustomerWaitMinutes', 'longestWaitMinutes', 'voidCount', 'redoAmount',
  'serviceDiscounts', 'productDiscounts', 'scrapedAt',
] as const

const PERIOD_COLUMNS = [
  'cc', 'newCust', 'newCustPct', 'serviceSales', 'productSales', 'totalSales',
  'floorHours', 'payrollAmount', 'trainingPay', 'cph', 'payrollPct',
  'payrollPctNoTraining', 'productPct', 'hcTime', 'mbc', 'avgWaitTime',
  'waits', 'nonOciWaits', 'ssWaits', 'nr', 'rr', 'scrapedAt',
] as const

const WEEKLY_COLUMNS = ['weekEnd', 'weekStart', 'storeId', ...PERIOD_COLUMNS] as const
const MONTHLY_COLUMNS = ['monthEnd', 'monthStart', 'storeId', ...PERIOD_COLUMNS] as const

// ── Row builders ─────────────────────────────────────────────

function dailyRow(s: SD3DailyStoreSummary): Record<string, any> {
  const row: Record<string, any> = {}
  for (const col of DAILY_COLUMNS) row[col] = (s as any)[col] ?? ''
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

// ── Public scrape functions ──────────────────────────────────

export type ScrapeResult = {
  ok: boolean
  durationMs: number
  date?: string
  weekStart?: string
  weekEnd?: string
  monthStart?: string
  monthEnd?: string
  salonsProcessed: number
  rowsUpserted: number
  updated: number
  inserted: number
  errors: { salonNum: string; storeId: number; error: string }[]
  skipped?: boolean
  reason?: string
}

export async function runDailyScrape(dateOverride?: string): Promise<ScrapeResult> {
  const startedAt = Date.now()
  const date = dateOverride || yesterdayET()
  const result: ScrapeResult = {
    ok: true, durationMs: 0, date, salonsProcessed: 0, rowsUpserted: 0,
    updated: 0, inserted: 0, errors: [],
  }

  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/daily] ${date} — pulling ${salons.length} salons`)

    const fetched = await batchMap(salons, 4, async salon => {
      try {
        return await fetchDailyStoreSummary(session, salon.storeId, date, date)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push({ salonNum: salon.salonNum, storeId: salon.storeId, error: msg })
        console.error(`[scrape/daily] failed for ${salon.salonNum}:`, msg)
        return []
      }
    })

    const allRows: Record<string, any>[] = []
    fetched.forEach((rows, i) => {
      if (rows.length === 0) return
      result.salonsProcessed++
      rows.forEach(r => allRows.push(dailyRow(r)))
    })

    if (allRows.length > 0) {
      const up = await upsertSheet(SD_DAILY_TAB, [...DAILY_COLUMNS], ['date', 'storeId'], allRows)
      result.rowsUpserted = allRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }

    result.ok = result.errors.length === 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scrape/daily] fatal:', msg)
    result.ok = false
    ;(result as any).error = msg
  }

  result.durationMs = Date.now() - startedAt
  return result
}

export async function runWeeklyScrape(
  weekStart?: string,
  weekEnd?: string
): Promise<ScrapeResult> {
  const startedAt = Date.now()
  let ws = weekStart
  let we = weekEnd
  if (!ws || !we) {
    const w = lastCompletedFiscalWeek(todayET())
    ws = w.start
    we = w.end
  }
  const result: ScrapeResult = {
    ok: true, durationMs: 0, weekStart: ws, weekEnd: we,
    salonsProcessed: 0, rowsUpserted: 0, updated: 0, inserted: 0, errors: [],
  }

  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/weekly] ${ws}→${we} — pulling ${salons.length} salons`)

    const fetched = await batchMap(salons, 4, async salon => {
      try {
        const [grouped, daily] = await Promise.all([
          fetchGroupedSummary(session, salon.storeId, ws!, we!),
          fetchDailyStoreSummary(session, salon.storeId, ws!, we!),
        ])
        if (!grouped) return null
        const agg = aggregatePeriod(grouped, daily, ws!, we!)
        return periodRow(agg, 'weekEnd', 'weekStart')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push({ salonNum: salon.salonNum, storeId: salon.storeId, error: msg })
        console.error(`[scrape/weekly] failed for ${salon.salonNum}:`, msg)
        return null
      }
    })

    const rows = fetched.filter((r): r is Record<string, any> => r !== null)
    result.salonsProcessed = rows.length

    if (rows.length > 0) {
      const up = await upsertSheet(SD_WEEKLY_TAB, [...WEEKLY_COLUMNS], ['weekEnd', 'storeId'], rows)
      result.rowsUpserted = rows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }

    result.ok = result.errors.length === 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scrape/weekly] fatal:', msg)
    result.ok = false
    ;(result as any).error = msg
  }

  result.durationMs = Date.now() - startedAt
  return result
}

export async function runMonthlyScrape(
  monthStart?: string,
  monthEnd?: string,
  force = false
): Promise<ScrapeResult> {
  const startedAt = Date.now()
  let ms = monthStart
  let me = monthEnd
  let skipped = false

  if (!ms || !me) {
    const yest = yesterdayET()
    if (!isLastFridayOfMonth(yest) && !force) {
      return {
        ok: true, durationMs: Date.now() - startedAt, salonsProcessed: 0,
        rowsUpserted: 0, updated: 0, inserted: 0, errors: [], skipped: true,
        reason: `yesterday (${yest}) is not the final Friday of a calendar month`,
      }
    }
    const m = lastCompletedFiscalMonth(yest)
    ms = m.start
    me = m.end
  }

  const result: ScrapeResult = {
    ok: true, durationMs: 0, monthStart: ms, monthEnd: me,
    salonsProcessed: 0, rowsUpserted: 0, updated: 0, inserted: 0, errors: [],
  }

  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/monthly] ${ms}→${me} — pulling ${salons.length} salons`)

    const fetched = await batchMap(salons, 4, async salon => {
      try {
        const [grouped, daily] = await Promise.all([
          fetchGroupedSummary(session, salon.storeId, ms!, me!),
          fetchDailyStoreSummary(session, salon.storeId, ms!, me!),
        ])
        if (!grouped) return null
        const agg = aggregatePeriod(grouped, daily, ms!, me!)
        return periodRow(agg, 'monthEnd', 'monthStart')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push({ salonNum: salon.salonNum, storeId: salon.storeId, error: msg })
        console.error(`[scrape/monthly] failed for ${salon.salonNum}:`, msg)
        return null
      }
    })

    const rows = fetched.filter((r): r is Record<string, any> => r !== null)
    result.salonsProcessed = rows.length

    if (rows.length > 0) {
      const up = await upsertSheet(SD_MONTHLY_TAB, [...MONTHLY_COLUMNS], ['monthEnd', 'storeId'], rows)
      result.rowsUpserted = rows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }

    result.ok = result.errors.length === 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scrape/monthly] fatal:', msg)
    result.ok = false
    ;(result as any).error = msg
  }

  result.durationMs = Date.now() - startedAt
  return result
}