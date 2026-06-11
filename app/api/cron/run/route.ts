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
import {
  runDailyScrape,
  runWeeklyScrape,
  runMonthlyScrape,
  runRosterScrape,
  runEmployeeScrape,
  runPayrollScrape,
  runProfileScrape,
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

  const fired: string[] = ['daily']
  if (isSaturday) fired.push('weekly')
  if (isMonthEnd) fired.push('monthly')

  console.log(
    `[cron/run] today=${today} yesterday=${yesterday} isSat=${isSaturday} isMonthEnd=${isMonthEnd} → firing: ${fired.join(', ')}`
  )

  const results: any[] = []

  // 1. Daily — always. Includes the employee profile scrape so login emails
  //    refresh every night: when SD3 drops a departed employee, their email
  //    drops from EmployeeProfile within a day and their access is revoked.
  results.push({ name: 'daily', result: await runDailyScrape() })
  results.push({ name: 'profile', result: await runProfileScrape() })

  // 2. Weekly — only on Saturday. Salon weekly first, then the three
  //    weekly-cadence entity scrapers. Each runner catches its own errors
  //    and returns {ok:false,...}, so one failure won't abort the rest.
  if (isSaturday) {
    results.push({ name: 'weekly',   result: await runWeeklyScrape() })
    results.push({ name: 'roster',   result: await runRosterScrape() })
    results.push({ name: 'employee', result: await runEmployeeScrape() })
    results.push({ name: 'payroll',  result: await runPayrollScrape() })
  }

  // 3. Monthly — only when yesterday was a month-end Friday.
  if (isMonthEnd) {
    results.push({ name: 'monthly', result: await runMonthlyScrape() })
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