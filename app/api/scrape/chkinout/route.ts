// app/api/scrape/chkinout/route.ts
//
// Manual + backfill endpoint for actual employee clock punches (EmpChkInOut).
// Thin wrapper over runChkInOutScrape() in lib/scrape-runner.ts.
//
// This is the COMPLETE coverage source (every employee, every segment), with
// role flags and breakTime — it replaces the incomplete SD_SHIFTS feed for
// computing floor coverage in the heat map.
//
// Usage:
//   ?secret=...                       required (or Authorization: Bearer ...)
//   (no dates)                        current fiscal week-to-date
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD  explicit range (backfill)

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
    durationMs: Date.now() - startedAt,
    error: result.error,
  }, { status: result.ok ? 200 : 500 })
}
