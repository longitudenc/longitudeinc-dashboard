// lib/scrape-plan.ts
//
// THE NIGHTLY SCRAPE SCHEDULE — single source of truth.
//
// TO ADD A NIGHTLY DATA POINT: build the /api/scrape/<name> endpoint, then add
// ONE entry to the matching group below. Nothing else changes — the GitHub
// workflow fetches this plan and loops over whatever it returns, so the
// schedule is code (reviewable, testable) instead of shell in a YAML file.
//
// TWO DESIGN RULES, both learned the hard way:
//
//   1. NEVER pull only yesterday. The day-scrapes re-pull a rolling window of
//      the last LOOKBACK_DAYS days, as one job PER DAY. Upserts are idempotent,
//      so re-pulling costs a little time and nothing else — and a night that is
//      missed entirely repairs itself on the next run instead of leaving a
//      permanent hole. Two consecutive nights were lost this way before the
//      window existed.
//   2. VERIFY THE OUTCOME. The plan ends with /api/health/daily-check, which
//      looks at the sheet and fails the run when a feed gained no rows. A job
//      reporting {"ok":true} is not evidence that data arrived: SD_HALFHOUR
//      answered ok:true for 70 days while writing nothing.
//
// One job per day rather than one ranged job on purpose: each HTTP request gets
// its own 60s Vercel budget, and demand alone takes ~21s for a single day.
//
// Everything is computed in UTC, matching the workflow this replaced. The job
// ORDER is deliberate and load-bearing:
//
//   1. EXPIRING source first. /rest/invoice is a rolling ~5-week window
//      upstream, so a day not captured before it ages out is lost forever.
//   2. Core daily feed, then the access-control refresh.
//   3. Saturday: the weekly finalizer.
//   4. Tuesday: re-pull the week that closed last Friday, because SD3's payroll
//      only settles the Tuesday after a week ends.
//   5. Month-end: monthly aggregates + that month's bonus period.
//   6. Recoverable detail. These already default to week-to-date, so they
//      self-heal within the week without a window.
//   7. Wednesday: the payroll-pace email, after the data it reads has landed.
//   8. Always last: did any of it actually arrive?

export interface PlannedJob {
  name: string
  path: string    // full path, e.g. /api/scrape/daily
  query: string   // extra query string, e.g. '&start=…&end=…' ('' for none)
}

const scrape = (name: string, query = ''): PlannedJob => ({ name, path: `/api/scrape/${name}`, query })

/**
 * How many days each nightly run re-pulls, counting back from yesterday.
 * 7 means every run repairs a whole week of missed nights. GitHub has dropped
 * a scheduled run outright and delayed another by 11 hours, so this is sized
 * for the trigger being unreliable rather than for the happy path.
 * Raising it costs roughly (21s + 4s + 13s) per extra day, spread over
 * separate requests.
 */
export const LOOKBACK_DAYS = 7

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

/** Yesterday back to yesterday-(n-1), OLDEST FIRST so gaps fill in order. */
export function lookbackDays(today: string, n = LOOKBACK_DAYS): string[] {
  const out: string[] = []
  for (let i = n; i >= 1; i--) out.push(addDaysUtc(today, -i))
  return out
}

/**
 * The ordered jobs to run for `todayIso` (UTC, defaults to now).
 *
 * `today` is the day the workflow fires; `y` is yesterday, the most recent
 * completed day.
 */
export function planForDate(todayIso?: string, hourUtc?: number): PlannedJob[] {
  const today = todayIso && /^\d{4}-\d{2}-\d{2}$/.test(todayIso) ? todayIso : todayUtc()
  const y = addDaysUtc(today, -1)
  const dow = dowUtc(today)
  const window = lookbackDays(today)
  const jobs: PlannedJob[] = []

  // 1. EXPIRING SOURCE — a day lost here is unrecoverable, so it leads and gets
  //    the full window. One job per day: ~21s each, well inside 60s.
  for (const d of window) jobs.push(scrape('demand', `&start=${d}&end=${d}`))

  // NOTE: `halfhour` is deliberately absent. SD3 has returned an empty response
  // for every store since 2026-06-19, nothing in the dashboard reads SD_HALFHOUR,
  // and the job answered ok:true throughout. Re-add one line here if SD3 starts
  // serving it again and something needs it.

  // 2. Core daily feed, windowed for the same reason.
  //    ADD A PLAIN NIGHTLY SCRAPE HERE.
  for (const d of window) jobs.push(scrape('daily', `&start=${d}&end=${d}`))

  // Access control: departed employees drop out of EmployeeProfile within a day.
  jobs.push(scrape('profile'))

  // 3. SATURDAY — weekly finalizer.
  if (dow === 6) {
    jobs.push(scrape('weekly'))
    jobs.push(scrape('roster'))
    jobs.push(scrape('employee'))
    jobs.push(scrape('employee-weekly-cons'))
    jobs.push(scrape('payroll'))
    // Google ratings. Not an /api/scrape/* route -- it refreshes GooglePlaces
    // from Place Details and upserts a month row into RatingHistory, so extra
    // runs are idempotent. It already has a MONTHLY Vercel cron; this makes it
    // weekly, which is the cadence the review numbers are actually watched at.
    jobs.push({ name: 'google-ratings', path: '/api/market/ratings', query: '' })
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

  // 6. Per-employee daily detail, windowed like the rest.
  for (const d of window) jobs.push(scrape('employee-daily', `&start=${d}&end=${d}`))

  // Shifts and clock-in/out already default to a week-to-date pull, so they
  // recover a missed night on their own and need no window.
  jobs.push(scrape('shifts'))
  jobs.push(scrape('chkinout'))

  // 7. WEDNESDAY — the payroll-pace email. Not a scrape: it reads what the runs
  //    above have landed, so it goes near the end. This used to hang off
  //    /api/cron/run, which nothing scheduled after the workflow took over, so
  //    it had silently stopped sending.
  //    Only on the FIRST run of the day. The schedule now fires several times so
  //    a dropped trigger is covered, and scrapes are idempotent -- but an email
  //    is not. hourUtc is undefined for a manual run, which still sends.
  if (dow === 3 && (hourUtc === undefined || hourUtc < 12)) {
    jobs.push({ name: 'payroll-pace', path: '/api/report/payroll-pace', query: '' })
  }

  // 8. ALWAYS LAST — verify the data actually arrived. Deliberately takes no
  //    date: it checks yesterday in EASTERN time, which is the day the scrape
  //    endpoints themselves target, so the check and the scrape always agree.
  jobs.push({ name: 'daily-check', path: '/api/health/daily-check', query: '' })

  return jobs
}
