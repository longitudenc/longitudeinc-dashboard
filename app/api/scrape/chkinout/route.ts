// app/api/scrape/chkinout/route.ts
//
// Manual + backfill endpoint for the employee clock-punch (chkinout) scrape.
// Thin wrapper over runChkInOutScrape() in lib/scrape-runner.ts — the nightly
// cron calls the same runner, so there's one source of truth.
//
// Endpoint: /rest/storeconfig/{storeId}/empchkinout (per store, checkInTime
//   window) → SD_CHKINOUT tab, upserted by (date, storeId, chkPk). One row per
//   employee per punch segment: checkIn/checkOut, hours, breakTime, and role
//   flags (asStylist/asAdmin/asRecept/asTraining) — the feed behind Break/Admin
//   time in the Daily View.
//
// Usage:
//   ?secret=...                       required (or Authorization: Bearer ...)
//   (no dates)                        current fiscal week-to-date (Sat → yesterday ET)
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD  BACKFILL: that explicit range
//
// Each store is a single windowed fetch, so a multi-week backfill is still one
// call per salon. Keep production backfills modest (a few weeks) to stay under
// the 60s cap; run large historical backfills from localhost.

import { NextResponse } from 'next/server'
import { runChkInOutScrape } from '@/lib/scrape-runner'

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

  const result = await runChkInOutScrape(start || undefined, end || undefined)

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
