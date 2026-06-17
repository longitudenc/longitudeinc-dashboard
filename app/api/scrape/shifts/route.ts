// app/api/scrape/shifts/route.ts
//
// Manual + backfill endpoint for the schedule-variance (shifts) scrape.
// Thin wrapper over runShiftsScrape() in lib/scrape-runner.ts — the nightly
// cron calls the same runner, so there's one source of truth.
//
// Endpoint: /rest/schedule/variance (per store, date range) → SD_SHIFTS tab,
//   upserted by (date, storeId, employeePk, schedStart). Scheduled vs actual
//   shift times + SD3's variance notes/mask, per employee/day/shift.
//
// Usage:
//   ?secret=...                       required (or Authorization: Bearer ...)
//   (no dates)                        pulls the current fiscal week-to-date
//                                       (its Saturday → yesterday ET)
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD  BACKFILL: that explicit range
//
// The variance endpoint accepts a date range directly, so each store is a
// single fetch — a multi-week backfill is still one call per salon. Keep
// production backfills modest (a few weeks) to stay under the 60s cap; run
// large historical backfills from localhost.

import { NextResponse } from 'next/server'
import { runShiftsScrape } from '@/lib/scrape-runner'

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
  const start = url.searchParams.get('start')
  const end = url.searchParams.get('end')

  const result = await runShiftsScrape(start || undefined, end || undefined)

  return NextResponse.json({
    ok: result.ok,
    mode: start && end ? 'range' : 'week-to-date',
    start: result.weekStart,
    end: result.weekEnd,
    processed: result.processed,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    durationMs: Date.now() - startedAt,
    error: result.error,
  }, { status: result.ok ? 200 : 500 })
}
