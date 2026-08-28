// lib/scrape-plan.ts
//
// THE NIGHTLY SCRAPE SCHEDULE — single source of truth.
//
// TO ADD A NIGHTLY DATA POINT: build the /api/scrape/<name> endpoint, then add
// ONE entry to the matching group below. Nothing else changes — the GitHub
// workflow fetches this plan and loops over whatever it returns, so the
// schedule is code (reviewable, testable) instead of shell in a YAML file.
//
// Everything is computed in UTC, matching the workflow this replaced (it used
// `date -u` throughout). The job ORDER is deliberate and load-bearing:
//
//   1. EXPIRING source first. /rest/invoice is a rolling ~5-week window
//      upstream, so a day not captured before it ages out is lost forever.
//      These run before anything that could burn the budget.
//   2. Core daily feed, then the access-control refresh.
//   3. Saturday: the weekly finalizer.
//   4. Tuesday: re-pull the week that closed last Friday, because SD3's payroll
//      only settles the Tuesday after a week ends.
//   5. Month-end: monthly aggregates + that month's bonus period.
//   6. Recoverable detail last. These re-run nightly over a week-to-date
//      window, so a hiccup here self-heals on the next run.
//   7. Wednesday: the payroll-pace email, after the data it reads has landed.

export interface PlannedJob {
  name: string
  path: string    // full path, e.g. /api/scrape/daily
  query: string   // extra query string, e.g. '&start=…&end=…' ('' for none)
}

const scrape = (name: string, query = ''): PlannedJob => ({ name, path: `/api/scrape/${name}`, query })

// ── UTC date helpers ────────────────────────────────────────────────────────
// String in, string out. Everything is YYYY-MM-DD so a lexicographic compare is
// also a chronological one.

export function addDaysUtc(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** ISO day of week: 1 = Monday … 7 = Sunday (matches `date -u +%u`). */
export function dowUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay()   // 0 = Sunday
  return js === 0 ? 7 : js
}

const yearOf = (iso: string) => Number(iso.slice(0, 4))
const monthOf = (iso: string) => Number(iso.slice(5, 7))   // 1-based

/**
 * Was `iso` the LAST Friday of its month? True when it is a Friday and seven
 * days later lands in a different month. Mirrors the old shell test:
 *   date -u -d "$Y" +%u == 5  &&  date -u -d "$Y +7 days" +%m != date -u -d "$Y" +%m
 */
export function isMonthEndFriday(iso: string): boolean {
  return dowUtc(iso) === 5 && monthOf(addDaysUtc(iso, 7)) !== monthOf(iso)
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The ordered jobs to run for `todayIso` (UTC, defaults to now).
 *
 * `today` is the day the workflow fires; `y` is yesterday, the completed day
 * most scrapes actually pull.
 */
export function planForDate(todayIso?: string): PlannedJob[] {
  const today = todayIso && /^\d{4}-\d{2}-\d{2}$/.test(todayIso) ? todayIso : todayUtc()
  const y = addDaysUtc(today, -1)
  const dow = dowUtc(today)
  const jobs: PlannedJob[] = []

  // 1. EXPIRING SOURCE — a missed day is unrecoverable, so these go first.
  jobs.push(scrape('demand',   `&start=${y}&end=${y}`))
  jobs.push(scrape('halfhour', `&start=${y}&end=${y}`))

  // 2. Core daily feed + access-control refresh (both default to yesterday).
  //    ADD A PLAIN NIGHTLY SCRAPE HERE.
  jobs.push(scrape('daily'))
  jobs.push(scrape('profile'))

  // 3. SATURDAY — weekly finalizer.
  if (dow === 6) {
    jobs.push(scrape('weekly'))
    jobs.push(scrape('roster'))
    jobs.push(scrape('employee'))
    jobs.push(scrape('employee-weekly-cons'))
    jobs.push(scrape('payroll'))
  }

  // 4. TUESDAY SETTLE — SD3's payroll finalizes the Tuesday after a week closes,
  //    so re-pull the week that ended last Friday and recompute its month.
  //    Counted from TODAY (Tue -> Fri is 4 days back), not from yesterday.
  if (dow === 2) {
    const fri = addDaysUtc(today, -4)
    const sat = addDaysUtc(fri, -6)
    const range = `&start=${sat}&end=${fri}`
    jobs.push(scrape('weekly',   range))
    jobs.push(scrape('payroll',  range))
    jobs.push(scrape('employee', range))
    jobs.push(scrape('bonus-period', `&year=${yearOf(fri)}&month=${monthOf(fri)}`))
  }

  // 5. MONTH-END — yesterday was the last Friday of its month.
  if (isMonthEndFriday(y)) {
    jobs.push(scrape('monthly'))
    jobs.push(scrape('bonus-period', `&year=${yearOf(y)}&month=${monthOf(y)}`))
  }

  // 6. RECOVERABLE detail last — week-to-date, fills in place, self-heals.
  jobs.push(scrape('employee-daily'))
  jobs.push(scrape('shifts'))
  jobs.push(scrape('chkinout'))

  // 7. WEDNESDAY — the payroll-pace email. Not a scrape: it reads what the runs
  //    above have landed, so it goes last. This used to hang off /api/cron/run,
  //    which nothing scheduled after the workflow took over, so it had silently
  //    stopped sending. Same secret as the scrape routes.
  if (dow === 3) {
    jobs.push({ name: 'payroll-pace', path: '/api/report/payroll-pace', query: '' })
  }

  return jobs
}
