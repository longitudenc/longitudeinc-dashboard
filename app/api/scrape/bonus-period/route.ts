// app/api/scrape/bonus-period/route.ts
//
// Manual trigger for the salon-month ("bonus period") scraper. Populates
// SalonSummaryData / BonusData / PayrollConsolidatedData — the tabs the
// Manager/AM/Stylist bonus views read — by pulling SD3's consolidated reports
// over each salon month's [monthStart, monthEnd] range.
//
// Two modes:
//   SINGLE (verification):  ?secret=...&year=2026&month=4&debug=1
//   RANGE  (backfill):      ?secret=...&start=2024-01&end=2026-05
//
// A wide backfill takes several minutes; RUN LOCALLY (`npm run dev`) so it
// isn't capped by Vercel's serverless timeout. Fully idempotent — re-run any
// month/range safely; rows update in place (keys: periodKey+salonNum / +globalId).
//
// Scope note: uses SD3's current salon list (like the weekly backfill), so a
// sold salon's pre-sale periods are not included — intentional, matches existing.

import { NextResponse } from 'next/server'
import { runBonusPeriodForMonth, backfillBonusPeriods } from '@/lib/bonus-period'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // honored locally; serverless caps lower

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

// Parse "YYYY-MM" → { y, m }. Returns null if malformed.
function parseYM(s: string | null): { y: number; m: number } | null {
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{1,2})$/)
  if (!m) return null
  const y = parseInt(m[1], 10)
  const mo = parseInt(m[2], 10)
  if (mo < 1 || mo > 12) return null
  return { y, m: mo }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const p = url.searchParams
  const debug = p.get('debug') === '1' || p.get('debug') === 'true'

  // SINGLE month
  const yearParam = p.get('year')
  const monthParam = p.get('month')
  if (yearParam && monthParam) {
    const year = parseInt(yearParam, 10)
    const month = parseInt(monthParam, 10)
    if (!year || month < 1 || month > 12) {
      return NextResponse.json({ ok: false, error: 'bad year/month' }, { status: 400 })
    }
    const r = await runBonusPeriodForMonth(year, month, { debug })
    return NextResponse.json(r)
  }

  // RANGE backfill
  const start = parseYM(p.get('start'))
  const end = parseYM(p.get('end'))
  if (start && end) {
    const reset = p.get('reset') === '1' || p.get('reset') === 'true'
    const out = await backfillBonusPeriods(start, end, { debug, reset })
    const summary = out.periods.map(x => ({
      period: x.periodKey, weeksN: x.weeksN,
      salon: x.salonSummaryRows, bonus: x.bonusRows, payroll: x.payrollRows,
      errors: x.errors.length,
    }))
    return NextResponse.json({ ok: out.ok, reset: out.reset, count: out.periods.length, summary, periods: debug ? out.periods : undefined })
  }

  return NextResponse.json({
    ok: false,
    error: 'provide ?year=YYYY&month=M (single) or ?start=YYYY-MM&end=YYYY-MM (range)',
  }, { status: 400 })
}