// app/api/scrape/inspect/route.ts
//
// RECON ONLY — dumps the RAW SD3 grouped summary (all fields, not just the
// subset we persist) plus a couple of raw daily rows for one salon over a
// date range. Used to identify which SD3 fields produce the Manager Bonus
// report's Productivity inputs (cut count, service minutes, adjusted hours)
// and the discount/redo components.
//
// Usage (local):
//   /api/scrape/inspect?secret=...&storeId=19436&start=2026-04-25&end=2026-05-29
//
// Safe to leave in the repo; requires CRON_SECRET like every scrape route.

import { NextResponse } from 'next/server'
import { authenticate, fetchSalons, fetchGroupedSummary, fetchDailyStoreSummary } from '@/lib/sd3'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const p = new URL(request.url).searchParams
  let storeId = parseInt(p.get('storeId') || '', 10)
  const salonNum = (p.get('salonNum') || '').trim()
  const start = p.get('start') || ''
  const end = p.get('end') || ''
  if ((!storeId && !salonNum) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json(
      { ok: false, error: 'need ?salonNum=3053 (or ?storeId=N) &start=YYYY-MM-DD&end=YYYY-MM-DD' },
      { status: 400 },
    )
  }

  try {
    const session = await authenticate()
    // Resolve salonNum -> storeId so callers don't need the internal SD3 store id.
    if (!storeId && salonNum) {
      const salons = await fetchSalons(session)
      const match = salons.find(s => String(s.salonNum).trim() === salonNum)
      if (!match) {
        return NextResponse.json({ ok: false, error: `salonNum ${salonNum} not found in SD3` }, { status: 404 })
      }
      storeId = match.storeId
    }
    const [grouped, daily] = await Promise.all([
      fetchGroupedSummary(session, storeId, start, end),
      fetchDailyStoreSummary(session, storeId, start, end),
    ])
    return NextResponse.json({
      ok: true,
      salonNum: salonNum || undefined,
      storeId, start, end,
      groupedFieldCount: grouped ? Object.keys(grouped).length : 0,
      grouped, // FULL raw grouped row — every field SD3 returns over the range
      dailyCount: daily.length,
      dailySample: daily.slice(0, 2), // two raw daily rows for field comparison
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
