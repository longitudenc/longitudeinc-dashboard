// lib/salon-month.ts
// ---------------------------------------------------------------------------
// Salon-month ("bonus period") engine for Longitude Inc.
//
// A salon month groups Saturday→Friday weeks by the calendar month of each
// week's ENDING FRIDAY. The first week ends on the first Friday of the month;
// the last week ends on the final Friday of the month. A salon month is
// therefore 4 or 5 weeks long, and its START can fall in the PRIOR calendar
// month — e.g. salon-May 2026 = 2026-04-25 → 2026-05-29 (5 weeks).
//
// periodKey and periodLabel are emitted as "Mon YY" (e.g. "May 26") to match
// the dashboard's normPeriodLabel() / formatBonusPeriod() join format exactly,
// so SalonSummaryData / BonusData / PayrollConsolidatedData all join on it.
// ---------------------------------------------------------------------------

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

export interface SalonMonth {
  periodKey: string    // "May 26"
  periodLabel: string  // "May 26"
  year: number         // 2026 — calendar year of the month
  month: number        // 1-12
  weeksN: number       // 4 or 5
  monthStart: string   // "YYYY-MM-DD" — Saturday that begins the first week
  monthEnd: string     // "YYYY-MM-DD" — last Friday of the month
  weekEnds: string[]   // every ending-Friday "YYYY-MM-DD", first → last
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function utc(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d))
}

/** Every Friday (UTC) whose calendar month === m0 (0-based) of year y. */
function fridaysInMonth(y: number, m0: number): Date[] {
  const out: Date[] = []
  const d = utc(y, m0, 1)
  while (d.getUTCMonth() === m0) {
    if (d.getUTCDay() === 5) out.push(new Date(d.getTime()))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/** Build the salon month for calendar year `y`, month `m` (1-12). */
export function salonMonth(y: number, m: number): SalonMonth {
  const m0 = m - 1
  const fr = fridaysInMonth(y, m0)
  const firstFri = fr[0]
  const lastFri = fr[fr.length - 1]
  const start = new Date(firstFri.getTime())
  start.setUTCDate(start.getUTCDate() - 6) // Saturday beginning the first week
  const label = `${MONTHS[m0]} ${String(y).slice(2)}`
  return {
    periodKey: label,
    periodLabel: label,
    year: y,
    month: m,
    weeksN: fr.length,
    monthStart: iso(start),
    monthEnd: iso(lastFri),
    weekEnds: fr.map(iso),
  }
}

/**
 * Every salon month from `start` to `end` inclusive (each {y, m}, m is 1-12),
 * oldest-first. Used by the backfill harness.
 */
export function salonMonthsBetween(
  start: { y: number; m: number },
  end: { y: number; m: number },
): SalonMonth[] {
  const out: SalonMonth[] = []
  let y = start.y
  let m = start.m
  while (y < end.y || (y === end.y && m <= end.m)) {
    out.push(salonMonth(y, m))
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

/**
 * The salon month a given week-ending Friday belongs to — i.e. the month of
 * that Friday. (Used to roll weekly rows up into their period.)
 */
export function salonMonthForWeekEnd(weekEndIso: string): SalonMonth {
  const d = new Date(weekEndIso + 'T00:00:00Z')
  return salonMonth(d.getUTCFullYear(), d.getUTCMonth() + 1)
}

/** Most recently COMPLETED salon month as of `asOf` (default: now, UTC). */
export function lastCompletedSalonMonth(asOf: Date = new Date()): SalonMonth {
  const a = utc(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate())
  let y = a.getUTCFullYear()
  let m = a.getUTCMonth() + 1
  for (let i = 0; i < 18; i++) {
    const sm = salonMonth(y, m)
    if (new Date(sm.monthEnd + 'T00:00:00Z').getTime() < a.getTime()) return sm
    m--
    if (m < 1) { m = 12; y-- }
  }
  return salonMonth(y, m)
}