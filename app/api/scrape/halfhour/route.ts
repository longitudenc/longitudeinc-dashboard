// app/api/scrape/halfhour/route.ts
//
// Manual + backfill endpoint for the half-hour optimal-vs-actual staffing
// scrape. Thin wrapper over runHalfHourScrape() in lib/scrape-runner.ts.
//
// Endpoint: /rest/storeconfig/{id}/dailyhalfhouroptimal (per store, date range)
//   → SD_HALFHOUR tab, upserted by (date, storeId, halfHour). Per slot:
//   demand (customerCount), optimal staffing (needed), actual (worked).
//
// Usage:
//   ?secret=...                       required (or Authorization: Bearer ...)
//   (no dates)                        current fiscal week-to-date
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD  that explicit range
//
// NOTE: deliberately NOT wired into the nightly cron. Half-hour grain is the
// high-volume data we're moving to Supabase; until then this is manual-pull
// only, so we prototype the heat map without bloating the Sheet daily.

import { NextResponse } from 'next/server'
import { runHalfHourScrape } from '@/lib/scrape-runner'

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

  const result = await runHalfHourScrape(start || undefined, end || undefined)

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
