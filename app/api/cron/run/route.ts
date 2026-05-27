// app/api/cron/run/route.ts
//
// Single daily cron dispatcher (designed for Vercel Hobby plan — one schedule).
//
// Schedule: 4 AM ET every day
//
// Logic each run:
//   1. Always run /api/scrape/daily (pulls yesterday's data for all 19 salons)
//   2. If today is Saturday, also run /api/scrape/weekly (last completed fiscal week)
//   3. If yesterday was the final Friday of a calendar month, also run
//      /api/scrape/monthly (last completed fiscal month)
//
// Auth: requires Bearer token matching CRON_SECRET (Vercel Cron sends this).
//   Also accepts ?secret= for manual invocation.

import { NextResponse } from 'next/server'
import { todayET, yesterdayET, dayOfWeek, isLastFridayOfMonth } from '@/lib/fiscal'

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

async function invokeScrape(
  endpoint: string,
  requestHost: string,
  secret: string
): Promise<any> {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://${requestHost}`
  const url = `${base}${endpoint}`
  const startedAt = Date.now()
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
    })
    const json = await res.json()
    return {
      endpoint,
      status: res.status,
      durationMs: Date.now() - startedAt,
      ok: res.ok && json.ok !== false,
      result: json,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      endpoint,
      status: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: msg,
    }
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now()

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const secret = process.env.CRON_SECRET!
  const requestHost = request.headers.get('host') || 'localhost:3001'

  const today = todayET()
  const yesterday = yesterdayET()
  const isSaturday = dayOfWeek(today) === 6
  const isMonthEnd = isLastFridayOfMonth(yesterday)

  const fired: string[] = ['daily']
  if (isSaturday) fired.push('weekly')
  if (isMonthEnd) fired.push('monthly')

  console.log(
    `[cron/run] today=${today} yesterday=${yesterday} isSat=${isSaturday} isMonthEnd=${isMonthEnd} → firing: ${fired.join(', ')}`
  )

  const results: any[] = []

  results.push(await invokeScrape('/api/scrape/daily', requestHost, secret))

  if (isSaturday) {
    results.push(await invokeScrape('/api/scrape/weekly', requestHost, secret))
  }

  if (isMonthEnd) {
    results.push(await invokeScrape('/api/scrape/monthly', requestHost, secret))
  }

  const allOk = results.every(r => r.ok)
  const durationMs = Date.now() - startedAt

  console.log(
    `[cron/run] ${allOk ? '✓' : '✗'} fired ${results.length} scrape(s) in ${durationMs}ms`
  )

  return NextResponse.json({
    ok: allOk,
    durationMs,
    today,
    yesterday,
    isSaturday,
    isMonthEnd,
    fired,
    results,
  })
}