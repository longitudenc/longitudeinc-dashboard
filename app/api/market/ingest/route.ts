// app/api/market/ingest/address-quality/route.ts
//
// Ingest per-salon Customer Address Quality (% Good) pulled from the Great Clips
// Power BI report by the browser-console snippet, and upsert it into a dedicated
// tab. Kept separate from SalonSummaryData because upsertSheet rewrites whole
// rows keyed by (periodKey, salonNum) — a second writer on a shared tab would
// blank the other writer's columns.
//
// periodKey uses the same "Mon YY" format as lib/salon-month.ts (e.g. "Jun 26"),
// so this joins to SalonSummaryData / BonusData on (periodKey, salonNum).
//
// Auth: ?secret=<secret> or Authorization: Bearer <secret>. Accepts a dedicated
// CAQ_INGEST_SECRET (preferred) or CRON_SECRET. CORS is opened so the snippet
// can POST cross-origin from app.powerbi.com; the secret is what gates writes.
//
// POST body: { "rows": [ { periodKey, periodLabel, salonNum, salonName,
//                          caqGood, caqImprove, caqBad } , ... ] }
//   caq* are raw decimals (0.692 = 69.2%). scrapedAt is stamped server-side.

import { NextResponse } from 'next/server'
import { upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SALON_CAQ_TAB = 'SalonCAQData'
const SALON_CAQ_COLUMNS = [
  'periodKey', 'periodLabel', 'salonNum', 'salonName',
  'caqGood', 'caqImprove', 'caqBad', 'scrapedAt',
] as const

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
}

function authed(request: Request): boolean {
  // Accept a dedicated CAQ_INGEST_SECRET (preferred — this is what the monthly
  // browser snippet carries, so a narrow key that can only append CAQ rows), and
  // still honor CRON_SECRET as a fallback. Either secret may arrive as a Bearer
  // header or a ?secret= query param.
  const accepted = [process.env.CAQ_INGEST_SECRET, process.env.CRON_SECRET]
    .filter((s): s is string => !!s)
  if (accepted.length === 0) return false
  const auth = request.headers.get('authorization')
  const url = new URL(request.url)
  const provided = auth?.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : url.searchParams.get('secret')
  if (!provided) return false
  return accepted.includes(provided)
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(request: Request) {
  if (!authed(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: CORS })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400, headers: CORS })
  }

  const rowsIn = Array.isArray(body?.rows) ? body.rows : null
  if (!rowsIn) {
    return NextResponse.json({ ok: false, error: 'expected { rows: [...] }' }, { status: 400, headers: CORS })
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