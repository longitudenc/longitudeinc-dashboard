// app/api/scrape/employee-weekly-cons/route.ts
//
// Manual + backfill endpoint for the WEEKLY CONSOLIDATED per-employee scrape.
// One row per employee per Sat→Fri week, MERGED across every salon they worked
// (SD3 Totals/Averages override for floaters → exact weekly NR/RR). Thin wrapper
// over runEmployeeWeeklyConsolidatedScrape / ...Range in lib/scrape-runner.ts so
// the nightly cron and manual calls share one source of truth.
//
// Endpoint: /rest/dailyemployeesummary/consolidated.csv with start=Sat,end=Fri,
//   isDetail=false + 5 retries → SD_EMP_WEEKLY_CONS, upserted by (weekEnd, globalId).
//   Per-salon detail for the click-through drill stays in SD_EMP_WEEKLY.
//
// Usage:
//   ?secret=...                          required (or Authorization: Bearer ...)
//   (no dates)                           pulls the last completed fiscal week
//   ?weekEnd=YYYY-MM-DD                  pulls that single week (Fri ending)
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD     BACKFILL: each Fri week-ending in [start,end]
//
// Backfill note: each week is one lighter (isDetail=false) CSV pull. Keep ranges
// modest (≈6–8 weeks per call) to stay under the 60s function cap; the response
// reports how many weeks completed.

import { NextResponse } from 'next/server'
import { runEmployeeWeeklyConsolidatedScrape, runEmployeeWeeklyConsolidatedRange } from '@/lib/scrape-runner'

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

  const url = new URL(request.url)
  const weekEndParam = url.searchParams.get('weekEnd')
  const startParam = url.searchParams.get('start')
  const endParam = url.searchParams.get('end')

  // Single-week mode (default = last completed fiscal week inside the runner).
  if (!startParam || !endParam) {
    const ws = weekEndParam
      ? new Date(new Date(weekEndParam).getTime() - 6 * 86400000).toISOString().slice(0, 10)
      : undefined
    const result = await runEmployeeWeeklyConsolidatedScrape(ws, weekEndParam || undefined)
    return NextResponse.json({
      ok: result.ok,
      mode: 'single',
      durationMs: Date.now() - startedAt,
      result,
    }, { status: result.ok ? 200 : 500 })
  }

  // Backfill range mode: one session, each Fri week-ending in [start, end] inclusive.
  const result = await runEmployeeWeeklyConsolidatedRange(startParam, endParam)
  return NextResponse.json({
    ok: result.ok,
    mode: 'range',
    durationMs: Date.now() - startedAt,
    result,
  }, { status: result.ok ? 200 : 500 })
}
