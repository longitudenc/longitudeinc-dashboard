// app/api/scrape/employee-daily/route.ts
//
// Manual + backfill endpoint for the per-stylist DAILY performance scrape.
// Thin wrapper over runEmployeeDailyScrape() in lib/scrape-runner.ts so there
// is a single source of truth (the nightly cron calls the same runner).
//
// Endpoint: /rest/dailyemployeesummary/consolidated.csv with start=end=one day,
//   → SD_EMP_DAILY tab, upserted by (date, storeId, payId). NR/RR omitted
//   (rolling 105-day figures, meaningless per day).
//
// Usage:
//   ?secret=...                       required (or Authorization: Bearer ...)
//   (no date)                         pulls yesterday (ET)
//   ?date=YYYY-MM-DD                  pulls that single day
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD  BACKFILL: loops each day in [start,end]
//
// Backfill note: each day is one CSV pull (~a few seconds). Function duration
// is capped at 60s, so backfill in small chunks (≈5–7 days per call) to stay
// under the limit. The response reports how many days completed.

import { NextResponse } from 'next/server'
import { runEmployeeDailyScrape, runEmployeeDailyRange } from '@/lib/scrape-runner'

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
  const dateParam = url.searchParams.get('date')
  const startParam = url.searchParams.get('start')
  const endParam = url.searchParams.get('end')

  // Single-day mode (default = yesterday inside the runner).
  if (!startParam || !endParam) {
    const result = await runEmployeeDailyScrape(dateParam || undefined)
    return NextResponse.json({
      ok: result.ok,
      mode: 'single',
      durationMs: Date.now() - startedAt,
      result,
    }, { status: result.ok ? 200 : 500 })
  }

  // Backfill range mode: one session, all days in [start, end] inclusive.
  // Runs uncapped on localhost; on Vercel it must finish within 60s, so keep
  // production backfills to a few weeks per call (local is the place for YTD).
  const result = await runEmployeeDailyRange(startParam, endParam)
  return NextResponse.json({
    ok: result.ok,
    mode: 'backfill',
    start: startParam,
    end: endParam,
    daysProcessed: result.days,
    rowsProcessed: result.processed,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    durationMs: Date.now() - startedAt,
    error: result.error,
  }, { status: result.ok ? 200 : 500 })
}
