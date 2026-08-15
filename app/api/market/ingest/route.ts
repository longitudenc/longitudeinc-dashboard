// app/api/ingest/address-quality/route.ts
//
// Ingest per-salon Customer Address Quality (% Good / Improve / Bad) and upsert
// into the dedicated SalonCAQData tab, keyed on (periodKey, salonNum). Kept
// separate from SalonSummaryData because upsertSheet rewrites whole rows — a
// second writer on a shared tab would blank the other's columns.
//
// periodKey uses the same "Mon YY" format as lib/salon-month.ts (e.g. "Jun 26"),
// so it joins to SalonSummaryData / BonusData on (periodKey, salonNum). caq*
// values are stored as raw decimals (0.692 = 69.2%); the dashboard formats at read.
//
// Auth: ?secret=<CRON_SECRET>  or  Authorization: Bearer <CRON_SECRET>.
// The monthly GitHub Action posts here server-to-server. CORS is left open so
// the manual browser-console fallback can still POST cross-origin if ever needed;
// the secret is what actually gates writes.
//
// POST body: { "rows": [ { periodKey, periodLabel, salonNum, salonName,
//                          caqGood, caqImprove, caqBad } , ... ] }

import { NextResponse } from 'next/server'
import { upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SALON_CAQ_TAB = 'SalonCAQData'
const SALON_CAQ_COLUMNS = [
  'periodKey', 'periodLabel', 'salonNum', 'salonName',
  'caqGood', 'caqImprove', 'caqBad', 'scrapedAt',
] as const

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  return new URL(request.url).searchParams.get('secret') === expected
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: CORS })
  }

  let body: any
  try { body = await request.json() }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400, headers: CORS }) }

  const rowsIn = Array.isArray(body?.rows) ? body.rows : null
  if (!rowsIn) {
    return NextResponse.json({ ok: false, error: 'body.rows[] required' }, { status: 400, headers: CORS })
  }

  const scrapedAt = new Date().toISOString()
  const rows: Record<string, any>[] = []
  for (const r of rowsIn) {
    const periodKey = String(r?.periodKey ?? '').trim()
    const salonNum = String(r?.salonNum ?? '').trim()
    if (!periodKey || !salonNum) continue // key columns are mandatory
    rows.push({
      periodKey,
      periodLabel: String(r?.periodLabel ?? periodKey).trim(),
      salonNum,
      salonName: String(r?.salonName ?? '').trim(),
      caqGood: r?.caqGood ?? '',
      caqImprove: r?.caqImprove ?? '',
      caqBad: r?.caqBad ?? '',
      scrapedAt,
    })
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'no valid rows (need periodKey + salonNum)' }, { status: 400, headers: CORS })
  }

  try {
    const res = await upsertSheet(SALON_CAQ_TAB, [...SALON_CAQ_COLUMNS], ['periodKey', 'salonNum'], rows)
    return NextResponse.json(
      { ok: true, tab: SALON_CAQ_TAB, received: rowsIn.length, written: rows.length, ...res },
      { headers: CORS },
    )
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500, headers: CORS })
  }
}
