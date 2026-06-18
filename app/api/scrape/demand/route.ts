// app/api/scrape/demand/route.ts
//
// Manual + backfill endpoint for real per-half-hour demand, aggregated from
// invoices. Thin wrapper over runDemandScrape() in lib/scrape-runner.ts.
//
// Invoices (/rest/invoice) are read per store, rolled up to per-half-hour
// arrivals/served/walkouts/waits IN MEMORY, and only the rollup is written to
// SD_DEMAND. No customer/PII data is ever persisted.
//
// Usage:
//   ?secret=...                       required (or Authorization: Bearer ...)
//   (no dates)                        current fiscal week-to-date
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD  explicit range (backfill)
//
// Not in the nightly cron yet — manual until we've validated the rollup and
// decided on Supabase for the full-history backfill.

import { NextResponse } from 'next/server'
import { runDemandScrape } from '@/lib/scrape-runner'

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

  const result = await runDemandScrape(start || undefined, end || undefined)

  return NextResponse.json({
    ok: result.ok,
    mode: start && end ? 'range' : 'week-to-date',
    start: result.weekStart,
    end: result.weekEnd,
    processed: result.processed,
    inserted: result.inserted,
    updated: result.updated,
    durationMs: Date.now() - startedAt,
    error: result.error,
  }, { status: result.ok ? 200 : 500 })
}
