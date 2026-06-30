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
import { fetchSalons, authenticate, fetchEmployeePerformanceCsv, type SD3Session } from '@/lib/sd3'
import { parseCsv, rowsToObjectsAt, num as csvNum, returnRate } from '@/lib/csv'
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
  'avgWkHrs', 'custCount', 'mbc', 'hcTime', 'points', 'perPt', 'potential', 'payout',
  'prodPenalty', 'eligible',
  'weeksWithData', 'scrapedAt',
] as const

const PAYROLL_CONSOLIDATED_COLUMNS = [
  'periodKey', 'periodLabel', 'weeksN', 'salonNum', 'globalId', 'payId',
  'empName', 'avgWeeklyQualifying', 'floorHoursTotal', 'weeksWithData', 'scrapedAt',
  'avgWeeklyFloor', 'avgWeeklyVacation', 'avgWeeklyHoliday',
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

/**
 * Volume-weighted employee product %.
 * SD3's monthly product % = Σ productSales / Σ adjustedServiceSales, NOT a flat
 * average of weekly percentages. We don't scrape raw $ per employee, but each
 * week's adjusted service sales ≈ productivity × floorHours, so we weight the
 * weekly productPct by that. Falls back to a simple average if weights are
 * unavailable. Returns { avg, count } to match avgPresent's shape.
 */
function weightedProductPct(rows: Record<string, any>[]): { avg: number; count: number } {
  let num_ = 0, den = 0, count = 0
  for (const r of rows) {
    if (!present(r['productPct'])) continue
    count++
    const w = n(r['productivity']) * n(r['floorHours']) // ≈ adjusted service sales
    if (w > 0) { num_ += n(r['productPct']) * w; den += w }
  }
  if (den > 0) return { avg: num_ / den, count }
  return avgPresent(rows, 'productPct') // no usable weights → simple average
}

// ── Stylist bonus engine (mirrors dashboard BONUS_CFG) ─────────
// Points: Prod% <4=0+penalty / ≥4=1 / ≥6=2 · NR% ≥24=1 / ≥26=2 ·
//         RR% ≥74=1 / ≥77=2 · MBC ≤3=1 / ≤2=2 · HC 12–15=2 / 11–12 or 15–17=1
// Potential by avg weekly floor hrs: >30 → $200 ($20/pt) · ≥10 → $100 ($10/pt) · <10 → $0
// Min 5 pts to earn · Prod <4% → payout ×0.25
const STY = {
  PROD_1: 4, PROD_2: 6,        // product thresholds in % points
  NR_1: 24, NR_2: 26,
  RR_1: 74, RR_2: 77,
  MBC_1: 3, MBC_2: 2,
  HC_G_LO1: 11, HC_G_HI2: 17, HC_E_LO: 12, HC_E_HI: 15,
  HRS_EXC: 30, HRS_INEL: 10,
  POT_EXC: 200, PPT_EXC: 20, POT_GROW: 100, PPT_GROW: 10,
  MIN_PTS: 5, PROD_MULT: 0.25,
}
const r1 = (x: number) => Math.round(x * 10) / 10 // rounding credit: score the value as displayed (1 decimal)

function calcStylistBonus(
  prodPct: number | null, // in % points (e.g. 4.1), null if no data
  nrPct: number | null,
  rrPct: number | null,
  mbc: number | null,
  hc: number | null,
  avgWkHrs: number
) {
  const p = prodPct === null ? null : r1(prodPct)
  const nrr = nrPct === null ? null : r1(nrPct)
  const rrr = rrPct === null ? null : r1(rrPct)
  const m = mbc === null ? null : r1(mbc)
  const h = hc === null ? null : r1(hc)

  let points = 0
  points += p !== null && p >= STY.PROD_2 ? 2 : p !== null && p >= STY.PROD_1 ? 1 : 0
  points += nrr !== null && nrr >= STY.NR_2 ? 2 : nrr !== null && nrr >= STY.NR_1 ? 1 : 0
  points += rrr !== null && rrr >= STY.RR_2 ? 2 : rrr !== null && rrr >= STY.RR_1 ? 1 : 0
  points += m !== null && m <= STY.MBC_2 ? 2 : m !== null && m <= STY.MBC_1 ? 1 : 0
  points += h !== null && h >= STY.HC_E_LO && h <= STY.HC_E_HI ? 2
    : h !== null && h >= STY.HC_G_LO1 && h <= STY.HC_G_HI2 ? 1 : 0

  const hrs = r1(avgWkHrs)
  const potential = hrs > STY.HRS_EXC ? STY.POT_EXC : hrs >= STY.HRS_INEL ? STY.POT_GROW : 0
  const perPt = hrs > STY.HRS_EXC ? STY.PPT_EXC : hrs >= STY.HRS_INEL ? STY.PPT_GROW : 0

  const eligible = points >= STY.MIN_PTS
  const prodPenalty = p !== null && p < STY.PROD_1
  let payout = potential > 0 && eligible ? points * perPt : 0
  if (prodPenalty) payout *= STY.PROD_MULT

  return { points, perPt, potential, payout, prodPenalty, eligible }
}

const EMP_HEADER_ROW_INDEX = 4

/** Normalize csvNum/returnRate output: blank/undefined → null. */
function vOrNull(v: number | null | undefined): number | null {
  return v === null || v === undefined || Number.isNaN(v) ? null : v
}

/**
 * Build BonusData rows from SD3's month-range Employee Performance CSV.
 * Single-salon employees (the vast majority) get SD3's monthly values passed
 * through UNTOUCHED — exact match with the Stylist Bonus report. Multi-salon
 * employees get a principled merge: hours summed; HC/MBC/NR/RR weighted by
 * customer count; product weighted by service volume (productivity × hours).
 */
export function bonusRowsFromMonthlyCsv(
  csvText: string,
  periodKey: string,
  periodLabel: string,
  weeksN: number,
  storeToSalon: Record<string, string>,
): Record<string, any>[] {
  // Allow-list of real salon numbers. SD3's report emits a per-employee
  // "Totals/Averages" summary row (Salon # = " Totals/Averages") plus footnote
  // lines; both must be dropped, or hours double-count and salon/AM resolve wrong.
  const validSalons = new Set(Object.values(storeToSalon).map(s => String(s).trim()))
  const objs = rowsToObjectsAt(parseCsv(csvText), EMP_HEADER_ROW_INDEX)
  const byEmp: Record<string, Record<string, string>[]> = {}
  // SD3 emits a per-employee "Totals/Averages" row that holds SD3's OWN
  // pre-computed combined NR/RR (rolling-window figures) across all the
  // employee's salons. We drop it from the per-salon list (so hours/customers
  // don't double-count), but capture it here so multi-salon employees can use
  // SD3's authoritative NR/RR instead of an inaccurate weighted re-merge.
  const totalsByEmp: Record<string, Record<string, string>> = {}
  for (const o of objs) {
    const gid = String(o['Global EE ID'] || '').trim()
    const salonNum = String(o['Salon #'] || '').trim()
    if (!gid) continue
    if (!validSalons.has(salonNum)) {
      // Capture the Totals/Averages summary row (has NR/RR) — ignore footnotes.
      if (/totals|averages/i.test(salonNum)) totalsByEmp[gid] = o
      continue // skip Totals/Averages + footnotes from the per-salon list
    }
    ;(byEmp[gid] ||= []).push(o)
  }
  const out: Record<string, any>[] = []
  for (const [gid, list] of Object.entries(byEmp)) {
    // Primary salon = where they worked the most hours (row attribution)
    const primary = list.slice().sort(
      (a, b) => (csvNum(b['Floor Hours']) || 0) - (csvNum(a['Floor Hours']) || 0)
    )[0]
    const totalHrs = list.reduce((t, o) => t + (csvNum(o['Floor Hours']) || 0), 0)
    const totalCust = list.reduce((t, o) => t + (csvNum(o['Cust Count']) || 0), 0)

    let prodPct: number | null, hc: number | null, mbc: number | null
    let nr: number | null, rr: number | null, productivity: number | null
    if (list.length === 1) {
      // Pass SD3's monthly values through exactly
      prodPct = vOrNull(csvNum(primary['Stnd Prod %']))
      hc = vOrNull(csvNum(primary['Avg HC Time']))
      mbc = vOrNull(csvNum(primary['Avg Min Btwn Cust w/ Cust Waiting']))
      nr = vOrNull(returnRate(primary['Stylist New Cust Return %']))
      rr = vOrNull(returnRate(primary['Stylist Repeat Cust Return %']))
      productivity = vOrNull(csvNum(primary['Productivity']))
    } else {
      // Weighted merge across salons
      let hcW = 0, hcC = 0, mbcW = 0, mbcC = 0, nrW = 0, nrC = 0, rrW = 0, rrC = 0
      let prodW = 0, svc = 0, prtyW = 0, prtyH = 0
      for (const o of list) {
        const f = csvNum(o['Floor Hours']) || 0
        const c = csvNum(o['Cust Count']) || 0
        const oHc = vOrNull(csvNum(o['Avg HC Time']))
        const oMbc = vOrNull(csvNum(o['Avg Min Btwn Cust w/ Cust Waiting']))
        const oNr = vOrNull(returnRate(o['Stylist New Cust Return %']))
        const oRr = vOrNull(returnRate(o['Stylist Repeat Cust Return %']))
        const oProd = vOrNull(csvNum(o['Stnd Prod %']))
        const oPrty = vOrNull(csvNum(o['Productivity']))
        if (oHc !== null && c > 0) { hcW += oHc * c; hcC += c }
        if (oMbc !== null && c > 0) { mbcW += oMbc * c; mbcC += c }
        if (oNr !== null && c > 0) { nrW += oNr * c; nrC += c }
        if (oRr !== null && c > 0) { rrW += oRr * c; rrC += c }
        const sVol = (oPrty || 0) * f
        if (oProd !== null && sVol > 0) { prodW += oProd * sVol; svc += sVol }
        if (oPrty !== null && f > 0) { prtyW += oPrty * f; prtyH += f }
      }
      hc = hcC > 0 ? hcW / hcC : null
      mbc = mbcC > 0 ? mbcW / mbcC : null
      nr = nrC > 0 ? nrW / nrC : null
      rr = rrC > 0 ? rrW / rrC : null
      prodPct = svc > 0 ? prodW / svc : null
      productivity = prtyH > 0 ? prtyW / prtyH : null

      // NR/RR cannot be reconstructed by averaging across salons (SD3 computes
      // them over a rolling 105-day window). If SD3 gave us a Totals/Averages
      // row for this employee, use its authoritative combined NR/RR instead of
      // the weighted re-merge above. (Other metrics keep the merge.)
      const totalsRow = totalsByEmp[gid]
      if (totalsRow) {
        const tNr = vOrNull(returnRate(totalsRow['Stylist New Cust Return %']))
        const tRr = vOrNull(returnRate(totalsRow['Stylist Repeat Cust Return %']))
        if (tNr !== null) nr = tNr
        if (tRr !== null) rr = tRr
      }
    }

    const avgWkHrs = weeksN ? totalHrs / weeksN : 0
    const sty = calcStylistBonus(prodPct, nr, rr, mbc, hc, avgWkHrs)
    out.push({
      periodKey, periodLabel, weeksN,
      salonNum: String(primary['Salon #'] || '').trim(),
      globalId: gid,
      payId: String(primary['Pay ID'] || '').trim(),
      empName: String(primary['Employee Name'] || '').trim(),
      position: String(primary['Position'] || '').trim(),
      product: prodPct !== null ? prodPct / 100 : '',
      nr: nr !== null ? nr / 100 : '',
      rr: rr !== null ? rr / 100 : '',
      productivity: productivity !== null ? Math.round(productivity * 1000) / 1000 : '',
      avgWkHrs: Math.round(avgWkHrs * 100) / 100,
      custCount: Math.round(totalCust),
      mbc: mbc !== null ? Math.round(mbc * 100) / 100 : '',
      hcTime: hc !== null ? Math.round(hc * 100) / 100 : '',
      points: sty.points,
      perPt: sty.perPt,
      potential: sty.potential,
      payout: Math.round(sty.payout * 100) / 100,
      prodPenalty: sty.prodPenalty ? 'true' : 'false',
      eligible: sty.eligible ? 'true' : 'false',
      weeksWithData: weeksN,
      scrapedAt: new Date().toISOString(),
    })
  }
  return out
}

/** Fallback: build BonusData by averaging the weekly table (pre-existing path). */
function bonusRowsFromWeekly(
  empInPeriod: Record<string, any>[],
  periodKey: string,
  periodLabel: string,
  weeksN: number,
  storeToSalon: Record<string, string>,
): Record<string, any>[] {
  const byEmp: Record<string, Record<string, any>[]> = {}
  for (const r of empInPeriod) {
    const gid = String(r.globalId || '').trim()
    if (!gid) continue
    ;(byEmp[gid] ||= []).push(r)
  }
  const out: Record<string, any>[] = []
  for (const [gid, rows] of Object.entries(byEmp)) {
    const last = rows[rows.length - 1]
    const prod = weightedProductPct(rows)
    const nr = avgPresent(rows, 'nr')
    const rr = avgPresent(rows, 'rr')
    const mbcA = avgPresent(rows, 'mbc')
    const hcA = avgPresent(rows, 'hcTime')
    const avgWkHrs = weeksN ? sum(rows, 'floorHours') / weeksN : 0
    const totalCust = sum(rows, 'custCount')
    const sty = calcStylistBonus(
      prod.count ? prod.avg : null,
      nr.count ? nr.avg : null,
      rr.count ? rr.avg : null,
      mbcA.count ? mbcA.avg : null,
      hcA.count ? hcA.avg : null,
      avgWkHrs
    )
    out.push({
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
      avgWkHrs: Math.round(avgWkHrs * 100) / 100,
      custCount: Math.round(totalCust),
      mbc: mbcA.count ? Math.round(mbcA.avg * 100) / 100 : '',
      hcTime: hcA.count ? Math.round(hcA.avg * 100) / 100 : '',
      points: sty.points,
      perPt: sty.perPt,
      potential: sty.potential,
      payout: Math.round(sty.payout * 100) / 100,
      prodPenalty: sty.prodPenalty ? 'true' : 'false',
      eligible: sty.eligible ? 'true' : 'false',
      weeksWithData: rows.length,
      scrapedAt: new Date().toISOString(),
    })
  }
  return out
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
  session: SD3Session
  storeIds: number[]
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
  return { weekly, emp, pay, storeToSalon, session, storeIds: salons.map(s => s.storeId) }
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
    const { weekly: weeklyAll, emp: empAll, pay: payAll, storeToSalon, session, storeIds } =
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

    // ── 2) BonusData — SD3's month-range employee report is the primary
    //      source (EXACT monthly HC/MBC/Prod/NR/RR/hours, matching the Stylist
    //      Bonus report). Weekly-table averages remain as a fallback if the
    //      SD3 fetch fails, so backfills never hard-stop. ──
    let bonusRows: Record<string, any>[] = []
    let csvOk = false
    const MAX_ATTEMPTS = 5
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Try the lighter consolidated pull (isDetail=false). It still carries each
        // employee's merged Totals/Averages values, so NR/RR stay exact.
        const csvText = await fetchEmployeePerformanceCsv(session, storeIds, monthStart, monthEnd, false)
        const parsed = bonusRowsFromMonthlyCsv(csvText, periodKey, periodLabel, weeksN, storeToSalon)
        if (!parsed.length) throw new Error('monthly employee CSV parsed to 0 rows')
        bonusRows = parsed
        csvOk = true
        if (attempt > 1) result.errors.push(`monthly emp CSV recovered on attempt ${attempt} for ${periodKey}`)
        break
      } catch (e: any) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 3000 * attempt)) // 3s, 6s, 9s, 12s backoff
          continue
        }
        // All retries exhausted. Fall back to weekly averages to keep the period
        // populated, but FLAG it loudly so it can be rerun — never silently.
        result.errors.push(`monthly emp CSV FAILED after ${MAX_ATTEMPTS} attempts (${e?.message}) — used weekly averages, NR/RR approximate, RERUN ${periodKey}`)
        const empInPeriod = empAll.filter(r => weekSet.has(String(r.weekEnd)))
        bonusRows = bonusRowsFromWeekly(empInPeriod, periodKey, periodLabel, weeksN, storeToSalon)
      }
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
      // All three are stored per-employee in SD_PAYROLL; sum them for the threshold
      // AND emit each component's weekly average so the bonus card hover can show
      // the floor + vacation + holiday breakdown.
      const floorTot = sum(rows, 'floorHours')
      const vacTot   = sum(rows, 'vacationHours')
      const holTot   = sum(rows, 'holidayHours')
      const qualifyingTotal = floorTot + vacTot + holTot
      payrollRows.push({
        periodKey, periodLabel, weeksN,
        salonNum: storeToSalon[String(last.storeId)] || last.salonNum || '',
        globalId: gid,
        payId: String(last.payId || '').trim(),
        empName: String(last.employeeName || '').trim(),
        avgWeeklyQualifying: weeksN ? qualifyingTotal / weeksN : qualifyingTotal,
        floorHoursTotal: qualifyingTotal,
        avgWeeklyFloor:    weeksN ? floorTot / weeksN : floorTot,
        avgWeeklyVacation: weeksN ? vacTot / weeksN : vacTot,
        avgWeeklyHoliday:  weeksN ? holTot / weeksN : holTot,
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