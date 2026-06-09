// lib/bonus-period.ts
// ---------------------------------------------------------------------------
// Salon-month ("bonus period") aggregator.
//
// SINGLE SOURCE OF TRUTH: reads the weekly tables we already scrape
// (SD_WEEKLY / SD_EMP_WEEKLY / SD_PAYROLL), groups their rows into salon
// months via lib/salon-month, and rolls them up into the three tabs the
// dashboard's Manager/AM/Stylist bonus views read:
//
//   • SalonSummaryData         — per salon, period salon metrics
//   • BonusData                — per employee, period product%/NR% (FRACTIONS)
//   • PayrollConsolidatedData  — per employee, avg weekly qualifying hours
//
// No SD3 round-trips. All formulas verified EXACTLY against SD3's Manager Bonus
// report for salon 1304, salon-May 2026 (Weeks Ending 5/1–5/29):
//
//   Avg Wkly Sales/CC, NR, RR, MBC  = simple average across the month's weeks
//   Payroll %    = Σ payrollAmount / Σ totalSales × 100
//   Product %    = Σ productSales / (Σ serviceSales + Σ serviceDiscounts + Σ redoAmount) × 100
//   Productivity = (Σ serviceSales + Σ serviceDiscounts + Σ redoAmount) / Σ floorHours
//   CPH          = Productivity / (Σ grossHaircutSales / Σ haircutCount)
//   Waits >15 %  = Σ waitOver15Count / Σ cc × 100
//   Sat/Sun >15 %= Σ ssWaitCount / Σ ssCustCount × 100
//
// periodKey/periodLabel are emitted as "Mon YY" ("May 26") to match the
// dashboard's normPeriodLabel()/formatBonusPeriod() join format. No UI change.
//
// SCALE NOTE: the manager calc multiplies bonusMgrRow.product/nr by 100, so
// BonusData stores those as FRACTIONS; SalonSummaryData stores percents.
// ---------------------------------------------------------------------------

import { readSheet, rowsToObjects, upsertSheet, writeSheet } from '@/lib/sheets'
import { fetchSalons, authenticate } from '@/lib/sd3'
import { salonMonth, salonMonthsBetween, type SalonMonth } from '@/lib/salon-month'

const SD_WEEKLY_TAB = 'SD_WEEKLY'
const SD_EMP_WEEKLY_TAB = 'SD_EMP_WEEKLY'
const SD_PAYROLL_TAB = 'SD_PAYROLL'

const SALON_SUMMARY_TAB = 'SalonSummaryData'
const BONUS_TAB = 'BonusData'
const PAYROLL_CONSOLIDATED_TAB = 'PayrollConsolidatedData'

const SALON_SUMMARY_COLUMNS = [
  'periodKey', 'periodLabel', 'weeksN', 'salonNum', 'storeId',
  'avgWeeklyCC', 'avgWeeklySales', 'payrollPct', 'adjPayrollPct',
  'productPct', 'productivity', 'cph', 'mbc', 'nr', 'rr',
  'waits', 'ssWaits', 'weeksWithData', 'scrapedAt',
] as const

const BONUS_COLUMNS = [
  'periodKey', 'periodLabel', 'weeksN', 'salonNum', 'globalId', 'payId',
  'empName', 'position', 'product', 'nr', 'rr', 'productivity',
  'weeksWithData', 'scrapedAt',
] as const

const PAYROLL_CONSOLIDATED_COLUMNS = [
  'periodKey', 'periodLabel', 'weeksN', 'salonNum', 'globalId', 'payId',
  'empName', 'avgWeeklyQualifying', 'floorHoursTotal', 'weeksWithData', 'scrapedAt',
] as const

export interface BonusPeriodResult {
  ok: boolean
  periodKey: string
  weeksN: number
  monthStart: string
  monthEnd: string
  salonSummaryRows: number
  bonusRows: number
  payrollRows: number
  weekEndsUsed: string[]
  errors: string[]
  durationMs: number
  debug?: Record<string, unknown>
}

function n(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const x = parseFloat(v.replace(/[%,$]/g, ''))
    return isNaN(x) ? 0 : x
  }
  return 0
}

/** A value present (non-empty, non-***) so it counts toward a simple average. */
function present(v: unknown): boolean {
  if (v == null) return false
  const s = String(v).trim()
  return s !== '' && !s.includes('*')
}

function sum(rows: Record<string, any>[], key: string): number {
  return rows.reduce((s, r) => s + n(r[key]), 0)
}

/** Simple average over rows where the field is present (not blank/***). */
function avgPresent(rows: Record<string, any>[], key: string): { avg: number; count: number } {
  const vals = rows.filter(r => present(r[key])).map(r => n(r[key]))
  if (!vals.length) return { avg: 0, count: 0 }
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length }
}

function pctSum(numRows: Record<string, any>[], numKey: string, denKey: string): number {
  const d = sum(numRows, denKey)
  if (!d) return 0
  return (sum(numRows, numKey) / d) * 100
}

export interface BonusSources {
  weekly: Record<string, any>[]
  emp: Record<string, any>[]
  pay: Record<string, any>[]
  storeToSalon: Record<string, string>
}

/** Load the three weekly tables + storeId→salonNum map once (3 reads + 1 SD3 call). */
export async function loadBonusSources(): Promise<BonusSources> {
  const session = await authenticate()
  const salons = await fetchSalons(session)
  const storeToSalon: Record<string, string> = {}
  for (const s of salons) storeToSalon[String(s.storeId)] = s.salonNum
  const [weekly, emp, pay] = await Promise.all([
    readSheet(SD_WEEKLY_TAB).then(rowsToObjects),
    readSheet(SD_EMP_WEEKLY_TAB).then(rowsToObjects),
    readSheet(SD_PAYROLL_TAB).then(rowsToObjects),
  ])
  return { weekly, emp, pay, storeToSalon }
}

/**
 * Aggregate one salon month from the weekly tables into the three bonus tabs.
 *
 * Divisor policy (matches verified SD3 behavior): rate metrics that SD3 stores
 * per-week (NR/RR/MBC and per-week sales/CC) are simple-averaged over the weeks
 * that HAVE data; ratio metrics built from raw counts (payroll %, product %,
 * productivity, CPH, waits) are recomputed from summed numerators/denominators,
 * which is naturally weighted and ignores empty weeks correctly.
 */
export async function runBonusPeriodScrape(
  period: SalonMonth,
  opts: { debug?: boolean; sources?: BonusSources } = {},
): Promise<BonusPeriodResult> {
  const startedAt = Date.now()
  const { periodKey, periodLabel, weeksN, monthStart, monthEnd, weekEnds } = period
  const result: BonusPeriodResult = {
    ok: true, periodKey, weeksN, monthStart, monthEnd,
    salonSummaryRows: 0, bonusRows: 0, payrollRows: 0,
    weekEndsUsed: weekEnds, errors: [], durationMs: 0,
  }
  const weekSet = new Set(weekEnds)

  try {
    // Use preloaded sources (backfill path — read once, reused across periods)
    // or load fresh for a single-period run.
    const { weekly: weeklyAll, emp: empAll, pay: payAll, storeToSalon } =
      opts.sources ?? (await loadBonusSources())

    // ── 1) SalonSummaryData from SD_WEEKLY ──
    const weeklyInPeriod = weeklyAll.filter(r => weekSet.has(String(r.weekEnd)))
    const byStore: Record<string, Record<string, any>[]> = {}
    for (const r of weeklyInPeriod) {
      const sid = String(r.storeId)
      ;(byStore[sid] ||= []).push(r)
    }

    const ssRows: Record<string, any>[] = []
    for (const [sid, rows] of Object.entries(byStore)) {
      const salonNum = storeToSalon[sid] || sid
      const grossSvc = sum(rows, 'serviceSales') + sum(rows, 'serviceDiscounts') + sum(rows, 'redoAmount')
      const floorHrs = sum(rows, 'floorHours')
      const productivity = floorHrs ? grossSvc / floorHrs : 0
      const dollarsPerCut = sum(rows, 'haircutCount') ? sum(rows, 'grossHaircutSales') / sum(rows, 'haircutCount') : 0
      const cph = dollarsPerCut ? productivity / dollarsPerCut : 0
      const totSales = sum(rows, 'totalSales')
      ssRows.push({
        periodKey, periodLabel, weeksN, salonNum, storeId: sid,
        avgWeeklyCC: avgPresent(rows, 'cc').avg,
        avgWeeklySales: avgPresent(rows, 'totalSales').avg,
        payrollPct: pctSum(rows, 'payrollAmount', 'totalSales'),
        // Adjusted payroll = total payroll % minus receptionist % (bonus goal rule).
        adjPayrollPct: totSales ? ((sum(rows, 'payrollAmount') - sum(rows, 'receptionistPay')) / totSales) * 100 : 0,
        productPct: grossSvc ? (sum(rows, 'productSales') / grossSvc) * 100 : 0,
        productivity,
        cph,
        mbc: avgPresent(rows, 'mbc').avg,
        nr: avgPresent(rows, 'nr').avg,
        rr: avgPresent(rows, 'rr').avg,
        waits: pctSum(rows, 'waitOver15Count', 'cc'),
        ssWaits: (() => { const d = sum(rows, 'ssCustCount'); return d ? (sum(rows, 'ssWaitCount') / d) * 100 : 0 })(),
        weeksWithData: rows.length,
        scrapedAt: new Date().toISOString(),
      })
    }
    if (ssRows.length) {
      await upsertSheet(SALON_SUMMARY_TAB, [...SALON_SUMMARY_COLUMNS], ['periodKey', 'salonNum'], ssRows)
      result.salonSummaryRows = ssRows.length
    }

    // ── 2) BonusData from SD_EMP_WEEKLY (per employee, simple avg of weeks) ──
    const empInPeriod = empAll.filter(r => weekSet.has(String(r.weekEnd)))
    const byEmp: Record<string, Record<string, any>[]> = {}
    for (const r of empInPeriod) {
      const gid = String(r.globalId || '').trim()
      if (!gid) continue
      ;(byEmp[gid] ||= []).push(r)
    }
    const bonusRows: Record<string, any>[] = []
    for (const [gid, rows] of Object.entries(byEmp)) {
      const last = rows[rows.length - 1]
      const prod = avgPresent(rows, 'productPct')
      const nr = avgPresent(rows, 'nr')
      const rr = avgPresent(rows, 'rr')
      bonusRows.push({
        periodKey, periodLabel, weeksN,
        salonNum: storeToSalon[String(last.storeId)] || last.salonNum || '',
        globalId: gid,
        payId: String(last.payId || '').trim(),
        empName: String(last.employeeName || '').trim(),
        position: String(last.position || '').trim(),
        product: prod.count ? prod.avg / 100 : '',
        nr: nr.count ? nr.avg / 100 : '',
        rr: rr.count ? rr.avg / 100 : '',
        productivity: avgPresent(rows, 'productivity').avg || '',
        weeksWithData: rows.length,
        scrapedAt: new Date().toISOString(),
      })
    }
    if (bonusRows.length) {
      await upsertSheet(BONUS_TAB, [...BONUS_COLUMNS], ['periodKey', 'globalId'], bonusRows)
      result.bonusRows = bonusRows.length
    }

    // ── 3) PayrollConsolidatedData from SD_PAYROLL (sum hours / weeksN) ──
    const payInPeriod = payAll.filter(r => weekSet.has(String(r.weekEnd)))
    const byPayEmp: Record<string, Record<string, any>[]> = {}
    for (const r of payInPeriod) {
      const gid = String(r.globalId || '').trim()
      if (!gid) continue
      ;(byPayEmp[gid] ||= []).push(r)
    }
    const payrollRows: Record<string, any>[] = []
    for (const [gid, rows] of Object.entries(byPayEmp)) {
      const last = rows[rows.length - 1]
      // Qualifying hours = floor + vacation + holiday (Great Clips bonus rule).
      // All three are stored per-employee in SD_PAYROLL; sum them for the threshold.
      const qualifyingTotal =
        sum(rows, 'floorHours') + sum(rows, 'vacationHours') + sum(rows, 'holidayHours')
      payrollRows.push({
        periodKey, periodLabel, weeksN,
        salonNum: storeToSalon[String(last.storeId)] || last.salonNum || '',
        globalId: gid,
        payId: String(last.payId || '').trim(),
        empName: String(last.employeeName || '').trim(),
        avgWeeklyQualifying: weeksN ? qualifyingTotal / weeksN : qualifyingTotal,
        floorHoursTotal: qualifyingTotal,
        weeksWithData: rows.length,
        scrapedAt: new Date().toISOString(),
      })
    }
    if (payrollRows.length) {
      await upsertSheet(PAYROLL_CONSOLIDATED_TAB, [...PAYROLL_CONSOLIDATED_COLUMNS], ['periodKey', 'globalId'], payrollRows)
      result.payrollRows = payrollRows.length
    }

    if (opts.debug) {
      result.debug = {
        weeklyRowsInPeriod: weeklyInPeriod.length,
        storesInPeriod: Object.keys(byStore).length,
        sampleSalonSummary: ssRows.find(r => String(r.storeId) === '19436') || ssRows[0],
        sampleBonus: bonusRows[0],
        samplePayroll: payrollRows[0],
      }
    }
  } catch (err) {
    result.ok = false
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  result.durationMs = Date.now() - startedAt
  return result
}

/** Backfill a range of salon months (oldest-first). Reads source tables ONCE.
 *  reset=true clears the three bonus tabs first, removing any stale legacy rows
 *  (e.g. periods stored under an older periodKey format) so only clean, in-order
 *  "Mon YY" rows remain. */
export async function backfillBonusPeriods(
  start: { y: number; m: number },
  end: { y: number; m: number },
  opts: { debug?: boolean; pauseMs?: number; reset?: boolean } = {},
): Promise<{ ok: boolean; reset: boolean; periods: BonusPeriodResult[] }> {
  if (opts.reset) {
    // Clear data + header; the backfill's upserts recreate them fresh.
    await writeSheet(SALON_SUMMARY_TAB, [])
    await writeSheet(BONUS_TAB, [])
    await writeSheet(PAYROLL_CONSOLIDATED_TAB, [])
  }
  const months = salonMonthsBetween(start, end)
  const sources = await loadBonusSources() // 3 reads total, reused for every period
  const pause = opts.pauseMs ?? 2500
  const periods: BonusPeriodResult[] = []
  for (let i = 0; i < months.length; i++) {
    periods.push(await runBonusPeriodScrape(months[i], { debug: opts.debug, sources }))
    // Pace the writes — each period upserts 3 tabs; pausing keeps us under
    // Google Sheets' per-minute request quota across many periods.
    if (i < months.length - 1) await new Promise(res => setTimeout(res, pause))
  }
  return { ok: periods.every(p => p.ok), reset: !!opts.reset, periods }
}

/** Convenience: one salon month by calendar year + month (1-12). */
export function runBonusPeriodForMonth(year: number, month: number, opts: { debug?: boolean } = {}) {
  return runBonusPeriodScrape(salonMonth(year, month), opts)
}
