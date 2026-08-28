// app/api/scrape/profile/route.ts
//
// Employee profile scraper — ADP replacement. Pulls hire/rehire dates and
// home store from SD3's JSON `reporting` endpoint and upserts one row per
// employee (keyed by globalId) into the EmployeeProfile tab.
//
// PII SAFETY: the reporting payload carries names, addresses, SSNs, passwords
// and photo thumbnails. The runner's profileRow() reads ONLY an explicit
// allow-list (PROFILE_COLUMNS) and never copies the source object, so none of
// that reaches the sheet.
//
// Two allow-listed fields ARE personal and are restricted downstream:
//   email — login resolution only; never sent to a browser.
//   phone — homePhone, else phone2 (never emergencyPhone). Served only to
//           owner/admin/office, via the includePhone gate in /api/home.
//
// This route returns counts only — never the underlying data.
//
// Cadence: NIGHTLY. .github/workflows/scrape.yml calls this at 08:00 UTC
// (~4 AM ET) on every run, so a birthday or hire date corrected in SD3 shows
// up the next morning with no manual step. This route also serves ad-hoc runs.
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