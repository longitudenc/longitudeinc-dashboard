// app/api/cron/run/route.ts
//
// Single daily cron dispatcher (Vercel Hobby plan compatible).
//
// Schedule: 4 AM ET every day
//
// Calls scrape functions DIRECTLY (in-process) instead of via HTTP.
// This avoids Vercel Deployment Protection issues with internal API calls.

import { NextResponse } from 'next/server'
import { todayET, yesterdayET, dayOfWeek, isLastFridayOfMonth } from '@/lib/fiscal'
import { runBonusPeriodForMonth } from '@/lib/bonus-period'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { sendAlert, heartbeat } from '@/lib/alert'
import {
  runDailyScrape,
  runWeeklyScrape,
  runMonthlyScrape,
  runRosterScrape,
  runEmployeeScrape,
  runEmployeeWeeklyConsolidatedScrape,
  runEmployeeDailyScrape,
  runPayrollScrape,
  runProfileScrape,
  runShiftsScrape,
  runChkInOutScrape,
  runDemandScrape,
  runHalfHourScrape,
} from '@/lib/scrape-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Most recent Friday on or before an ISO date (weeks end Friday).
function mostRecentFriday(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  while (dt.getUTCDay() !== 5) dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

// Self-heal: is the latest completed week actually in SalonData? If the most
// recent past Friday is missing, the weekly scrape didn't land (missed Saturday
// cron, or it errored) — so we run it as catch-up on the next daily cron.
async function weeklyDataStale(expectedFriday: string): Promise<boolean> {
  try {
    const rows = rowsToObjects(await readSheet('SalonData'))
    let max = ''
    for (const r of rows) {
      const we = String((r as any).weekEnding || '').trim()
      if (we > max) max = we
    }
    return max < expectedFriday
  } catch (e) {
    console.error('[cron/run] stale-check failed:', e)
    return false // never let the check itself trigger a spurious catch-up
  }
}

function failureHtml(today: string, durationMs: number, failed: {name:string;error:string}[], note: string): string {
  const rows = failed.map(f =>
    `<tr><td style="padding:4px 10px 4px 0;font-weight:600;">${f.name}</td>` +
    `<td style="padding:4px 0;color:#b23;">${(f.error || 'unknown error').slice(0, 300)}</td></tr>`
  ).join('')
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#1a2b25;">
    <p><b>Longitude dashboard cron reported a problem.</b></p>
    <p>Run date: ${today} &middot; ${(durationMs/1000).toFixed(1)}s${note ? ' &middot; ' + note : ''}</p>
    <table style="border-collapse:collapse;margin:8px 0;">${rows}</table>
    <p>Re-run a scrape manually if needed, e.g. the weekly finalizer:<br>
    <code>/api/scrape/weekly?secret=YOUR_CRON_SECRET</code></p>
  </div>`
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

export async function GET(request: Request) {
  const startedAt = Date.now()

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const today = todayET()
  const yesterday = yesterdayET()
  const isSaturday = dayOfWeek(today) === 6
  const isMonthEnd = isLastFridayOfMonth(yesterday)

  try {
  // Self-heal: run the weekly scrape if it's Saturday OR the latest completed
  // week is missing (a prior Saturday was skipped/failed).
  const expectedFriday = mostRecentFriday(yesterday)
  const weeklyStale = !isSaturday && (await weeklyDataStale(expectedFriday))
  const needWeekly = isSaturday || weeklyStale

  const fired: string[] = ['daily', 'employee-daily', 'demand', 'halfhour']
  if (needWeekly) fired.push(weeklyStale ? 'weekly (catch-up)' : 'weekly')
  if (isMonthEnd) fired.push('monthly', 'bonus-period')

  console.log(
    `[cron/run] today=${today} yesterday=${yesterday} isSat=${isSaturday} isMonthEnd=${isMonthEnd} → firing: ${fired.join(', ')}`
  )

  const results: any[] = []

  // Order is chosen for GRACEFUL DEGRADATION under Vercel Hobby's 60s cap. Each
  // runner catches its own errors and returns {ok:false}, so one failure won't
  // abort the rest — but a hard timeout kills whatever hasn't run yet. So the
  // sequence is: unrecoverable first, critical next, recoverable last.

  // 1. EXPIRING SOURCE — must commit. /rest/invoice is a rolling ~5-week window
  //    upstream; a day not captured before it ages out is lost forever. This is
  //    the only feed that can't be re-run later, so it goes first. Single-day
  //    pull, idempotent on (date, storeId, halfHour).
  results.push({ name: 'demand',   result: await runDemandScrape(yesterday, yesterday) })
  results.push({ name: 'halfhour', result: await runHalfHourScrape(yesterday, yesterday) })

  // 2. CORE daily feed (SD_DAILY) — feeds every view. Recoverable via backfill,
  //    but important enough to run before the weekly-cadence work.
  results.push({ name: 'daily',   result: await runDailyScrape() })
  // Access control: departed employees drop from EmployeeProfile within a day.
  results.push({ name: 'profile', result: await runProfileScrape() })

  // 3. WEEKLY finalizer — Saturday, or catch-up when a prior Saturday was missed
  //    (see weeklyDataStale). Moved AHEAD of the recoverable detail scrapes: it
  //    used to run 8th and get starved by the timeout, which is why a missed
  //    week never finalized. Salon weekly first, then the weekly-cadence entities.
  if (needWeekly) {
    results.push({ name: 'weekly',   result: await runWeeklyScrape() })
    results.push({ name: 'roster',   result: await runRosterScrape() })
    results.push({ name: 'employee', result: await runEmployeeScrape() })
    results.push({ name: 'employee-weekly-cons', result: await runEmployeeWeeklyConsolidatedScrape() })
    results.push({ name: 'payroll',  result: await runPayrollScrape() })
  }

  // 4. Month-end bonuses (only when yesterday was a month-end Friday).
  if (isMonthEnd) {
    results.push({ name: 'monthly', result: await runMonthlyScrape() })
    // Writes SalonSummaryData / BonusData / PayrollConsolidatedData (the tabs
    // Bonus, Standouts and Reviews read). Disc eligibility is applied live at
    // view time, so this only pulls the raw period.
    const [by, bm] = yesterday.split('-').map(Number)
    results.push({ name: 'bonus-period', result: await runBonusPeriodForMonth(by, bm) })
  }

  // 5. RECOVERABLE detail — runs last on purpose. These use a week-to-date
  //    default and fill in place, so a late timeout just means they complete on
  //    the next nightly run rather than losing anything.
  results.push({ name: 'employee-daily', result: await runEmployeeDailyScrape() })
  results.push({ name: 'shifts',   result: await runShiftsScrape() })
  results.push({ name: 'chkinout', result: await runChkInOutScrape() })

  const allOk = results.every(r => r.result.ok)
  const durationMs = Date.now() - startedAt

  console.log(
    `[cron/run] ${allOk ? '\u2713' : '\u2717'} fired ${results.length} scrape(s) in ${durationMs}ms`
  )

  // Notify on any failure, then ping the dead-man's switch. Both are best-effort.
  if (!allOk) {
    const failed = results
      .filter(r => !r.result.ok)
      .map(r => ({ name: r.name, error: String(r.result.error || r.result.message || 'failed') }))
    const note = weeklyStale ? 'weekly catch-up run' : ''
    await sendAlert(
      `[Longitude] Cron \u2717 \u2014 ${failed.length} scrape(s) failed (${today})`,
      failureHtml(today, durationMs, failed, note)
    )
  }
  await heartbeat(allOk)

  return NextResponse.json({
    ok: allOk,
    durationMs,
    today,
    yesterday,
    isSaturday,
    isMonthEnd,
    weeklyCatchUp: weeklyStale,
    fired,
    results,
  })

  } catch (err: any) {
    // The whole run threw (not just one scrape) — this is the case an in-code
    // notifier is most needed for. Alert, ping failure, and surface a 500.
    const durationMs = Date.now() - startedAt
    console.error('[cron/run] fatal:', err)
    await sendAlert(
      `[Longitude] Cron \u2717 \u2014 run crashed (${today})`,
      failureHtml(today, durationMs, [{ name: 'cron/run', error: String(err?.message || err) }], 'entire run threw')
    )
    await heartbeat(false)
    return NextResponse.json({ ok: false, error: String(err?.message || err), durationMs }, { status: 500 })
  }
}