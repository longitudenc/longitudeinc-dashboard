// app/api/market/ingest/route.ts
//
// Market Compare weekly ingest — receives already-parsed rows from the local
// pipeline (append_market_week.py) and upserts them into MarketWeekly via the
// service account. This replaces the laptop's OAuth Sheets write, so the local
// side no longer needs credentials.json / token.pickle at all.
//
// Auth:    ?secret=<CRON_SECRET>  OR  Authorization: Bearer <CRON_SECRET>
// Body:    { "weekEnding": "YYYY-MM-DD", "columns": [...], "rows": [[...], ...] }
//          - columns: the header names for each value in a row (order-independent
//            mapping by name; the laptop sends its HEADER list)
//          - rows: array of value-arrays aligned to columns
// Storage: MarketWeekly tab, upserted by (weekEnding, salonNum) — re-posting a
//          week overwrites that week's rows rather than duplicating.

import { NextResponse } from 'next/server'
import { upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MARKET_TAB = 'MarketWeekly'

// Canonical column order for the MarketWeekly tab (matches the laptop HEADER).
const MARKET_COLUMNS = [
  'weekEnding', 'salonNum', 'name', 'do', 'lat', 'lng',
  'cc', 'ccLY', 'sales', 'salesLY', 'ccChg', 'salesChg',
  'nr', 'rr', 'invoice', 'product', 'payroll',
  'waits', 'ssWaits', 'cph', 'mbc', 'oci', 'newCust',
]

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(request: Request) {
  const startedAt = Date.now()

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }

  const weekEnding = String(body?.weekEnding ?? '').trim()
  if (!WEEK_RE.test(weekEnding)) {
    return NextResponse.json(
      { ok: false, error: 'weekEnding must be YYYY-MM-DD' },
      { status: 400 }
    )
  }

  const rows: any[] = Array.isArray(body?.rows) ? body.rows : []
  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'no rows' }, { status: 400 })
  }

  // Header names for each value in a row. Default to canonical order if the
  // caller didn't send its own columns list.
  const columns: string[] = Array.isArray(body?.columns) && body.columns.length
    ? body.columns.map((c: any) => String(c).trim())
    : [...MARKET_COLUMNS]

  const salonIdx = columns.indexOf('salonNum')
  if (salonIdx === -1) {
    return NextResponse.json(
      { ok: false, error: "columns must include 'salonNum'" },
      { status: 400 }
    )
  }

  // Zip each value-array into an object keyed by column name, then project onto
  // the canonical schema. weekEnding is stamped authoritatively from the top
  // level so every row lands under the same week regardless of row content.
  const objects: Record<string, any>[] = []
  let skipped = 0
  for (const r of rows) {
    if (!Array.isArray(r)) { skipped++; continue }
    const src: Record<string, any> = {}
    for (let i = 0; i < columns.length; i++) src[columns[i]] = r[i] ?? ''

    const salonNum = String(src.salonNum ?? '').trim()
    if (!salonNum) { skipped++; continue }

    const o: Record<string, any> = {}
    for (const col of MARKET_COLUMNS) o[col] = src[col] ?? ''
    o.weekEnding = weekEnding
    o.salonNum = salonNum
    objects.push(o)
  }

  if (objects.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'no valid rows (missing salonNum?)', skipped },
      { status: 400 }
    )
  }

  try {
    const { updated, inserted } = await upsertSheet(
      MARKET_TAB,
      [...MARKET_COLUMNS],
      ['weekEnding', 'salonNum'],
      objects
    )
    const durationMs = Date.now() - startedAt
    console.log(
      `[market/ingest] ✓ ${weekEnding} — ${objects.length} rows ` +
      `(${inserted} inserted, ${updated} updated, ${skipped} skipped), ${durationMs}ms`
    )
    return NextResponse.json({
      ok: true,
      weekEnding,
      received: rows.length,
      written: objects.length,
      inserted,
      updated,
      skipped,
      durationMs,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[market/ingest] fatal:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
