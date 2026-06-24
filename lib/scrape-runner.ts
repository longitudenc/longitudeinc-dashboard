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
  fetchEmployeePerformanceCsv,
  fetchPayrollCsv,
  fetchEmployeeReporting,
  fetchShifts,
  fetchHalfHourOptimal,
  fetchInvoices,
  fetchEmpChkInOut,
  batchMap,
  type SD3DailyStoreSummary,
  type SD3ShiftVariance,
  type SD3HalfHourOptimal,
  type SD3InvoiceLite,
  type SD3ChkInOut,
} from '@/lib/sd3'
import { upsertSheet, readSheet, rowsToObjects } from '@/lib/sheets'
import { parseCsv, rowsToObjectsAt, num, returnRate } from '@/lib/csv'
import { aggregatePeriod, type AggregatedPeriod } from '@/lib/aggregate'
import { yesterdayET, lastCompletedFiscalWeek, lastCompletedFiscalMonth, todayET, isLastFridayOfMonth, addDays, dayOfWeek } from '@/lib/fiscal'

// ── Tab + column definitions ─────────────────────────────────

const SD_DAILY_TAB = 'SD_DAILY'
const SD_WEEKLY_TAB = 'SD_WEEKLY'
const SD_MONTHLY_TAB = 'SD_MONTHLY'
const SD_SHIFTS_TAB = 'SD_SHIFTS'
const SD_HALFHOUR_TAB = 'SD_HALFHOUR'
const SD_DEMAND_TAB = 'SD_DEMAND'
const SD_CHKINOUT_TAB = 'SD_CHKINOUT'

// Actual clock punches (one row per employee per segment). Complete coverage
// source: role flags let us count only floor-cutting time, breakTime nets the
// rest. checkInTime/checkOutTime define the on-floor window per segment.
const CHKINOUT_COLUMNS = [
  'date', 'storeId', 'salonNum', 'chkPk', 'employeePk', 'employeeId',
  'fname', 'lname', 'checkInTime', 'checkOutTime', 'hours', 'breakTime',
  'asStylist', 'asRecept', 'asTraining', 'asAdmin', 'absent',
  'custsWaiting', 'estWait', 'scrapedAt',
] as const

// Real per-half-hour demand, aggregated from invoices (PII dropped at the SD3
// boundary). arrivals = customers who joined the list in that slot (true,
// uncensored demand, incl. those who later walked out). No customer data here.
const DEMAND_COLUMNS = [
  'date', 'storeId', 'salonNum', 'halfHour',
  'arrivals', 'served', 'walkedOut', 'waitedOver15',
  'avgLine', 'avgBusy',
  'avgWaitMin', 'avgEstWaitMin', 'scrapedAt',
] as const

// Half-hour optimal vs actual staffing, per store/day/half-hour. No pay/PII.
// halfHour = slot index from midnight (×30 min). gap = worked − needed.
const HALFHOUR_COLUMNS = [
  'date', 'storeId', 'salonNum', 'halfHour',
  'customerCount', 'needed', 'worked', 'demandStylists', 'recCpfh',
  'threeFlag', 'weeklyPeak', 'scrapedAt',
] as const

// Schedule-variance rows: scheduled vs actual shift, per employee/day/shift.
// No pay in this data — scoping it later is a simple salon filter.
const SHIFTS_COLUMNS = [
  'date', 'storeId', 'salonNum', 'employeePk', 'firstName', 'lastName',
  'isSchedule', 'isNonFloor', 'varianceMask', 'notes',
  'schedStart', 'schedEnd', 'actualStart', 'actualEnd',
  'checkInDiff', 'checkOutDiff',
  'checkInWaiting', 'checkInOciWaiting', 'checkOutWaiting', 'checkOutOciWaiting',
  'estWaitAtTimeout', 'firstCustServed', 'lastCustOut', 'shiftLabelsMask',
  'scrapedAt',
] as const

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
  'floorHours', 'payrollAmount', 'trainingPay', 'receptionistPay', 'cph', 'payrollPct',
  'payrollPctNoTraining', 'productPct', 'hcTime', 'mbc', 'avgWaitTime',
  'waits', 'nonOciWaits', 'ssWaits', 'nr', 'rr',
  // raw bonus-formula inputs (period totals) — added 2026-06
  'serviceDiscounts', 'productDiscounts', 'redoAmount',
  'grossHaircutSales', 'haircutCount', 'waitOver15Count',
  'ssCustCount', 'ssWaitCount',
  // raw rate bases for exact NR/RR/S-S-Wait/nonOci pooling — added 2026-06
  'nrReturnCount', 'nrVisitCount', 'rrReturnCount', 'rrVisitCount',
  'nonOciWaitCount', 'nonOciCustCount',
  'scrapedAt',
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
    receptionistPay: agg.receptionistPay,
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
    // raw bonus-formula inputs (period totals) — added 2026-06
    serviceDiscounts: agg.serviceDiscounts,
    productDiscounts: agg.productDiscounts,
    redoAmount: agg.redoAmount,
    grossHaircutSales: agg.grossHaircutSales,
    haircutCount: agg.haircutCount,
    waitOver15Count: agg.waitOver15Count,
    ssCustCount: agg.ssCustCount,
    ssWaitCount: agg.ssWaitCount,
    nrReturnCount: agg.nrReturnCount,
    nrVisitCount: agg.nrVisitCount,
    rrReturnCount: agg.rrReturnCount,
    rrVisitCount: agg.rrVisitCount,
    nonOciWaitCount: agg.nonOciWaitCount,
    nonOciCustCount: agg.nonOciCustCount,
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


// ═════════════════════════════════════════════════════════════════════
// Roster / Employee / Payroll scrapes — weekly cadence.
// Logic mirrors the standalone routes (app/api/scrape/{roster,employee,
// payroll}); these runner versions exist so the cron dispatcher can call
// them in-process. Keep the two in sync if either changes.
// ═════════════════════════════════════════════════════════════════════

const SALON_ROSTER_TAB = 'SalonRoster'
const SD_EMP_WEEKLY_TAB = 'SD_EMP_WEEKLY'
const SD_PAYROLL_TAB = 'SD_PAYROLL'

export type EntityScrapeResult = {
  ok: boolean
  durationMs: number
  weekStart?: string
  weekEnd?: string
  rowsUpserted: number
  updated: number
  inserted: number
  skipped?: number
  processed?: number
  error?: string | null
  // roster-specific
  listxCount?: number
  newlyAdded?: number
  refreshed?: number
  preserved?: number
}

// ── Roster ───────────────────────────────────────────────────────────

const ROSTER_COLUMNS = [
  'salonNum', 'storeId', 'name', 'city', 'state', 'market', 'district',
  'entity', 'openedOn', 'am', 'status', 'closedDate', 'soldDate', 'notes',
  'lastSyncedAt',
] as const

const ROSTER_SD3_FIELDS = new Set([
  'salonNum', 'name', 'city', 'state', 'market', 'district', 'entity', 'openedOn',
])

const DEFAULT_AM_BY_SALON: Record<string, string> = {
  '1304': 'luann', '3015': 'cassi', '3025': 'dana', '3027': 'dana',
  '3043': 'luann', '3053': 'bridgette', '3058': 'cassi', '3062': 'dawn',
  '3071': 'dawn', '3545': 'luann', '3685': 'bridgette', '4138': 'cassi',
  '7728': 'dana', '8725': 'luann', '9489': 'dawn', '9689': 'bridgette',
}

export async function runRosterScrape(): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, rowsUpserted: 0, updated: 0, inserted: 0,
    listxCount: 0, newlyAdded: 0, refreshed: 0, preserved: 0, error: null,
  }
  try {
    const existingRaw = await readSheet(SALON_ROSTER_TAB)
    const existingObjects = rowsToObjects(existingRaw)
    const existingByStoreId = new Map<string, Record<string, any>>()
    for (const row of existingObjects) {
      const sid = String(row.storeId || '').trim()
      if (sid) existingByStoreId.set(sid, row)
    }

    const session = await authenticate()
    const salons = await fetchSalons(session)
    result.listxCount = salons.length
    console.log(`[scrape/roster] listx ${salons.length} salons; ${existingByStoreId.size} existing rows`)

    const now = new Date().toISOString()
    const seen = new Set<string>()
    const outRows: Record<string, any>[] = []

    for (const s of salons) {
      const sid = String(s.storeId)
      seen.add(sid)
      const existing = existingByStoreId.get(sid)
      const sd3Row = {
        salonNum: s.salonNum, storeId: s.storeId, name: s.name, city: s.city,
        state: s.state, market: s.market, district: s.district, entity: s.entity,
        openedOn: s.openedOn ?? '',
      }
      if (existing) {
        const merged: Record<string, any> = { ...existing }
        for (const fld of ROSTER_SD3_FIELDS) merged[fld] = (sd3Row as Record<string, any>)[fld]
        merged.storeId = s.storeId
        merged.lastSyncedAt = now
        outRows.push(merged)
        result.refreshed!++
      } else {
        outRows.push({
          ...sd3Row, am: DEFAULT_AM_BY_SALON[s.salonNum] ?? '', status: 'active',
          closedDate: '', soldDate: '', notes: '', lastSyncedAt: now,
        })
        result.newlyAdded!++
      }
    }
    for (const [sid, existing] of existingByStoreId) {
      if (seen.has(sid)) continue
      outRows.push(existing)
      result.preserved!++
    }

    if (outRows.length > 0) {
      const up = await upsertSheet(SALON_ROSTER_TAB, [...ROSTER_COLUMNS], ['storeId'], outRows)
      result.rowsUpserted = outRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/roster] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// ── Employee performance (weekly CSV) ────────────────────────────────

const EMP_HEADER_ROW_INDEX = 4
const EMP_COLUMNS = [
  'weekEnd', 'salonNum', 'storeId', 'globalId', 'payId', 'employeeName',
  'position', 'floorHours', 'custCount', 'hcTime', 'cph', 'productPct', 'mbc',
  'nonCutMph', 'productivity', 'payrollPct', 'nr', 'rr', 'scrapedAt',
] as const

function empRowFromCsv(o: Record<string, string>, weekEnd: string, storeIdMap: Record<string, number>): Record<string, any> | null {
  const salonNum = (o['Salon #'] || '').trim()
  const position = (o['Position'] || '').trim()
  const storeId = storeIdMap[salonNum]
  if (!storeId) return null
  if (!position) return null
  return {
    weekEnd, salonNum, storeId,
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

export async function runEmployeeScrape(weekStart?: string, weekEnd?: string): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  let ws = weekStart, we = weekEnd
  if (!ws || !we) { const w = lastCompletedFiscalWeek(todayET()); ws = w.start; we = w.end }
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: ws, weekEnd: we,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    const storeIdMap: Record<string, number> = {}
    for (const s of salons) storeIdMap[s.salonNum] = s.storeId
    const storeIds = salons.map(s => s.storeId)
    console.log(`[scrape/employee] ${ws}→${we} — single CSV pull, ${storeIds.length} salons`)

    const csvText = await fetchEmployeePerformanceCsv(session, storeIds, ws!, we!)
    const objects = rowsToObjectsAt(parseCsv(csvText), EMP_HEADER_ROW_INDEX)
    const dataRows: Record<string, any>[] = []
    for (const o of objects) {
      const row = empRowFromCsv(o, we!, storeIdMap)
      if (row) dataRows.push(row); else result.skipped!++
    }
    result.processed = dataRows.length
    if (dataRows.length > 0) {
      const up = await upsertSheet(SD_EMP_WEEKLY_TAB, [...EMP_COLUMNS], ['weekEnd', 'storeId', 'payId'], dataRows)
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/employee] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// ── Employee performance (DAILY CSV) ─────────────────────────────────
//
// Same SD3 endpoint as the weekly employee scrape, but called with
// start=end=a single calendar day, so it returns each stylist's numbers for
// that one day. Stored in SD_EMP_DAILY, upserted by (date, storeId, payId).
//
// Deliberately OMITS nr/rr: SD3's New/Repeat Return % are 105-day rolling
// figures and are meaningless for a single day, so they are not stored here.
//
// NOTE: assumes the single-day CSV has the same 4-line header preamble as the
// weekly pull (EMP_HEADER_ROW_INDEX = 4). Verify on the first real pull.

const SD_EMP_DAILY_TAB = 'SD_EMP_DAILY'
const EMP_DAILY_COLUMNS = [
  'date', 'salonNum', 'storeId', 'globalId', 'payId', 'employeeName',
  'position', 'floorHours', 'custCount', 'hcTime', 'cph', 'productPct', 'mbc',
  'nonCutMph', 'productivity', 'payrollPct', 'scrapedAt',
] as const

function empDailyRowFromCsv(o: Record<string, string>, date: string, storeIdMap: Record<string, number>): Record<string, any> | null {
  const salonNum = (o['Salon #'] || '').trim()
  const position = (o['Position'] || '').trim()
  const storeId = storeIdMap[salonNum]
  if (!storeId) return null
  if (!position) return null
  return {
    date, salonNum, storeId,
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
    scrapedAt: new Date().toISOString(),
  }
}

export async function runEmployeeDailyScrape(dateOverride?: string): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  const date = dateOverride || yesterdayET()
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: date, weekEnd: date,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    const storeIdMap: Record<string, number> = {}
    for (const s of salons) storeIdMap[s.salonNum] = s.storeId
    const storeIds = salons.map(s => s.storeId)
    console.log(`[scrape/employee-daily] ${date} — single CSV pull, ${storeIds.length} salons`)

    const csvText = await fetchEmployeePerformanceCsv(session, storeIds, date, date)
    const objects = rowsToObjectsAt(parseCsv(csvText), EMP_HEADER_ROW_INDEX)
    const dataRows: Record<string, any>[] = []
    for (const o of objects) {
      const row = empDailyRowFromCsv(o, date, storeIdMap)
      if (row) dataRows.push(row); else result.skipped!++
    }
    result.processed = dataRows.length
    if (dataRows.length > 0) {
      const up = await upsertSheet(SD_EMP_DAILY_TAB, [...EMP_DAILY_COLUMNS], ['date', 'storeId', 'payId'], dataRows)
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/employee-daily] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// Range backfill — authenticate + fetch the salon list ONCE, then pull every
// day in [start, end] reusing that one session, buffering rows and flushing to
// the sheet in batches. Far faster than looping the single-day runner (which
// re-authenticates every day). Idempotent: re-running an overlapping range just
// updates those rows in place (key = date+storeId+payId), so it's safe to
// resume a partial run by re-issuing the remaining range.
export async function runEmployeeDailyRange(start: string, end: string): Promise<EntityScrapeResult & { days?: number }> {
  const startedAt = Date.now()
  const result: EntityScrapeResult & { days?: number } = {
    ok: true, durationMs: 0, weekStart: start, weekEnd: end,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null, days: 0,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    const storeIdMap: Record<string, number> = {}
    for (const s of salons) storeIdMap[s.salonNum] = s.storeId
    const storeIds = salons.map(s => s.storeId)

    const FLUSH_AT = 2000
    let buffer: Record<string, any>[] = []
    const flush = async () => {
      if (buffer.length === 0) return
      const up = await upsertSheet(SD_EMP_DAILY_TAB, [...EMP_DAILY_COLUMNS], ['date', 'storeId', 'payId'], buffer)
      result.rowsUpserted += buffer.length
      result.updated! += up.updated
      result.inserted! += up.inserted
      buffer = []
    }

    let cur = start
    for (let i = 0; i < 400 && cur <= end; i++) {
      const csvText = await fetchEmployeePerformanceCsv(session, storeIds, cur, cur)
      const objects = rowsToObjectsAt(parseCsv(csvText), EMP_HEADER_ROW_INDEX)
      for (const o of objects) {
        const row = empDailyRowFromCsv(o, cur, storeIdMap)
        if (row) { buffer.push(row); result.processed!++ } else { result.skipped!++ }
      }
      result.days!++
      if (buffer.length >= FLUSH_AT) await flush()
      cur = addDays(cur, 1)
    }
    await flush()
    console.log(`[scrape/employee-daily] range ${start}→${end}: ${result.days} days, ${result.processed} rows, ${result.inserted} inserted, ${result.updated} updated`)
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/employee-daily] range fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// ── Shifts (schedule variance: scheduled vs actual) ──────────────────

/** null/undefined → '' ; everything else → String(v). Times kept as raw ISO. */
function sStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

/** Map one /rest/schedule/variance record to an SD_SHIFTS row. */
function shiftRow(r: Record<string, any>, storeId: number, salonNum: string): Record<string, any> | null {
  const date = sStr(r.date)
  if (!date) return null
  return {
    date,
    storeId,
    salonNum,
    employeePk: sStr(r.employeepk),
    firstName: sStr(r.firstname),
    lastName: sStr(r.lastname),
    isSchedule: sStr(r.isschedule),
    isNonFloor: sStr(r.isnonfloorshifts),
    varianceMask: sStr(r.variancetypemask),
    notes: sStr(r.notes),
    schedStart: sStr(r.starttimes),
    schedEnd: sStr(r.endtimes),
    actualStart: sStr(r.starttime ?? r.checkintime),
    actualEnd: sStr(r.endtime ?? r.checkouttime),
    checkInDiff: sStr(r.checkinminutesdifference),
    checkOutDiff: sStr(r.checkoutminutesdifference),
    checkInWaiting: sStr(r.checkincustomerswaiting),
    checkInOciWaiting: sStr(r.checkinocicustomerswaiting),
    checkOutWaiting: sStr(r.checkoutcustomerswaiting),
    checkOutOciWaiting: sStr(r.checkoutocicustomerswaiting),
    estWaitAtTimeout: sStr(r.estwaitattimeout),
    firstCustServed: sStr(r.firstcusttimeserved),
    lastCustOut: sStr(r.lastcusttimeout),
    shiftLabelsMask: sStr(r.shiftlabelsmasks),
    scrapedAt: new Date().toISOString(),
  }
}

/** The Saturday that begins the fiscal week containing `dateIso` (weeks run Sat→Fri). */
function fiscalWeekStart(dateIso: string): string {
  // dayOfWeek: Sun=0 … Sat=6. Days back to the week's Saturday:
  return addDays(dateIso, -((dayOfWeek(dateIso) + 1) % 7))
}

/**
 * Scrape schedule-variance rows into SD_SHIFTS.
 *  - no args      → current fiscal week-to-date (its Saturday → yesterday ET).
 *  - start & end  → that explicit range (backfill); one call per store.
 * The endpoint accepts a date range directly, so each store is a single fetch.
 * Upsert key (date, storeId, employeePk, schedStart) lets the week fill in
 * progressively and re-pulls just update in place.
 */
export async function runShiftsScrape(
  startOverride?: string,
  endOverride?: string
): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  const end = endOverride || yesterdayET()
  const start = startOverride || fiscalWeekStart(end)
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: start, weekEnd: end,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/shifts] ${start}→${end} — ${salons.length} salons`)

    const dataRows: Record<string, any>[] = []
    for (const s of salons) {
      let recs: SD3ShiftVariance[]
      try {
        recs = await fetchShifts(session, s.storeId, start, end)
      } catch (e) {
        // One bad store shouldn't sink the whole run.
        console.error(`[scrape/shifts] store ${s.salonNum} (${s.storeId}) failed:`, e instanceof Error ? e.message : e)
        continue
      }
      for (const r of recs) {
        const row = shiftRow(r as Record<string, any>, s.storeId, s.salonNum)
        if (row) dataRows.push(row)
        else result.skipped!++
      }
    }

    result.processed = dataRows.length
    if (dataRows.length > 0) {
      const up = await upsertSheet(
        SD_SHIFTS_TAB,
        [...SHIFTS_COLUMNS],
        ['date', 'storeId', 'employeePk', 'schedStart'],
        dataRows
      )
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/shifts] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// ── Half-hour optimal vs actual staffing (heat map source) ───────────

/** Map one dailyhalfhouroptimal record to an SD_HALFHOUR row. */
function halfHourRow(r: Record<string, any>, storeId: number, salonNum: string): Record<string, any> | null {
  const date = sStr(r.date)
  const hh = Number(r.halfHour)
  if (!date || !Number.isFinite(hh) || hh < 0) return null
  return {
    date,
    storeId,
    salonNum,
    halfHour: hh,
    customerCount: sStr(r.customerCount),
    needed: sStr(r.peakStylistNeeded),
    worked: sStr(r.peakStylistWorked),
    demandStylists: sStr(r.stylists),
    recCpfh: sStr(r.salonRecCpfh),
    threeFlag: sStr(r.threeStylistsNeededFlag),
    weeklyPeak: sStr(r.weeklyPeak),
    scrapedAt: new Date().toISOString(),
  }
}

/**
 * Scrape half-hour optimal-vs-actual staffing into SD_HALFHOUR.
 *  - no args     → current fiscal week-to-date (its Saturday → yesterday ET).
 *  - start & end → that explicit range; one call per store.
 * NOT wired into the nightly cron yet — half-hour grain is the volume we're
 * moving to Supabase, so this is manual-pull only for prototyping until then.
 * Upsert key (date, storeId, halfHour).
 */
export async function runHalfHourScrape(
  startOverride?: string,
  endOverride?: string
): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  const end = endOverride || yesterdayET()
  const start = startOverride || fiscalWeekStart(end)
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: start, weekEnd: end,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/halfhour] ${start}→${end} — ${salons.length} salons`)

    const dataRows: Record<string, any>[] = []
    let firstErr = ''
    let storesFailed = 0
    for (const s of salons) {
      let recs: SD3HalfHourOptimal[]
      try {
        recs = await fetchHalfHourOptimal(session, s.storeId, start, end)
      } catch (e) {
        storesFailed++
        const msg = e instanceof Error ? e.message : String(e)
        if (!firstErr) firstErr = msg
        console.error(`[scrape/halfhour] store ${s.salonNum} (${s.storeId}) failed:`, msg)
        continue
      }
      for (const r of recs) {
        const row = halfHourRow(r as Record<string, any>, s.storeId, s.salonNum)
        if (row) dataRows.push(row)
        else result.skipped!++
      }
    }

    result.processed = dataRows.length
    // If nothing came back, say why instead of a silent ok:true / processed:0.
    if (dataRows.length === 0) {
      result.error = firstErr
        ? `0 rows — ${storesFailed}/${salons.length} stores errored, first: ${firstErr}`
        : '0 rows — every store returned an empty response (check the endpoint URL/params)'
    }
    if (dataRows.length > 0) {
      const up = await upsertSheet(
        SD_HALFHOUR_TAB,
        [...HALFHOUR_COLUMNS],
        ['date', 'storeId', 'halfHour'],
        dataRows
      )
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/halfhour] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// ── Real demand (invoices → per-half-hour arrivals/waits, PII-free) ──────

function hhFromTime(iso: string | null): number | null {
  if (!iso) return null
  const m = iso.match(/T(\d{2}):(\d{2})/)
  if (!m) return null
  return parseInt(m[1], 10) * 2 + (parseInt(m[2], 10) >= 30 ? 1 : 0)
}
// Wall-clock minute-of-day from a naive local ISO ("2026-05-23T08:58:31.217").
// We parse the clock directly (NOT Date.parse) so no timezone shift is applied.
function minOfDay(iso: string | null): number | null {
  if (!iso) return null
  const m = iso.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3], 10) / 60 : 0)
}
function waitMinutes(timeIn: string, timeServed: string): number | null {
  const a = Date.parse(timeIn), b = Date.parse(timeServed)
  if (isNaN(a) || isNaN(b)) return null
  return (b - a) / 60000
}

interface DemandBucket {
  arrivals: number; served: number; walkedOut: number; waitedOver15: number
  sumWait: number; nWait: number; sumEst: number; nEst: number
  // Time-weighted accumulators (customer-minutes within each half-hour):
  waitMin: number   // minutes customers spent waiting in-store (timeIn→timeServed)
  busyMin: number   // minutes chairs were occupied (timeServed→timeOut)
}

/**
 * Scrape real demand into SD_DEMAND by aggregating invoices to per-half-hour
 * counts. Customers are bucketed by their arrival (timeIn) slot, so this is
 * true demand — everyone who joined the list, including those who walked out.
 * Only the rollup is written; no customer/PII data is ever stored.
 *  - no args     → current fiscal week-to-date.
 *  - start & end → explicit range (backfill); one call per store.
 * Upsert key (date, storeId, halfHour).
 */
export async function runDemandScrape(
  startOverride?: string,
  endOverride?: string
): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  const end = endOverride || yesterdayET()
  const start = startOverride || fiscalWeekStart(end)
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: start, weekEnd: end,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/demand] ${start}→${end} — ${salons.length} salons`)

    const dataRows: Record<string, any>[] = []
    let firstErr = ''
    let storesFailed = 0

    for (const s of salons) {
      let invoices: SD3InvoiceLite[]
      try {
        invoices = await fetchInvoices(session, s.storeId, start, end)
      } catch (e) {
        storesFailed++
        const msg = e instanceof Error ? e.message : String(e)
        if (!firstErr) firstErr = msg
        console.error(`[scrape/demand] store ${s.salonNum} (${s.storeId}) failed:`, msg)
        continue
      }

      // Aggregate this store's invoices into per (date, halfHour) buckets.
      // arrivals/served/walkedOut/waits are counted at the ARRIVAL slot.
      // avgLine and avgBusy are TIME-WEIGHTED: each served customer's in-store
      // wait interval [timeIn, timeServed] and chair interval [timeServed,
      // timeOut] are spread across every half-hour they overlap, so a 30-second
      // wait barely registers while a 25-minute wait shows as a real body across
      // several slots. timeIn is the PHYSICAL arrival, so OCI at-home minutes are
      // never in the line.
      const buckets = new Map<string, DemandBucket>()
      const getBucket = (date: string, hh: number): DemandBucket => {
        const key = date + '|' + hh
        let b = buckets.get(key)
        if (!b) {
          b = { arrivals: 0, served: 0, walkedOut: 0, waitedOver15: 0, sumWait: 0, nWait: 0, sumEst: 0, nEst: 0, waitMin: 0, busyMin: 0 }
          buckets.set(key, b)
        }
        return b
      }
      // Spread the minutes of interval [aMin,bMin] (same day) into each slot it
      // overlaps, accumulating into the named time-weighted field.
      const addInterval = (date: string, aMin: number | null, bMin: number | null, field: 'waitMin' | 'busyMin') => {
        if (aMin === null || bMin === null) return
        const a = Math.max(0, aMin), b = Math.min(1440, bMin)
        if (b <= a) return
        const first = Math.floor(a / 30)
        const last = Math.floor((b - 1e-9) / 30)
        for (let h = first; h <= last; h++) {
          const ov = Math.min(b, h * 30 + 30) - Math.max(a, h * 30)
          if (ov > 0) getBucket(date, h)[field] += ov
        }
      }

      for (const inv of invoices) {
        if (!inv.invoiceDate) continue
        const hh = hhFromTime(inv.timeIn)
        if (hh === null) continue // no in-store arrival = not a floor demand event
        const b = getBucket(inv.invoiceDate, hh)
        b.arrivals++
        if (inv.timeServed) {
          b.served++
          const w = inv.timeIn ? waitMinutes(inv.timeIn, inv.timeServed) : null
          if (w !== null) { b.sumWait += w; b.nWait++; if (w > 15) b.waitedOver15++ }
        } else {
          b.walkedOut++ // arrived, joined the list, never served
        }
        if (inv.estWait !== null && inv.estWait >= 0) { b.sumEst += inv.estWait; b.nEst++ }

        // Time-weighted line (waiting) and chair-occupancy (busy).
        const tIn = minOfDay(inv.timeIn)
        const tServed = minOfDay(inv.timeServed)
        const tOut = minOfDay(inv.timeOut)
        if (tIn !== null && tServed !== null) addInterval(inv.invoiceDate, tIn, tServed, 'waitMin')
        if (tServed !== null && tOut !== null) addInterval(inv.invoiceDate, tServed, tOut, 'busyMin')
      }

      for (const [key, b] of buckets) {
        const [date, hhStr] = key.split('|')
        dataRows.push({
          date, storeId: s.storeId, salonNum: s.salonNum, halfHour: Number(hhStr),
          arrivals: b.arrivals, served: b.served, walkedOut: b.walkedOut, waitedOver15: b.waitedOver15,
          avgLine: (b.waitMin / 30).toFixed(2),
          avgBusy: (b.busyMin / 30).toFixed(2),
          avgWaitMin: b.nWait ? (b.sumWait / b.nWait).toFixed(1) : '',
          avgEstWaitMin: b.nEst ? (b.sumEst / b.nEst).toFixed(1) : '',
          scrapedAt: new Date().toISOString(),
        })
      }
    }

    result.processed = dataRows.length
    if (dataRows.length === 0) {
      result.error = firstErr
        ? `0 rows — ${storesFailed}/${salons.length} stores errored, first: ${firstErr}`
        : '0 rows — no invoices with arrival times in range (check endpoint/params)'
    }
    if (dataRows.length > 0) {
      const up = await upsertSheet(
        SD_DEMAND_TAB,
        [...DEMAND_COLUMNS],
        ['date', 'storeId', 'halfHour'],
        dataRows
      )
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/demand] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// ── Employee clock punches (actual floor coverage, break-aware) ─────

/**
 * Scrape actual clock punches into SD_CHKINOUT — one row per employee per
 * segment, for ALL employees (no employee= filter). Raw segments are stored
 * as-is; the dashboard derives per-half-hour floor coverage (asStylist segments
 * overlapping each slot) and break-netted daily capacity from them.
 *  - no args     → current fiscal week-to-date.
 *  - start & end → explicit range (backfill).
 * Upsert key (date, storeId, chkPk).
 */
export async function runChkInOutScrape(
  startOverride?: string,
  endOverride?: string
): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  const end = endOverride || yesterdayET()
  const start = startOverride || fiscalWeekStart(end)
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: start, weekEnd: end,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/chkinout] ${start}→${end} — ${salons.length} salons`)

    const dataRows: Record<string, any>[] = []
    let firstErr = ''
    let storesFailed = 0

    for (const s of salons) {
      let segs: SD3ChkInOut[]
      try {
        segs = await fetchEmpChkInOut(session, s.storeId, start, end)
      } catch (e) {
        storesFailed++
        const msg = e instanceof Error ? e.message : String(e)
        if (!firstErr) firstErr = msg
        console.error(`[scrape/chkinout] store ${s.salonNum} (${s.storeId}) failed:`, msg)
        continue
      }
      for (const seg of segs) {
        if (!seg.date || seg.chkPk == null) continue
        dataRows.push({
          date: seg.date, storeId: s.storeId, salonNum: s.salonNum,
          chkPk: seg.chkPk, employeePk: seg.employeePk ?? '', employeeId: seg.employeeId ?? '',
          fname: seg.fname, lname: seg.lname,
          checkInTime: seg.checkInTime ?? '', checkOutTime: seg.checkOutTime ?? '',
          hours: seg.hours ?? '', breakTime: seg.breakTime ?? '',
          asStylist: seg.asStylist, asRecept: seg.asRecept, asTraining: seg.asTraining,
          asAdmin: seg.asAdmin, absent: seg.absent,
          custsWaiting: seg.custsWaitingAtTimeOut ?? '', estWait: seg.estWaitAtTimeOut ?? '',
          scrapedAt: new Date().toISOString(),
        })
      }
    }

    result.processed = dataRows.length
    if (dataRows.length === 0) {
      result.error = firstErr
        ? `0 rows — ${storesFailed}/${salons.length} stores errored, first: ${firstErr}`
        : '0 rows — no punches in range (check endpoint/params)'
    }
    if (dataRows.length > 0) {
      const up = await upsertSheet(
        SD_CHKINOUT_TAB,
        [...CHKINOUT_COLUMNS],
        ['date', 'storeId', 'chkPk'],
        dataRows
      )
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/chkinout] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}

// ── Payroll (weekly CSV) ─────────────────────────────────────────────

const PAYROLL_HEADER_ROW_INDEX = 0
const PAYROLL_COLUMNS = [
  'weekEnd', 'salonNum', 'storeId', 'globalId', 'payId', 'employeeName',
  'baseWage', 'floorHours', 'closingHours', 'trainingHours', 'adminHours',
  'receptionHours', 'totalHoursWorked', 'vacationHours', 'holidayHours',
  'sickHours', 'totalHours', 'overtimeHours', 'subTotalPay',
  'productivityIncentive', 'productIncentive', 'newReturnIncentive',
  'totalTips', 'effectiveWageNoOt', 'effectiveWageOt', 'scrapedAt',
] as const

function payrollRowFromCsv(o: Record<string, string>, weekEnd: string, storeIdMap: Record<string, number>): Record<string, any> | null {
  const salonNum = (o['Salon #'] || '').trim()
  const storeId = storeIdMap[salonNum]
  if (!storeId) return null
  return {
    weekEnd, salonNum, storeId,
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

export async function runPayrollScrape(weekStart?: string, weekEnd?: string): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  let ws = weekStart, we = weekEnd
  if (!ws || !we) { const w = lastCompletedFiscalWeek(todayET()); ws = w.start; we = w.end }
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: ws, weekEnd: we,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    const storeIdMap: Record<string, number> = {}
    for (const s of salons) storeIdMap[s.salonNum] = s.storeId
    const storeIds = salons.map(s => s.storeId)
    console.log(`[scrape/payroll] ${ws}→${we} — single CSV pull, ${storeIds.length} salons`)

    const csvText = await fetchPayrollCsv(session, storeIds, ws!, we!)
    const objects = rowsToObjectsAt(parseCsv(csvText), PAYROLL_HEADER_ROW_INDEX)
    const dataRows: Record<string, any>[] = []
    for (const o of objects) {
      const row = payrollRowFromCsv(o, we!, storeIdMap)
      if (row) dataRows.push(row); else result.skipped!++
    }
    result.processed = dataRows.length
    if (dataRows.length > 0) {
      const up = await upsertSheet(SD_PAYROLL_TAB, [...PAYROLL_COLUMNS], ['weekEnd', 'storeId', 'payId'], dataRows)
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/payroll] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}


// ═════════════════════════════════════════════════════════════════════
// Profile scrape — monthly cadence. ADP replacement: hire/rehire dates +
// home store, from the JSON `reporting` endpoint.
//
// PII SAFETY: the reporting payload carries names, addresses, and photo
// thumbnails. profileRow() reads ONLY the six allow-listed properties below
// and never spreads/copies the source object, so PII can't leak into the
// sheet. Nothing here logs the raw payload. Join key = globalId
// (globalEmployeeKey), which matches SD_EMP_WEEKLY / SD_PAYROLL.
// ═════════════════════════════════════════════════════════════════════

const EMP_PROFILE_TAB = 'EmployeeProfile'

const PROFILE_COLUMNS = [
  'globalId',       // join key — from globalEmployeeKey (e.g. "2023-0000-7354")
  'email',          // emailAddress, lowercased — AUTH USE ONLY (see PII note below)
  'inactive',       // 'true'/'false' — SD3 inactive flag (termed/left). Excludes
                    // from ADP export + marks in bonus views; access auto-revokes.
  'inactiveDate',   // YYYY-MM-DD or '' — when they went inactive
  'dateOfHire',     // YYYY-MM-DD
  'rehireDate',     // YYYY-MM-DD or ''
  'homeStoreNum',   // public salon number, from primaryStoreDict.n (e.g. "2554")
  'homeStoreName',  // from primaryStoreDict.a (e.g. "Carmel Commons")
  'homeStoreId',    // SD3 store id, from primaryStoreDict.pk
  'scrapedAt',
] as const

// Defensive: the reporting endpoint may return a bare array or an object
// wrapping the array under some key. Find the employee array either way.
function extractEmployees(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    for (const key of ['employees', 'data', 'results', 'rows', 'content', 'list']) {
      if (Array.isArray(obj[key])) return obj[key] as any[]
    }
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v as any[]
  }
  return []
}

// STRICT ALLOW-LIST. Reads only the named fields. Returns null if there's
// no globalEmployeeKey (can't join without it).
//
// PII NOTE: `email` (from emailAddress) is read here BY NAME like every other
// field — the source object is never spread, so photos/addresses/phone never
// leak. Email is stored ONLY in the server-side EmployeeProfile tab for login
// resolution; it is never included in the getAllData payload sent to browsers,
// and never logged.
function profileRow(e: any): Record<string, any> | null {
  const globalId = String(e?.globalEmployeeKey || '').trim()
  if (!globalId) return null
  const home = (e?.primaryStoreDict && typeof e.primaryStoreDict === 'object')
    ? e.primaryStoreDict as Record<string, any>
    : {}
  return {
    globalId,
    email: e?.emailAddress ? String(e.emailAddress).trim().toLowerCase() : '',
    inactive: e?.inactive === true ? 'true' : 'false',
    inactiveDate: e?.inactiveDate ? String(e.inactiveDate).trim() : '',
    dateOfHire: e?.dateOfHire ? String(e.dateOfHire).trim() : '',
    rehireDate: e?.rehireDate ? String(e.rehireDate).trim() : '',
    homeStoreNum: home?.n != null ? String(home.n).trim() : '',
    homeStoreName: home?.a != null ? String(home.a).trim() : '',
    homeStoreId: home?.pk != null ? (Number(home.pk) || '') : '',
    scrapedAt: new Date().toISOString(),
  }
}

export async function runProfileScrape(start?: string, end?: string): Promise<EntityScrapeResult> {
  const startedAt = Date.now()
  // Default to the last completed fiscal month — a wide window so we catch
  // part-timers. Upsert-by-globalId is non-destructive, so a too-narrow pull
  // only ever leaves prior rows intact; the table self-heals over time.
  let ms = start, me = end
  if (!ms || !me) { const m = lastCompletedFiscalMonth(yesterdayET()); ms = m.start; me = m.end }
  const result: EntityScrapeResult = {
    ok: true, durationMs: 0, weekStart: ms, weekEnd: me,
    rowsUpserted: 0, updated: 0, inserted: 0, skipped: 0, processed: 0, error: null,
  }
  try {
    const session = await authenticate()
    const salons = await fetchSalons(session)
    console.log(`[scrape/profile] ${ms}→${me} — ${salons.length} salons (per-store, deduped by globalId)`)

    // Pull per store (the proven single-store usage), then dedupe by globalId
    // so a multi-store employee yields one row at their home store.
    const perStore = await batchMap(salons, 4, async salon => {
      try {
        const payload = await fetchEmployeeReporting(session, [salon.storeId], ms!, me!)
        return extractEmployees(payload)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[scrape/profile] failed for ${salon.salonNum}:`, msg)
        return [] as any[]
      }
    })

    const byGlobalId = new Map<string, Record<string, any>>()
    for (const emps of perStore) {
      for (const e of emps) {
        const row = profileRow(e)
        if (!row) { result.skipped!++; continue }
        if (!byGlobalId.has(row.globalId)) byGlobalId.set(row.globalId, row)
      }
    }
    const dataRows = [...byGlobalId.values()]
    result.processed = dataRows.length

    if (dataRows.length > 0) {
      const up = await upsertSheet(EMP_PROFILE_TAB, [...PROFILE_COLUMNS], ['globalId'], dataRows)
      result.rowsUpserted = dataRows.length
      result.updated = up.updated
      result.inserted = up.inserted
    }
  } catch (err) {
    result.ok = false
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[scrape/profile] fatal:', result.error)
  }
  result.durationMs = Date.now() - startedAt
  return result
}
