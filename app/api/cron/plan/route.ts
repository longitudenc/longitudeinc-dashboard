// app/api/cron/plan/route.ts
//
// Returns the ordered job list for a given day. The nightly GitHub workflow
// fetches this and loops over it, so the schedule lives in code
// (lib/scrape-plan.ts) rather than in shell inside the YAML.
//
//   /api/cron/plan?secret=…                    today's plan (UTC)
//   /api/cron/plan?secret=…&date=YYYY-MM-DD    that day's plan, for testing
//
// Read-only: it computes the list and runs nothing.

import { NextResponse } from 'next/server'
import { planForDate, todayUtc } from '@/lib/scrape-plan'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  if (request.headers.get('authorization') === `Bearer ${expected}`) return true
  return new URL(request.url).searchParams.get('secret') === expected
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const params = new URL(request.url).searchParams
  const date = params.get('date') || undefined
  // Which run of the day this is, so once-a-day jobs (the payroll-pace email)
  // fire once even though the schedule now runs several times.
  const hourRaw = params.get('hour')
  const hourNum = hourRaw === null ? NaN : Number(hourRaw)
  const hour = Number.isFinite(hourNum) ? hourNum : undefined
  const jobs = planForDate(date, hour)
  return NextResponse.json({ ok: true, date: date || todayUtc(), count: jobs.length, jobs })
}
