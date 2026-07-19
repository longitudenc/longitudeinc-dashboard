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

  const fired: string[] = ['daily', 'employee-daily', 'demand', 'halfhour']
  if (isSaturday) fired.push('weekly')
  if (isMonthEnd) fired.push('monthly', 'bonus-period')

  console.log(
    `[cron/run] today=${today} yesterday=${yesterday} isSat=${isSaturday} isMonthEnd=${isMonthEnd} → firing: ${fired.join(', ')}`
  )

  const results: any[] = []

  // 1. Daily — always. Includes the employee profile scrape so login emails
  //    refresh every night: when SD3 drops a departed employee, their email
  //    drops from EmployeeProfile within a day and their access is revoked.
  results.push({ name: 'daily', result: await runDailyScrape() })
  results.push({ name: 'profile', result: await runProfileScrape() })
  // Per-stylist daily performance (single-day employee CSV → SD_EMP_DAILY).
  results.push({ name: 'employee-daily', result: await runEmployeeDailyScrape() })
  // Schedule variance (scheduled vs actual shift) → SD_SHIFTS. Defaults to the
  // current fiscal week-to-date, so each day's run fills the week in place.
  results.push({ name: 'shifts', result: await runShiftsScrape() })
  // Employee clock punches → SD_CHKINOUT (in/out, breakTime, asAdmin). Same
  // week-to-date default as shifts; this is the feed behind Break/Admin time.
  results.push({ name: 'chkinout', result: await runChkInOutScrape() })

  // Real per-half-hour demand from invoices → SD_DEMAND, and half-hour
  // optimal-vs-actual staffing → SD_HALFHOUR.
  //
  // CRITICAL: /rest/invoice is a ROLLING ~5-week window upstream. Any day not
  // captured before it ages out is lost permanently. This is the only feed in
  // the system with an expiring source, so it runs every night.
  //
  // Both are passed `yesterday` explicitly for BOTH bounds rather than using
  // their week-to-date default. The default would re-pull Saturday→yesterday
  // every night (up to 7x the work, 18 salon calls per day of range) and this
  // function is capped at 60s on Vercel Hobby. Upsert key is
  // (date, storeId, halfHour), so a single-day pull is idempotent and the week
  // fills in place, one day at a time.
  results.push({ name: 'demand',   result: await runDemandScrape(yesterday, yesterday) })
  results.push({ name: 'halfhour', result: await runHalfHourScrape(yesterday, yesterday) })

  // 2. Weekly — only on Saturday. Salon weekly first, then the three
  //    weekly-cadence entity scrapers. Each runner catches its own errors
  //    and returns {ok:false,...}, so one failure won't abort the rest.
  if (isSaturday) {
    results.push({ name: 'weekly',   result: await runWeeklyScrape() })
    results.push({ name: 'roster',   result: await runRosterScrape() })
    results.push({ name: 'employee', result: await runEmployeeScrape() })
    results.push({ name: 'employee-weekly-cons', result: await runEmployeeWeeklyConsolidatedScrape() })
    results.push({ name: 'payroll',  result: await runPayrollScrape() })
  }

  // 3. Monthly — only when yesterday was a month-end Friday.
  if (isMonthEnd) {
    results.push({ name: 'monthly', result: await runMonthlyScrape() })
    // yesterday was the month-end Friday → scrape that just-closed fiscal month's
    // bonuses (writes SalonSummaryData / BonusData / PayrollConsolidatedData, the
    // tabs Bonus, Standouts and Reviews read). Disc eligibility is applied live at
    // view time from dated points, so this only needs to pull the raw period.
    const [by, bm] = yesterday.split('-').map(Number)
    results.push({ name: 'bonus-period', result: await runBonusPeriodForMonth(by, bm) })
  }

  const allOk = results.every(r => r.result.ok)
  const durationMs = Date.now() - startedAt

  console.log(
    `[cron/run] ${allOk ? '✓' : '✗'} fired ${results.length} scrape(s) in ${durationMs}ms`
  )

  return NextResponse.json({
    ok: allOk,
    durationMs,
    today,
    yesterday,
    isSaturday,
    isMonthEnd,
    fired,
    results,
  })
}