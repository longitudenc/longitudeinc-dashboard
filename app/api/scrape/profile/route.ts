// app/api/scrape/profile/route.ts
//
// Employee profile scraper — ADP replacement. Pulls hire/rehire dates and
// home store from SD3's JSON `reporting` endpoint and upserts one row per
// employee (keyed by globalId) into the EmployeeProfile tab.
//
// PII SAFETY: the reporting payload carries names, addresses, and photo
// thumbnails. The runner's profileRow() reads ONLY an explicit six-field
// allow-list and never copies the source object, so PII never reaches the
// sheet. This route returns counts only — never the underlying data.
//
// Cadence: monthly (hire/rehire/home-store changes rarely). Wired into the
// cron's month-end branch; this route exists for manual/ad-hoc runs.
//
// Manual override:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   pulls that specific range
//   ?secret=...                         required (or Bearer header)

import { NextResponse } from 'next/server'
import { runProfileScrape } from '@/lib/scrape-runner'

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
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const start = url.searchParams.get('start') || undefined
  const end = url.searchParams.get('end') || undefined

  const result = await runProfileScrape(start, end)
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}