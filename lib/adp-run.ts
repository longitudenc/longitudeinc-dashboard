// lib/adp-run.ts
// ---------------------------------------------------------------------------
// Orchestration for the Office Tools payroll builder: gather a week's inputs,
// hand them to the pure engine in lib/adp-payroll, return the result.
//
// This is the step that used to be "download the Payroll Consolidated report
// from SD3, open the macro workbook, click Load Pay Consol". Nothing is
// downloaded or opened — the same report is pulled straight from SD3.
//
// Inputs gathered here:
//   • Payroll Consolidated CSV — live from SD3, the identical report/date range
//   • Six-day + per-day hours  — SD3's payrollweekresult line items, which state
//                                what SD3 already paid instead of inferring it
//   • Per-day floor hours      — SD_EMP_DAILY, fallback when the above is absent
//   • Clock punches            — SD_CHKINOUT (scraped nightly), or live on request
//   • Settings                 — ADP_SETTINGS / ADP_SALONS, or built-in defaults
//   • Bonuses                  — BonusData, on the 3rd-paycheck week only
//   • Manual earnings          — ADP_MANUAL, whatever the office keyed for the week
// ---------------------------------------------------------------------------

import {
  authenticate, fetchSalons, fetchPayrollCsv, fetchEmpChkInOut,
  fetchPayrollWeekResult, batchMap,
} from '@/lib/sd3'
import { parsePayrollWeekResult, type Sd3SixDayRow } from '@/lib/adp-payroll-detail'
import { parseCsv, rowsToObjectsAt } from '@/lib/csv'
import { readSheet, rowsToObjects, getChkInOutRange, getDailyRange } from '@/lib/sheets'
import { loadAdpSettings, type AdpSettings } from '@/lib/adp-settings'
import {
  ADP_HISTORY_TAB, compareToPrevious, lastDownloadOf, type VarianceReport,
} from '@/lib/adp-history'
import { salonMonth, salonMonthFromKey } from '@/lib/salon-month'
import { fiscalWeekContaining, lastCompletedFiscalWeek, todayET } from '@/lib/fiscal'
import {
  buildPayroll,
  toPayConsolRows,
  isBonusPayWeek,
  normalizePayId,
  type DailyFloorRow,
  type ExtraEarning,
  type PayrollBuildResult,
  type PeriodHoursRow,
  type PunchSegment,
} from '@/lib/adp-payroll'

const ADP_MANUAL_TAB = 'ADP_MANUAL'
const BONUS_TAB = 'BonusData'
const SD_PAYROLL_TAB = 'SD_PAYROLL'

/** Sheets round-trips booleans as text; accept every shape they come back in. */
function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === 'yes' || s === '1'
}

function numOrNull(v: unknown): number | null {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

export interface RunOptions {
  /** Week-ending Friday (YYYY-MM-DD). Defaults to the last completed week. */
  weekEnd?: string
  /** 'sheet' (default, nightly scrape) or 'live' (pull punches from SD3 now). */
  punchSource?: 'sheet' | 'live'
  /** Force bonuses on or off; default follows the 3rd-paycheck rule. */
  includeBonuses?: boolean
  /** Override which bonus period to pay ("Jul 26"). */
  bonusPeriod?: string
}

export interface RunResult extends PayrollBuildResult {
  meta: {
    punchSource: 'sheet' | 'live'
    punchSegments: number
    /** Per-day floor-hour rows found for the week (the 6-day day-count source). */
    dailyFloorRows: number
    /** Where SD3's own 6-day figure came from. */
    sixDaySource: 'payrollweekresult' | 'modelled'
    /** Employees whose 6-day could not be corrected for want of a Payroll ID. */
    sixDayWarnings: string[]
    payrollRows: number
    salonsInReport: string[]
    bonusPeriod: string | null
    bonusLines: number
    manualLines: number
    /** The hand-keyed lines this build actually included. */
    manualDetail: (ExtraEarning & { id: string })[]
    settingsFromSheet: boolean
    /** Codes still unassigned — the office has to fill these in. */
    missingCodes: string[]
    /** How this week's per-salon cost compares with the last week sent. */
    variance: VarianceReport
    /** Set when this week has already been downloaded — don't send it twice. */
    lastDownload: ReturnType<typeof lastDownloadOf>
    durationMs: number
  }
  settings: AdpSettings
}

/**
 * The most recently COMPLETED salon month as of a week — the bonus period whose
 * payout belongs on this paycheck. Salon months end on the last Friday of the
 * calendar month, so the current month is only complete once we're past it.
 */
export function bonusPeriodFor(weekEnd: string): string {
  const d = new Date(weekEnd + 'T00:00:00Z')
  let y = d.getUTCFullYear()
  let m = d.getUTCMonth() + 1
  let sm = salonMonth(y, m)
  if (sm.monthEnd >= weekEnd) {
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
    sm = salonMonth(y, m)
  }
  return sm.periodKey
}

/**
 * Hours WORKED per person per week across a bonus period.
 *
 * From SD_PAYROLL — the nightly payroll scrape, re-pulled the Tuesday after a
 * week closes so the figures are SD3's settled ones. Rows are per salon, and
 * the engine merges them per person per week, which is the whole point: a
 * floater passes 40 only once their salons are added together, and SD3 never
 * saw that week as one.
 */
async function loadPeriodHours(weekEnds: string[]): Promise<PeriodHoursRow[]> {
  if (weekEnds.length === 0) return []
  const want = new Set(weekEnds)
  let rows: Record<string, any>[]
  try {
    rows = rowsToObjects(await readSheet(SD_PAYROLL_TAB))
  } catch {
    return []
  }
  const out: PeriodHoursRow[] = []
  for (const r of rows) {
    const weekEnd = String(r.weekEnd || '').trim()
    if (!want.has(weekEnd)) continue
    const payId = normalizePayId(String(r.payId || ''))
    if (!payId) continue
    const hoursWorked = numOrNull(r.totalHoursWorked) ?? 0
    if (!(hoursWorked > 0)) continue
    out.push({ payId, weekEnd, hoursWorked })
  }
  return out
}

/** Stylist bonus payouts for a period, as earnings lines keyed by Payroll ID. */
async function loadBonusLines(periodKey: string, code: string): Promise<ExtraEarning[]> {
  let rows: Record<string, any>[]
  try {
    rows = rowsToObjects(await readSheet(BONUS_TAB))
  } catch {
    return []
  }
  const out: ExtraEarning[] = []
  for (const r of rows) {
    if (String(r.periodKey || '').trim() !== periodKey) continue
    const payout = numOrNull(r.payout) ?? 0
    if (!(payout > 0)) continue
    // `eligible` is written by the bonus engine; only an explicit no excludes.
    const elig = String(r.eligible ?? '').trim().toLowerCase()
    if (elig === 'false' || elig === 'no' || elig === '0') continue
    const payId = String(r.payId || '').trim()
    if (!payId) continue
    out.push({
      payId,
      salonNum: String(r.salonNum || '').trim() || undefined,
      code,
      amount: payout,
      label: `Stylist bonus ${periodKey}`,
      kind: 'bonus',
      // The period is what the true-up is computed against — a bonus paid in
      // September for August raises August's regular rate, not this week's.
      periodKey,
    })
  }
  return out
}

/** Hand-keyed earnings the office saved for this week (referral, cell, …). */
export async function loadManualLines(weekEnd: string): Promise<(ExtraEarning & { id: string })[]> {
  let rows: Record<string, any>[]
  try {
    rows = rowsToObjects(await readSheet(ADP_MANUAL_TAB))
  } catch {
    return []
  }
  return rows
    .filter(r => String(r.weekEnd || '').trim() === weekEnd)
    .map(r => ({
      id: String(r.id || '').trim(),
      payId: String(r.payId || '').trim(),
      salonNum: String(r.salonNum || '').trim() || undefined,
      code: String(r.code || '').trim(),
      amount: numOrNull(r.amount) ?? 0,
      label: String(r.label || '').trim() || 'Manual earning',
      kind: 'manual' as const,
      // Only lines the office marked count toward the week's overtime rate.
      // Blank on a row saved before the column existed → not eligible, which is
      // the safe default: it leaves the premium exactly as it is today.
      otEligible: String(r.otEligible ?? '').trim().toLowerCase() === 'true',
    }))
    .filter(l => l.payId && l.amount !== 0)
}

/**
 * Per-employee, per-day floor hours for the week from SD_EMP_DAILY.
 *
 * This is the 6-day day-count source: it carries Payroll ID, so it joins to the
 * payroll report exactly, and its floor hours are the same measure the weekly
 * report totals. Empty is fine — the engine falls back to clock punches.
 */
async function dailyFloorFromSheet(weekStart: string, weekEnd: string): Promise<DailyFloorRow[]> {
  // fresh: the 6-day day-count source, for the same reason as the punches.
  const { empDaily } = await getDailyRange(weekStart, weekEnd, { fresh: true })
  const out: DailyFloorRow[] = []
  for (const r of empDaily) {
    const payId = String(r.payId || '').trim()
    const date = String(r.date || '').trim()
    const floorHours = numOrNull(r.floorHours) ?? 0
    if (!payId || !date || !(floorHours > 0)) continue
    out.push({ date, payId, salonNum: String(r.salonNum || '').trim(), floorHours })
  }
  return out
}

/**
 * employeepk → Payroll ID, for joining SD3's payroll line items to the payroll
 * report. Two hops, both already maintained: EmployeeProfile holds
 * employeepk ↔ globalId, and the payroll report carries globalId + Payroll ID.
 */
async function buildPayIdByPk(rows: { globalId: string; payId: string }[]): Promise<Record<string, string>> {
  const payIdByGid: Record<string, string> = {}
  for (const r of rows) {
    if (r.globalId && r.payId) payIdByGid[r.globalId.trim()] = r.payId.trim()
  }
  const out: Record<string, string> = {}
  try {
    for (const p of rowsToObjects(await readSheet('EmployeeProfile'))) {
      const pk = String((p as any).employeepk ?? '').trim()
      const gid = String((p as any).globalId ?? '').trim()
      if (!pk || !gid) continue
      const payId = payIdByGid[gid]
      if (payId) out[pk] = payId
    }
  } catch {
    // EmployeeProfile unavailable → no map; the caller falls back and reports.
  }
  return out
}

/** Punches from the nightly scrape. Cheap — one Sheets read for the week. */
async function punchesFromSheet(weekStart: string, weekEnd: string): Promise<PunchSegment[]> {
  // fresh: this feeds 6-day pay, so it must never come from a
  // cached read. The scrape-only tabs are cached for minutes at a time for the
  // dashboard's benefit; payroll opts out of that.
  const { chkinout } = await getChkInOutRange(weekStart, weekEnd, { fresh: true })
  return chkinout.map(r => ({
    date: String(r.date || ''),
    salonNum: String(r.salonNum || '').trim(),
    fname: String(r.fname || ''),
    lname: String(r.lname || ''),
    checkInTime: r.checkInTime ? String(r.checkInTime) : null,
    checkOutTime: r.checkOutTime ? String(r.checkOutTime) : null,
    hours: numOrNull(r.hours),
    breakTime: numOrNull(r.breakTime),
    asStylist: truthy(r.asStylist),
    asRecept: truthy(r.asRecept),
    asTraining: truthy(r.asTraining),
    asAdmin: truthy(r.asAdmin),
    absent: truthy(r.absent),
  }))
}

/**
 * Build the ADP upload for a week.
 *
 * Punches come from the nightly SD_CHKINOUT scrape by default; if that has
 * nothing for the week (the scrape hasn't run, or the week is older than the
 * retained window) it falls back to pulling them live from SD3, because 6-day
 * pay is silently wrong without them.
 */
export async function runPayrollBuild(opts: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now()

  const weekEnd = opts.weekEnd || lastCompletedFiscalWeek(todayET()).end
  const weekStart = fiscalWeekContaining(weekEnd).start

  const settings = await loadAdpSettings()

  const session = await authenticate()
  const salons = await fetchSalons(session)
  const storeIds = salons.map(s => s.storeId)

  const csvText = await fetchPayrollCsv(session, storeIds, weekStart, weekEnd)
  const rows = toPayConsolRows(rowsToObjectsAt(parseCsv(csvText), 0))

  // ── SD3's own six-day figures, from its payroll line items ──
  //
  // This is what makes the 6-day netting exact rather than inferred. Records
  // key on employeepk, so they are joined through EmployeeProfile's
  // employeepk → globalId map and the payroll report's globalId → Payroll ID.
  // A failure here is NOT fatal: the run falls back to modelling SD3's rule and
  // says so, rather than producing a file with no 6-day correction at all.
  let sd3SixDay: Sd3SixDayRow[] | undefined
  let sixDayDailyFloor: DailyFloorRow[] = []
  const sixDayWarnings: string[] = []
  try {
    const payIdByPk = await buildPayIdByPk(rows)
    const perStore = await batchMap(salons, 4, async s => {
      try {
        const recs = await fetchPayrollWeekResult(session, s.storeId, weekStart, weekEnd)
        return parsePayrollWeekResult(recs, s.salonNum, weekStart, payIdByPk)
      } catch (e) {
        sixDayWarnings.push(
          `salon ${s.salonNum}: ${e instanceof Error ? e.message : String(e)}`
        )
        return null
      }
    })
    const ok = perStore.filter(Boolean) as NonNullable<(typeof perStore)[number]>[]
    if (ok.length > 0) {
      sd3SixDay = ok.flatMap(p => p.sd3SixDay)
      sixDayDailyFloor = ok.flatMap(p => p.dailyFloor)
      for (const p of ok) sixDayWarnings.push(...p.warnings)
    }
  } catch (e) {
    sixDayWarnings.push(e instanceof Error ? e.message : String(e))
  }

  // ── Per-day floor hours (6-day pay) ──
  // Prefer the line-item feed: same measure SD3 used for its own six-day line,
  // so the days and the dollars come from one place.
  let dailyFloor: DailyFloorRow[] = sixDayDailyFloor
  if (dailyFloor.length === 0) {
    try {
      dailyFloor = await dailyFloorFromSheet(weekStart, weekEnd)
    } catch {
      dailyFloor = []
    }
  }

  // ── Punches ──
  let punchSource: 'sheet' | 'live' = opts.punchSource === 'live' ? 'live' : 'sheet'
  let punches: PunchSegment[] = []
  if (punchSource === 'sheet') {
    try {
      punches = await punchesFromSheet(weekStart, weekEnd)
    } catch {
      punches = []
    }
    if (punches.length === 0) punchSource = 'live'
  }
  if (punchSource === 'live') {
    const perStore = await batchMap(salons, 4, async s => {
      try {
        const segs = await fetchEmpChkInOut(session, s.storeId, weekStart, weekEnd)
        return segs.map(seg => ({
          date: seg.date,
          salonNum: s.salonNum,
          fname: seg.fname,
          lname: seg.lname,
          checkInTime: seg.checkInTime,
          checkOutTime: seg.checkOutTime,
          hours: seg.hours,
          breakTime: seg.breakTime,
          asStylist: seg.asStylist,
          asRecept: seg.asRecept,
          asTraining: seg.asTraining,
          asAdmin: seg.asAdmin,
          absent: seg.absent,
        }))
      } catch {
        return [] as PunchSegment[]
      }
    })
    punches = perStore.flat()
  }

  // ── Bonuses (3rd paycheck of the month, unless overridden) ──
  const autoBonusWeek = isBonusPayWeek(
    weekEnd,
    settings.rules.payDateOffsetDays,
    settings.rules.bonusPaycheckOfMonth
  )
  const wantBonuses = opts.includeBonuses ?? autoBonusWeek
  const bonusPeriod = wantBonuses ? (opts.bonusPeriod || bonusPeriodFor(weekEnd)) : null
  const bonuses = bonusPeriod
    ? await loadBonusLines(bonusPeriod, settings.codes.stylistBonus || '')
    : []

  const manual = await loadManualLines(weekEnd)

  // Hours behind the bonus period, for the overtime true-up. Only fetched on a
  // bonus week, and only from the nightly scrape — no extra SD3 calls.
  const period = bonusPeriod ? salonMonthFromKey(bonusPeriod) : null
  const bonusPeriodHours = bonuses.length > 0 && period
    ? await loadPeriodHours(period.weekEnds)
    : []

  const result = buildPayroll({
    rows,
    punches,
    settings,
    weekStart,
    weekEnd,
    dailyFloor,
    sd3SixDay,
    bonuses,
    manual,
    bonusPeriodHours,
  })

  const missingCodes = Object.entries(settings.codes)
    .filter(([, v]) => !v)
    .map(([k]) => k)

  // What was sent last time, for the variance check and the already-downloaded
  // warning. One cached Sheets read, and a missing tab just means no history —
  // never a failed build.
  let history: Record<string, any>[] = []
  try {
    history = rowsToObjects(await readSheet(ADP_HISTORY_TAB))
  } catch { history = [] }
  const variance = compareToPrevious(result, history, settings.rules.varianceAlertPct)
  for (const w of variance.warnings) {
    result.exceptions.push({ severity: 'warning', kind: 'variance', message: w })
  }

  return {
    ...result,
    settings,
    meta: {
      punchSource,
      punchSegments: punches.length,
      dailyFloorRows: dailyFloor.length,
      sixDaySource: sd3SixDay ? 'payrollweekresult' : 'modelled',
      sixDayWarnings,
      payrollRows: rows.length,
      salonsInReport: [...new Set(rows.map(r => r.salonNum))].sort(),
      bonusPeriod,
      bonusLines: bonuses.length,
      manualLines: manual.length,
      // The lines themselves, not just how many. A count cannot tell you the
      // $200 referral is missing; a list can.
      manualDetail: manual,
      settingsFromSheet: Object.keys(settings.overrides).length > 0,
      missingCodes,
      variance,
      lastDownload: lastDownloadOf(history, weekEnd),
      durationMs: Date.now() - startedAt,
    },
  }
}
