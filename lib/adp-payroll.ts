// lib/adp-payroll.ts
// ---------------------------------------------------------------------------
// SD3 Payroll Consolidated → ADP upload file.
//
// This replaces "Payroll Import Program v241119Client.xlsm". Everything that
// workbook's VBA did is ported here (CheckPay validation, CheckOT cross-salon
// overtime, CreatePayUpload's column layout), plus the three things the office
// was still working out by hand:
//
//   1. 6-DAY PAY      — $1 per floor hour for the week, when the employee
//                       worked 6+ days on the floor in the Sat→Fri week, each
//                       of those days at least 4 floor hours, and at least 34
//                       floor hours for the week. Floaters are one person: days
//                       and hours are counted across every salon they worked.
//   2. SHORT BREAKS   — any break under 20 minutes is paid time. SD3 records a
//                       break as `breakTime` minutes on the punch segment that
//                       PRECEDES it (the gap to the next check-in), so each
//                       break's length is directly available per segment.
//   3. BONUSES        — auto-populated on the 3rd paycheck of the calendar
//                       month (pay day is every Thursday).
//
// The engine is pure: callers hand it rows, punches, settings and bonus/manual
// lines, and get back the upload plus a full audit trail. Nothing here touches
// SD3, Sheets or the network, so it can be replayed against a saved week.
//
// FLOATERS ARE ONE PERSON. SD3 emits one row per employee PER SALON. Overtime,
// 6-day qualification and weekly floor hours are all computed on the employee
// (Payroll ID) across salons, then allocated back to the salon rows — which is
// what keeps each salon's P&L honest while paying the person correctly.
// ---------------------------------------------------------------------------

import {
  ADP_FIELDS,
  EXTRA_EARNINGS_SLOTS,
  SLOT_HEADERS,
  type AdpSettings,
  type AdpSlot,
} from '@/lib/adp-settings'
import { addDays, fromISODate } from '@/lib/fiscal'

// ── Money / hours helpers ───────────────────────────────────────────────

/** Round to cents. The +Number.EPSILON nudge keeps 1.005 → 1.01, not 1.00. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v ?? '').replace(/[$,%\s]/g, '')
  if (!s) return 0
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

/**
 * Split `total` across `weights`, rounded to cents, with the rounding residual
 * landing on the largest weight. Guarantees the parts sum EXACTLY to `total` —
 * important when the parts are what actually gets paid.
 */
export function allocate(total: number, weights: number[]): number[] {
  const t = round2(total)
  const sum = weights.reduce((a, b) => a + b, 0)
  if (weights.length === 0) return []
  if (sum <= 0) {
    // No weight to split by — put it all on the first row rather than dropping it.
    return weights.map((_, i) => (i === 0 ? t : 0))
  }
  const parts = weights.map(w => round2((w / sum) * t))
  const drift = round2(t - parts.reduce((a, b) => a + b, 0))
  if (drift !== 0) {
    let big = 0
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[big]) big = i
    parts[big] = round2(parts[big] + drift)
  }
  return parts
}

// ── Inputs ──────────────────────────────────────────────────────────────

/** One SD3 Payroll Consolidated row: an employee's week AT ONE SALON. */
export interface PayConsolRow {
  employeeName: string
  salonNum: string
  globalId: string
  payId: string
  baseWage: number
  weekEnding: string
  floorHours: number
  closingHours: number
  trainingHours: number
  adminHours: number
  receptionHours: number
  totalHoursWorked: number
  vacationHours: number
  holidayHours: number
  sickHours: number
  totalHours: number
  overtimeHours: number
  totalHoursPay: number
  /** SD3's own line total: hours pay + overtime, before incentives and tips. */
  subTotalPay: number
  overtimePay: number
  productivityIncentive: number
  productIncentive: number
  newReturnIncentive: number
  shiftIncentive: number
  allOtherIncentives: number
  cashCheckTips: number
  chargeTips: number
  /** 1-based row number in the source report, for exception messages. */
  sourceRow: number
}

/** One clock-punch segment, as scraped from SD3's empchkinout. */
export interface PunchSegment {
  date: string
  salonNum: string
  fname: string
  lname: string
  checkInTime: string | null
  checkOutTime: string | null
  hours: number | null
  /** Minutes between this segment's check-out and the next check-in. */
  breakTime: number | null
  asStylist: boolean
  asRecept: boolean
  asTraining: boolean
  asAdmin: boolean
  absent: boolean
}

/**
 * One employee's floor hours for ONE DAY at one salon, from SD3's employee
 * daily feed (SD_EMP_DAILY). Keyed by Payroll ID — the SAME key the payroll
 * report uses — so counting 6-day qualifying days from this needs no name
 * matching at all, and the day hours use the same "floor hours" definition
 * the weekly report totals.
 */
export interface DailyFloorRow {
  date: string
  payId: string
  salonNum: string
  floorHours: number
}

/** What produced an extra earnings line — keeps the totals from double-counting. */
export type EarningKind = 'sixDay' | 'break' | 'bonus' | 'manual'

/** A bonus or hand-keyed earning to place on the upload. */
export interface ExtraEarning {
  payId: string
  /** Salon to charge it to. Blank → the employee's largest-hours salon. */
  salonNum?: string
  /** ADP earnings code. Blank → treated as unassigned (blocking exception). */
  code: string
  amount: number
  /** Shown in the preview and exception messages. */
  label: string
  /** Defaults to 'manual' when the caller doesn't say. */
  kind?: EarningKind
}

// ── Outputs ─────────────────────────────────────────────────────────────

export type ExceptionSeverity = 'blocking' | 'warning'

export interface PayrollException {
  severity: ExceptionSeverity
  kind: string
  message: string
  employeeName?: string
  salonNum?: string
  payId?: string
}

export interface SixDayDetail {
  payId: string
  employeeName: string
  qualifies: boolean
  /** Days on the floor that reached the minimum shift length. */
  qualifyingDays: number
  /** Every floor day, with its hours — the audit trail behind qualifyingDays. */
  days: { date: string; floorHours: number; counted: boolean }[]
  /** Floor hours for the week from the payroll report (what the $1 multiplies). */
  weekFloorHours: number
  /** Floor hours the day-level feed adds up to — a cross-check, not the pay basis. */
  punchFloorHours: number
  /** Which feed supplied the per-day hours: the daily report, or clock punches. */
  source: 'daily' | 'punch' | 'none'
  amount: number
  /** Why it did not qualify, when it didn't. */
  reason: string
}

export interface BreakDetail {
  payId: string
  employeeName: string
  totalMinutes: number
  breaks: { date: string; salonNum: string; minutes: number; after: string | null }[]
  /** Paid-back minutes per salon, so the cost lands where the break happened. */
  bySalon: Record<string, number>
}

export interface EmployeeSummary {
  payId: string
  employeeName: string
  globalId: string
  salons: string[]
  baseWage: number
  floorHours: number
  totalHoursWorked: number
  overtimeHours: number
  overtimePay: number
  /** true when SD3 split this person across more than one salon. */
  isFloater: boolean
  sixDayAmount: number
  breakMinutes: number
  breakHours: number
  extraEarnings: { label: string; code: string; amount: number; kind: EarningKind }[]
}

export interface AdpUpload {
  header: string[]
  rows: (string | number)[][]
  /** Suggested file name, matching the workbook's EPI<CoCode><WeekNum>.csv. */
  fileName: string
  csv: string
}

export interface PayrollBuildResult {
  weekStart: string
  weekEnd: string
  payDate: string
  isBonusWeek: boolean
  paycheckOfMonth: number
  employees: EmployeeSummary[]
  sixDay: SixDayDetail[]
  breaks: BreakDetail[]
  exceptions: PayrollException[]
  upload: AdpUpload
  totals: {
    employees: number
    floaters: number
    rows: number
    floorHours: number
    overtimePay: number
    sixDayPay: number
    breakMinutes: number
    breakPayHours: number
    extraEarnings: number
  }
}

// ── Name matching (payroll report ↔ punch feed) ─────────────────────────
//
// The two feeds share no id: the payroll report carries Global Employee ID /
// Payroll ID, the punch feed carries employeePk. So we join on name, the same
// way the dashboard's Daily View does — but on LAST + FIRST only. The report
// writes "LAST, FIRST M" and the punch feed has separate fname/lname, so middle
// initials and suffixes are the one thing guaranteed to disagree.

function normToken(s: string): string {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '')
}

/** "ADAMS, RENEE L" → "ADAMS|RENEE". Punch feed: lname "Adams", fname "Renee". */
export function nameKeyFromReport(employeeName: string): string {
  const raw = String(employeeName || '').trim()
  if (!raw) return ''
  const [lastPart, firstPart = ''] = raw.split(',')
  const last = normToken(lastPart)
  const first = normToken((firstPart.trim().split(/\s+/)[0] || ''))
  return `${last}|${first}`
}

export function nameKeyFromPunch(fname: string, lname: string): string {
  const last = normToken(lname)
  const first = normToken(String(fname || '').trim().split(/\s+/)[0] || '')
  return `${last}|${first}`
}

// ── Pay date / bonus week ───────────────────────────────────────────────

/** Pay date for a week: week-ending Friday + offset (default 6 → Thursday). */
export function payDateFor(weekEnd: string, offsetDays: number): string {
  return addDays(weekEnd, offsetDays)
}

/** Which occurrence of its weekday the date is within its month (1-based). */
export function occurrenceInMonth(date: string): number {
  return Math.floor((fromISODate(date).getUTCDate() - 1) / 7) + 1
}

/**
 * Is this the week whose paycheck is the Nth of the calendar month?
 * Pay day is every Thursday, so "3rd paycheck of the month" is the 3rd Thursday.
 */
export function isBonusPayWeek(weekEnd: string, offsetDays: number, nth: number): boolean {
  return occurrenceInMonth(payDateFor(weekEnd, offsetDays)) === nth
}

/** Excel WEEKNUM (return_type 1: weeks start Sunday, Jan 1 is in week 1). */
export function excelWeekNum(date: string): number {
  const d = fromISODate(date)
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const dayOfYear = Math.round((d.getTime() - jan1.getTime()) / 86400000) + 1
  return Math.floor((dayOfYear + jan1.getUTCDay() - 1) / 7) + 1
}

// ── Parsing ─────────────────────────────────────────────────────────────

/** Build PayConsolRows from the parsed Payroll Consolidated CSV objects. */
export function toPayConsolRows(objects: Record<string, string>[]): PayConsolRow[] {
  const out: PayConsolRow[] = []
  objects.forEach((o, i) => {
    const name = (o['Employee Name'] || '').trim()
    const salonNum = (o['Salon #'] || '').trim()
    // SD3 appends no footer to this report, but guard against blank tail rows.
    if (!name && !salonNum) return
    out.push({
      employeeName: name,
      salonNum,
      globalId: (o['Global Employee ID'] || '').trim(),
      payId: normalizePayId(o['Payroll ID']),
      baseWage: num(o['Base Wage']),
      weekEnding: normalizeDate(o['Week Ending']),
      floorHours: num(o['Floor Hours']),
      closingHours: num(o['Closing Hours']),
      trainingHours: num(o['Training Hours']),
      adminHours: num(o['Admin Hours']),
      receptionHours: num(o['Reception Hours']),
      totalHoursWorked: num(o['Total Hours Worked']),
      vacationHours: num(o['Vacation Hours']),
      holidayHours: num(o['Holiday Hours']),
      sickHours: num(o['Sick Hours']),
      totalHours: num(o['Total Hours']),
      overtimeHours: num(o['Overtime Hours']),
      totalHoursPay: num(o['Total Hours Pay']),
      subTotalPay: num(o['Sub-Total Pay']),
      overtimePay: num(o['Overtime Hours Pay']),
      productivityIncentive: num(o['Productivity Incentive']),
      productIncentive: num(o['Product Incentive']),
      newReturnIncentive: num(o['New Return Incentive']),
      shiftIncentive: num(o['Shift Incentive']),
      allOtherIncentives: num(o['All Other Incentives']),
      cashCheckTips: num(o['Cash & Check Tips']),
      chargeTips: num(o['Charge Tips']),
      sourceRow: i + 2, // +1 for the header, +1 for 1-based
    })
  })
  return out
}

/**
 * ADP's File # is the Payroll ID WITHOUT leading zeros.
 *
 * SD3 emits some ids zero-padded ("0422", "000273"). The macro workbook dropped
 * the padding by accident — it loaded the CSV into Excel, which read the field
 * as a number — and that is the form ADP has been accepting for years. So strip
 * them deliberately here rather than sending a form ADP has never seen.
 *
 * Stripping at parse time also keeps the employee grouping consistent: "0631"
 * and "631" are one person, and must not split into two.
 */
export function normalizePayId(v: unknown): string {
  const raw = String(v ?? '').trim()
  if (!/^0\d+$/.test(raw)) return raw          // not zero-padded, or not numeric
  return raw.replace(/^0+/, '') || '0'
}

/** Accept YYYY-MM-DD, M/D/YYYY and Excel-ish date text; emit YYYY-MM-DD. */
function normalizeDate(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (m) {
    let [, mo, d, y] = m
    const yr = y.length === 2 ? `20${y}` : y
    return `${yr}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

// ── 1) Validation (port of the workbook's CheckPay) ─────────────────────

export function validateRows(rows: PayConsolRow[], settings: AdpSettings): PayrollException[] {
  const out: PayrollException[] = []

  // No Payroll ID → ADP has nobody to pay. Blocking, same as the workbook's red.
  for (const r of rows) {
    if (!r.payId) {
      out.push({
        severity: 'blocking',
        kind: 'no-payroll-id',
        message: `${r.employeeName} (row ${r.sourceRow}) has no Payroll ID`,
        employeeName: r.employeeName,
        salonNum: r.salonNum,
      })
    }
    if (r.salonNum && !settings.salons[r.salonNum]) {
      out.push({
        severity: 'blocking',
        kind: 'unknown-salon',
        message: `Salon ${r.salonNum} is not in the salon table — no Batch Id or Co Code for ${r.employeeName}`,
        employeeName: r.employeeName,
        salonNum: r.salonNum,
      })
    }
  }

  // Same person at more than one salon. Not an error — it's a floater — but the
  // office reviews these, and a differing base wage is worth a louder look.
  const byPay = groupBy(rows.filter(r => r.payId), r => `${r.weekEnding}|${r.payId}`)
  for (const group of byPay.values()) {
    if (group.length < 2) continue
    const wages = new Set(group.map(r => r.baseWage))
    const salons = group.map(r => r.salonNum).join(', ')
    if (wages.size > 1) {
      out.push({
        severity: 'warning',
        kind: 'multi-salon-wage',
        message:
          `${group[0].employeeName} works ${salons} at different base wages ` +
          `(${[...wages].map(w => `$${w.toFixed(2)}`).join(', ')}) — overtime uses a blended rate`,
        employeeName: group[0].employeeName,
        payId: group[0].payId,
      })
    } else {
      out.push({
        severity: 'warning',
        kind: 'multi-salon',
        message: `${group[0].employeeName} works multiple salons (${salons}) — treated as one person`,
        employeeName: group[0].employeeName,
        payId: group[0].payId,
      })
    }
  }

  // One Payroll ID, two different people — someone's ID is wrong and pay would
  // land on the wrong person. The workbook flagged this; keep it blocking.
  const byId = groupBy(rows.filter(r => r.payId), r => r.payId)
  for (const [payId, group] of byId) {
    const names = new Set(group.map(r => nameKeyFromReport(r.employeeName)))
    if (names.size > 1) {
      out.push({
        severity: 'blocking',
        kind: 'duplicate-payroll-id',
        message:
          `Payroll ID ${payId} is used by ${[...new Set(group.map(r => r.employeeName))].join(' and ')}`,
        payId,
      })
    }
  }

  return out
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const arr = m.get(k)
    if (arr) arr.push(it)
    else m.set(k, [it])
  }
  return m
}

// ── 2) Cross-salon overtime (port of CheckOT) ───────────────────────────

/**
 * Recompute overtime for anyone SD3 split across salons, and write the premium
 * back onto their rows in place.
 *
 * SD3 computes overtime per salon, so a floater who works 25 hours at one salon
 * and 20 at another shows 0 overtime at both. Here the week's hours are summed
 * across salons; anything over 40 earns a half-time premium on the BLENDED rate
 * (all hours pay + all incentives ÷ all hours worked, tips excluded), and that
 * premium is split back across the salons in proportion to hours worked.
 *
 * Single-salon employees are left alone — SD3 already computes their overtime
 * with the same formula, and re-deriving it would only add rounding drift.
 */
export function applyFloaterOvertime(rows: PayConsolRow[], threshold: number): void {
  const byPay = groupBy(rows.filter(r => r.payId), r => `${r.weekEnding}|${r.payId}`)

  for (const group of byPay.values()) {
    if (group.length < 2) continue // single-salon → SD3's own overtime stands

    const hours = group.reduce((s, r) => s + r.totalHoursWorked, 0)
    if (hours <= threshold) continue

    const otHours = hours - threshold
    const pay = group.reduce((s, r) => s + r.totalHoursPay, 0)
    const incentives = group.reduce(
      (s, r) =>
        s +
        r.productivityIncentive +
        r.productIncentive +
        r.newReturnIncentive +
        r.shiftIncentive +
        r.allOtherIncentives,
      0
    )
    const blendedRate = (pay + incentives) / hours
    const premium = round2((otHours * blendedRate) / 2)

    const shares = allocate(premium, group.map(r => r.totalHoursWorked))
    group.forEach((r, i) => {
      r.overtimeHours = 0 // the hours column is not exported; the premium is
      r.overtimePay = shares[i]
    })
  }
}

// ── 3) 6-day pay ────────────────────────────────────────────────────────

/**
 * Qualify each employee for 6-day pay and compute the amount.
 *
 * Rule: 6+ days worked on the floor in the Sat→Fri week, each of those days at
 * least `sixDayMinShiftHours` of floor time, and at least `sixDayMinFloorHours`
 * floor hours for the week → $`sixDayRate` per floor hour for the week.
 *
 * Days and hours are counted for the PERSON, not the salon, so a floater who
 * works Monday at one salon and Tuesday at another has worked two days.
 *
 * Day counting prefers SD3's employee DAILY feed, which is keyed by Payroll ID
 * and uses the same floor-hours definition as the weekly report — so the days
 * and the dollars agree, and no name matching is involved. Clock punches are
 * the fallback when the daily feed has nothing for that week.
 *
 * The dollar amount always multiplies the PAYROLL REPORT's floor hours, which
 * is the figure ADP and the salon P&L already agree on. The day-feed total is
 * returned alongside it so any drift is visible rather than silent.
 */
export function computeSixDay(
  rows: PayConsolRow[],
  punches: PunchSegment[],
  settings: AdpSettings,
  dailyFloor: DailyFloorRow[] = []
): { details: SixDayDetail[]; exceptions: PayrollException[] } {
  const { sixDayRate, sixDayMinDays, sixDayMinShiftHours, sixDayMinFloorHours } = settings.rules
  const details: SixDayDetail[] = []
  const exceptions: PayrollException[] = []

  // PRIMARY: floor time per person per day from the daily report, by Payroll ID.
  const floorByPayIdDate = new Map<string, Map<string, number>>()
  for (const d of dailyFloor) {
    const payId = String(d.payId || '').trim()
    if (!payId || !d.date) continue
    const hrs = Number(d.floorHours) || 0
    if (!(hrs > 0)) continue
    let byDate = floorByPayIdDate.get(payId)
    if (!byDate) floorByPayIdDate.set(payId, (byDate = new Map()))
    byDate.set(d.date, (byDate.get(d.date) || 0) + hrs)
  }

  // FALLBACK: floor time per person per day, from the punch feed (matched on name).
  const floorByKeyDate = new Map<string, Map<string, number>>()
  for (const p of punches) {
    if (p.absent) continue
    if (!p.asStylist) continue // "on the floor" = stylist time only
    const key = nameKeyFromPunch(p.fname, p.lname)
    if (!key || key === '|') continue
    const hrs = p.hours != null ? p.hours : minutesBetween(p.checkInTime, p.checkOutTime) / 60
    if (!(hrs > 0)) continue
    let byDate = floorByKeyDate.get(key)
    if (!byDate) floorByKeyDate.set(key, (byDate = new Map()))
    byDate.set(p.date, (byDate.get(p.date) || 0) + hrs)
  }

  const byPay = groupBy(rows.filter(r => r.payId), r => r.payId)
  for (const [payId, group] of byPay) {
    const employeeName = group[0].employeeName
    const weekFloorHours = round2(group.reduce((s, r) => s + r.floorHours, 0))
    // Daily report first (exact Payroll ID join), punches second (name join).
    let byDate = floorByPayIdDate.get(payId)
    let source: 'daily' | 'punch' | 'none' = byDate && byDate.size ? 'daily' : 'none'
    if (source === 'none') {
      byDate = floorByKeyDate.get(nameKeyFromReport(employeeName))
      if (byDate && byDate.size) source = 'punch'
    }

    // No day-level data at all for someone with floor hours: we cannot count
    // their days, so we cannot qualify them. Say so instead of quietly paying $0.
    if (!byDate || byDate.size === 0) {
      if (weekFloorHours >= sixDayMinFloorHours) {
        exceptions.push({
          severity: 'warning',
          kind: 'no-daily-data',
          message:
            `${employeeName} has ${weekFloorHours} floor hours but no day-level data ` +
            `(daily report or clock punches) — 6-day pay could not be evaluated`,
          employeeName,
          payId,
        })
      }
      details.push({
        payId, employeeName, qualifies: false, qualifyingDays: 0, days: [],
        weekFloorHours, punchFloorHours: 0, amount: 0, source: 'none',
        reason: 'no day-level hours found for this employee',
      })
      continue
    }

    const days = [...byDate.entries()]
      .map(([date, floorHours]) => ({
        date,
        floorHours: round2(floorHours),
        counted: floorHours >= sixDayMinShiftHours,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const qualifyingDays = days.filter(d => d.counted).length
    const punchFloorHours = round2(days.reduce((s, d) => s + d.floorHours, 0))

    const enoughDays = qualifyingDays >= sixDayMinDays
    const enoughHours = weekFloorHours >= sixDayMinFloorHours
    const qualifies = enoughDays && enoughHours

    let reason = ''
    if (!enoughDays && !enoughHours) {
      reason = `${qualifyingDays} of ${sixDayMinDays} days and ${weekFloorHours} of ${sixDayMinFloorHours} floor hours`
    } else if (!enoughDays) {
      reason = `${qualifyingDays} of ${sixDayMinDays} days at ${sixDayMinShiftHours}+ hours`
    } else if (!enoughHours) {
      reason = `${weekFloorHours} of ${sixDayMinFloorHours} floor hours`
    }

    details.push({
      payId,
      employeeName,
      qualifies,
      qualifyingDays,
      days,
      weekFloorHours,
      punchFloorHours,
      source,
      amount: qualifies ? round2(weekFloorHours * sixDayRate) : 0,
      reason,
    })
  }

  return { details, exceptions }
}

function minutesBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || tb <= ta) return 0
  return (tb - ta) / 60000
}

// ── 4) Short breaks ─────────────────────────────────────────────────────

/**
 * Find every break shorter than the threshold and total the paid-back minutes.
 *
 * SD3 stores a break as `breakTime` minutes on the segment BEFORE it — the gap
 * between that segment's check-out and the next check-in — so each individual
 * break's length is read directly, which is what the under-20-minutes test
 * needs (a 15 + 15 minute pair is two paid breaks, not one 30-minute unpaid one).
 *
 * Minutes are attributed to the salon where the break happened, so the cost
 * lands on the right P&L even for a floater.
 */
export function computeShortBreaks(
  rows: PayConsolRow[],
  punches: PunchSegment[],
  settings: AdpSettings
): BreakDetail[] {
  const limit = settings.rules.breakMaxMinutes

  const byKey = new Map<string, BreakDetail>()
  for (const p of punches) {
    const minutes = p.breakTime ?? 0
    if (!(minutes > 0) || minutes >= limit) continue
    const key = nameKeyFromPunch(p.fname, p.lname)
    if (!key || key === '|') continue
    let d = byKey.get(key)
    if (!d) {
      byKey.set(key, (d = {
        payId: '', employeeName: '', totalMinutes: 0, breaks: [], bySalon: {},
      }))
    }
    d.totalMinutes = round2(d.totalMinutes + minutes)
    d.breaks.push({ date: p.date, salonNum: p.salonNum, minutes: round2(minutes), after: p.checkOutTime })
    d.bySalon[p.salonNum] = round2((d.bySalon[p.salonNum] || 0) + minutes)
  }

  // Attach each total to the employee it belongs to. Anyone in the punch feed
  // but not on payroll this week (a transfer, a terminated employee) is dropped
  // here — there is no row to pay them on.
  const out: BreakDetail[] = []
  const byPay = groupBy(rows.filter(r => r.payId), r => r.payId)
  for (const [payId, group] of byPay) {
    const d = byKey.get(nameKeyFromReport(group[0].employeeName))
    if (!d || d.totalMinutes <= 0) continue
    d.payId = payId
    d.employeeName = group[0].employeeName
    d.breaks.sort((a, b) => a.date.localeCompare(b.date))
    out.push(d)
  }
  return out
}

// ── 5) Build the ADP upload ─────────────────────────────────────────────

interface UploadRowValues {
  /** field key → amount for the 15 fixed pairs */
  fixed: Map<string, number>
  /** additional lines for the spare Earnings 4 pairs */
  extras: { code: string; amount: number; label: string; kind: EarningKind }[]
  coCode: string
  batchId: string
  fileNum: string
  tempDept: string
}

/**
 * Assemble the upload. Column order and header names reproduce the workbook's
 * Pay Upload sheet exactly: Co Code, Batch Id, File #, Pay #, then 15 code/
 * amount pairs, then the spare Earnings 4 pairs, then Temp Dept.
 *
 * Zero amounts are written as blank (and their code column left blank) — ADP
 * treats a blank as "no such earning", and that is what the workbook produced.
 */
export function buildPayroll(input: {
  rows: PayConsolRow[]
  punches: PunchSegment[]
  settings: AdpSettings
  weekStart: string
  weekEnd: string
  /** Per-day floor hours by Payroll ID. Preferred over punches for 6-day pay. */
  dailyFloor?: DailyFloorRow[]
  /**
   * Bonus lines to place on this week. The CALLER decides whether this is the
   * bonus week — `isBonusWeek` in the result says what the rule would pick, so
   * the office can hold or advance a bonus without the engine second-guessing.
   */
  bonuses?: ExtraEarning[]
  /** Hand-keyed earnings (referral, sign-on, guarantee, manager cell, …). */
  manual?: ExtraEarning[]
}): PayrollBuildResult {
  const { rows, punches, settings, weekStart, weekEnd } = input
  const bonuses = input.bonuses ?? []
  const manual = input.manual ?? []
  const { rules, codes, salons } = settings

  const exceptions: PayrollException[] = validateRows(rows, settings)

  // Cross-salon overtime, in place, before anything reads overtimePay.
  applyFloaterOvertime(rows, rules.otThresholdHours)

  const { details: sixDay, exceptions: sixDayExceptions } =
    computeSixDay(rows, punches, settings, input.dailyFloor ?? [])
  exceptions.push(...sixDayExceptions)
  const breaks = computeShortBreaks(rows, punches, settings)

  const payDate = payDateFor(weekEnd, rules.payDateOffsetDays)
  const paycheckOfMonth = occurrenceInMonth(payDate)
  const bonusWeek = paycheckOfMonth === rules.bonusPaycheckOfMonth

  // ── Seed one upload row per payroll row, with the fields SD3 already gives us
  const byPay = groupBy(rows.filter(r => r.payId), r => r.payId)
  const values = new Map<PayConsolRow, UploadRowValues>()
  for (const r of rows) {
    const salon = salons[r.salonNum]
    const fixed = new Map<string, number>([
      ['floorHours', r.floorHours],
      ['closingHours', r.closingHours + r.adminHours], // workbook folds Admin in
      ['trainingHours', r.trainingHours],
      ['receptionHours', r.receptionHours],
      ['vacationHours', r.vacationHours],
      ['holidayHours', r.holidayHours],
      ['sickHours', r.sickHours],
      ['overtimePay', r.overtimePay],
      ['productivityIncentive', r.productivityIncentive],
      ['productIncentive', r.productIncentive],
      ['newReturnIncentive', r.newReturnIncentive],
      ['shiftIncentive', r.shiftIncentive],
      ['allOtherIncentives', r.allOtherIncentives],
      ['cashCheckTips', r.cashCheckTips],
      ['chargeTips', r.chargeTips],
    ])
    values.set(r, {
      fixed,
      extras: [],
      coCode: salon?.coCode ?? '',
      batchId: salon?.batchId ?? '',
      fileNum: r.payId,
      tempDept: r.salonNum ? `${r.salonNum}00` : '',
    })
  }

  /** The employee's rows, largest floor hours first — the default charge order. */
  const rowsFor = (payId: string): PayConsolRow[] =>
    (byPay.get(payId) ?? []).slice().sort((a, b) => b.floorHours - a.floorHours)

  // ── 6-day pay: split across the employee's salons by floor hours ──
  const sixDayCode = codes.sixDay || ''
  for (const d of sixDay) {
    if (!d.qualifies || d.amount <= 0) continue
    const group = rowsFor(d.payId)
    if (group.length === 0) continue
    if (!sixDayCode) {
      exceptions.push({
        severity: 'blocking',
        kind: 'missing-code',
        message:
          `${d.employeeName} earned $${d.amount.toFixed(2)} of 6-day pay but no ADP earnings ` +
          `code is set for it (Settings → 6-day pay code)`,
        employeeName: d.employeeName,
        payId: d.payId,
      })
      continue
    }
    const shares = allocate(d.amount, group.map(r => r.floorHours))
    group.forEach((r, i) => {
      if (shares[i] === 0) return
      values.get(r)!.extras.push({ code: sixDayCode, amount: shares[i], label: '6-day pay', kind: 'sixDay' })
    })
  }

  // ── Short breaks: paid at the employee's own rate ──
  // Default mode folds the minutes into Floor Hours, so ADP applies their base
  // wage with no new earnings code — the one option that works before ADP
  // assigns a dedicated code. Attribution is per salon, from the punch record.
  const breakCode = codes.shortBreak || ''
  if (rules.breakMode !== 'reportOnly') {
    for (const d of breaks) {
      const group = rowsFor(d.payId)
      if (group.length === 0) continue
      if (rules.breakMode === 'separateCode' && !breakCode) {
        exceptions.push({
          severity: 'blocking',
          kind: 'missing-code',
          message:
            `${d.employeeName} has ${d.totalMinutes} minutes of paid short breaks but no ADP ` +
            `earnings code is set for it (Settings → short-break code)`,
          employeeName: d.employeeName,
          payId: d.payId,
        })
        continue
      }
      for (const [salonNum, minutes] of Object.entries(d.bySalon)) {
        if (!(minutes > 0)) continue
        // Charge the salon the break happened at; fall back to their main salon
        // when that salon has no payroll row (e.g. a punch at a salon SD3 rolled
        // into another line).
        const target = group.find(r => r.salonNum === salonNum) ?? group[0]
        const v = values.get(target)!
        const hours = round2(minutes / 60)
        if (rules.breakMode === 'foldFloorHours') {
          v.fixed.set('floorHours', round2((v.fixed.get('floorHours') || 0) + hours))
        } else {
          const amount = round2(hours * target.baseWage)
          if (amount > 0) {
            v.extras.push({ code: breakCode, amount, label: `paid breaks (${minutes} min)`, kind: 'break' })
          }
        }
      }
    }
  }

  // ── Bonuses and hand-keyed earnings ──
  const extraLines: ExtraEarning[] = [...bonuses, ...manual]
  for (const line of extraLines) {
    if (!(line.amount !== 0)) continue
    const group = rowsFor(line.payId)
    if (group.length === 0) {
      exceptions.push({
        severity: 'warning',
        kind: 'orphan-earning',
        message: `${line.label} of $${line.amount.toFixed(2)} for Payroll ID ${line.payId} has no payroll row this week — not included`,
        payId: line.payId,
      })
      continue
    }
    if (!line.code) {
      exceptions.push({
        severity: 'blocking',
        kind: 'missing-code',
        message: `${line.label} of $${line.amount.toFixed(2)} for ${group[0].employeeName} has no ADP earnings code`,
        employeeName: group[0].employeeName,
        payId: line.payId,
      })
      continue
    }
    const target = (line.salonNum && group.find(r => r.salonNum === line.salonNum)) || group[0]
    values.get(target)!.extras.push({
      code: line.code,
      amount: round2(line.amount),
      label: line.label,
      kind: line.kind ?? 'manual',
    })
  }

  // Any fixed field carrying money with no code assigned (Shift Incentive is
  // "TBD" in the workbook) would silently drop that pay. Flag it instead.
  for (const f of ADP_FIELDS) {
    if (codes[f.key]) continue
    for (const r of rows) {
      const amt = values.get(r)!.fixed.get(f.key) || 0
      if (amt !== 0) {
        exceptions.push({
          severity: 'blocking',
          kind: 'missing-code',
          message: `${r.employeeName} has ${f.label} of ${amt} but no ADP code is assigned to ${f.label}`,
          employeeName: r.employeeName,
          salonNum: r.salonNum,
        })
      }
    }
  }

  // ── Emit ──
  const extraSlots = Math.max(
    EXTRA_EARNINGS_SLOTS,
    ...[...values.values()].map(v => v.extras.length)
  )
  if (extraSlots > EXTRA_EARNINGS_SLOTS) {
    exceptions.push({
      severity: 'warning',
      kind: 'extra-columns',
      message:
        `One or more employees have ${extraSlots} additional earnings, so the file carries ` +
        `${extraSlots} Earnings 4 pairs instead of the usual ${EXTRA_EARNINGS_SLOTS}`,
    })
  }

  const header: string[] = ['Co Code', 'Batch Id', 'File #', 'Pay #']
  for (const f of ADP_FIELDS) {
    header.push(SLOT_HEADERS[f.slot].code, SLOT_HEADERS[f.slot].amount)
  }
  for (let i = 0; i < extraSlots; i++) {
    header.push(SLOT_HEADERS.earnings4.code, SLOT_HEADERS.earnings4.amount)
  }
  header.push('Temp Dept')

  const uploadRows: (string | number)[][] = []
  for (const r of rows) {
    const v = values.get(r)!
    const line: (string | number)[] = [v.coCode, v.batchId, v.fileNum, 1]
    for (const f of ADP_FIELDS) {
      const amt = v.fixed.get(f.key) || 0
      // Blank pair for a zero amount — matches the workbook and ADP's reading.
      if (amt === 0) line.push('', '')
      else line.push(codes[f.key] || '', trimNum(amt))
    }
    for (let i = 0; i < extraSlots; i++) {
      const e = v.extras[i]
      if (!e || e.amount === 0) line.push('', '')
      else line.push(e.code, trimNum(e.amount))
    }
    line.push(v.tempDept)
    uploadRows.push(line)
  }

  const coCode = rows.length ? (salons[rows[0].salonNum]?.coCode ?? '') : ''
  const fileName = `EPI${coCode}${excelWeekNum(weekEnd)}.csv`

  // ── Per-employee summary for the review screen ──
  const sixDayByPay = new Map(sixDay.map(d => [d.payId, d]))
  const breakByPay = new Map(breaks.map(d => [d.payId, d]))
  const employees: EmployeeSummary[] = []
  for (const [payId, group] of byPay) {
    const sd = sixDayByPay.get(payId)
    const bd = breakByPay.get(payId)
    const extras = group.flatMap(r => values.get(r)!.extras)
    employees.push({
      payId,
      employeeName: group[0].employeeName,
      globalId: group[0].globalId,
      salons: group.map(r => r.salonNum),
      baseWage: group[0].baseWage,
      floorHours: round2(group.reduce((s, r) => s + r.floorHours, 0)),
      totalHoursWorked: round2(group.reduce((s, r) => s + r.totalHoursWorked, 0)),
      overtimeHours: round2(Math.max(0, group.reduce((s, r) => s + r.totalHoursWorked, 0) - rules.otThresholdHours)),
      overtimePay: round2(group.reduce((s, r) => s + r.overtimePay, 0)),
      isFloater: group.length > 1,
      sixDayAmount: sd?.amount ?? 0,
      breakMinutes: bd?.totalMinutes ?? 0,
      breakHours: bd ? round2(bd.totalMinutes / 60) : 0,
      extraEarnings: extras.map(e => ({ label: e.label, code: e.code, amount: e.amount, kind: e.kind })),
    })
  }
  employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName))

  return {
    weekStart,
    weekEnd,
    payDate,
    isBonusWeek: bonusWeek,
    paycheckOfMonth,
    employees,
    sixDay: sixDay.sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    breaks: breaks.sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    exceptions,
    upload: { header, rows: uploadRows, fileName, csv: toCsv([header, ...uploadRows]) },
    totals: {
      employees: employees.length,
      floaters: employees.filter(e => e.isFloater).length,
      rows: uploadRows.length,
      floorHours: round2(rows.reduce((s, r) => s + r.floorHours, 0)),
      overtimePay: round2(rows.reduce((s, r) => s + r.overtimePay, 0)),
      sixDayPay: round2(sixDay.reduce((s, d) => s + d.amount, 0)),
      breakMinutes: round2(breaks.reduce((s, d) => s + d.totalMinutes, 0)),
      breakPayHours: round2(breaks.reduce((s, d) => s + d.totalMinutes, 0) / 60),
      // Bonuses + hand-keyed lines only. 6-day pay and short breaks have their
      // own totals above, so counting them here too would overstate the week.
      extraEarnings: round2(
        [...values.values()].reduce(
          (s, v) => s + v.extras.reduce((t, e) => t + (e.kind === 'bonus' || e.kind === 'manual' ? e.amount : 0), 0),
          0
        )
      ),
    },
  }
}

/** Excel's General format: whole numbers lose the ".00", others keep 2 places. */
function trimNum(n: number): number {
  return round2(n)
}

export function toCsv(rows: (string | number)[][]): string {
  return rows
    .map(r =>
      r
        .map(cell => {
          const s = String(cell ?? '')
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(',')
    )
    .join('\r\n')
}
