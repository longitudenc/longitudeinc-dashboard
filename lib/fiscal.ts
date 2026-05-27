// lib/fiscal.ts
// Fiscal calendar math for Longitude Inc.
//
// Fiscal week:  Saturday → Friday (Great Clips standard)
// Fiscal month: Saturday after the prior calendar month's final Friday
//               → that calendar month's final Friday.
//   Example:    May fiscal month = Sat 4/25 → Fri 5/29
//
// All functions accept and return YYYY-MM-DD strings (no Date objects in/out)
// to avoid timezone foot-guns.

// ── Utilities ────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD using its UTC components. */
export function toISODate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a YYYY-MM-DD string as a UTC date at 00:00:00. */
export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Add N days to a YYYY-MM-DD date string. */
export function addDays(date: string, days: number): string {
  const d = fromISODate(date)
  d.setUTCDate(d.getUTCDate() + days)
  return toISODate(d)
}

/** Day of week: 0=Sunday, 1=Monday, …, 5=Friday, 6=Saturday. */
export function dayOfWeek(date: string): number {
  return fromISODate(date).getUTCDay()
}

/** Today's date in NY/ET as YYYY-MM-DD. */
export function todayET(): string {
  // Use Intl to get the date as it appears in NY time, regardless of server tz
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(new Date()) // en-CA produces YYYY-MM-DD
}

/** Yesterday's date in NY/ET as YYYY-MM-DD. */
export function yesterdayET(): string {
  return addDays(todayET(), -1)
}

// ── Fiscal week (Sat → Fri) ──────────────────────────────────

/**
 * Given any date, return {start, end} of the fiscal week it belongs to.
 * Week starts on Saturday, ends on Friday.
 */
export function fiscalWeekContaining(date: string): { start: string; end: string } {
  const dow = dayOfWeek(date) // 0=Sun ... 6=Sat
  // Days back to most recent Saturday (inclusive of today if today is Sat)
  const daysBackToSat = dow === 6 ? 0 : dow + 1
  const start = addDays(date, -daysBackToSat)
  const end = addDays(start, 6)
  return { start, end }
}

/**
 * Return {start, end} of the most recently *completed* fiscal week,
 * relative to the given date. If date is a Saturday, the just-finished
 * week (Sat-prev → Fri-yesterday) is returned.
 */
export function lastCompletedFiscalWeek(asOf: string): { start: string; end: string } {
  const dow = dayOfWeek(asOf)
  // The most recent Friday on or before yesterday:
  //   if today is Sat → Friday is yesterday
  //   if today is Sun → Friday was 2 days ago
  //   if today is Fri → most recently *completed* Fri week was the previous one
  let daysBackToFri: number
  if (dow === 5) {
    daysBackToFri = 7 // today is Fri; last completed week ended a week ago Fri
  } else if (dow === 6) {
    daysBackToFri = 1 // today is Sat; yesterday was Fri
  } else {
    daysBackToFri = dow + 2 // Sun→2, Mon→3, Tue→4, Wed→5, Thu→6
  }
  const end = addDays(asOf, -daysBackToFri)
  const start = addDays(end, -6)
  return { start, end }
}

// ── Fiscal month ─────────────────────────────────────────────

/**
 * Return the last Friday of the calendar month containing the given date.
 *
 * "Last Friday of May" = the Friday on or before the last day of May.
 */
export function lastFridayOfCalendarMonth(date: string): string {
  const d = fromISODate(date)
  // Walk to the last day of the calendar month
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)) // day 0 of next month = last of this
  // Walk backwards until we hit Friday (dow 5)
  while (lastDay.getUTCDay() !== 5) {
    lastDay.setUTCDate(lastDay.getUTCDate() - 1)
  }
  return toISODate(lastDay)
}

/**
 * Is the given date the final Friday of its calendar month?
 * Used by the monthly cron to decide whether to fire.
 */
export function isLastFridayOfMonth(date: string): boolean {
  return date === lastFridayOfCalendarMonth(date)
}

/**
 * Return the fiscal month that ENDS on the given date.
 * Caller must guarantee `endDate` is the final Friday of its calendar month
 * (verify with isLastFridayOfMonth first).
 *
 * Start = Saturday after the prior calendar month's final Friday.
 */
export function fiscalMonthEndingOn(endDate: string): { start: string; end: string } {
  // Step back one day at a time until we hit the prior calendar month
  const end = fromISODate(endDate)
  const thisMonth = end.getUTCMonth()
  let cursor = fromISODate(endDate)
  while (cursor.getUTCMonth() === thisMonth) {
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  // Now cursor is in the prior calendar month. Walk back to its last Friday.
  const priorMonthLastFri = lastFridayOfCalendarMonth(toISODate(cursor))
  // Fiscal month starts the Saturday after that
  const start = addDays(priorMonthLastFri, 1)
  return { start, end: endDate }
}

/**
 * Return the most recently completed fiscal month as of the given date.
 * If `asOf` is the day after a fiscal month boundary, returns that fiscal month.
 * Otherwise returns whatever fiscal month ended before `asOf`.
 */
export function lastCompletedFiscalMonth(asOf: string): { start: string; end: string } {
  // Find the most recent past "last Friday of a calendar month" strictly before asOf
  let cursor = addDays(asOf, -1)
  while (!isLastFridayOfMonth(cursor)) {
    cursor = addDays(cursor, -1)
  }
  return fiscalMonthEndingOn(cursor)
}