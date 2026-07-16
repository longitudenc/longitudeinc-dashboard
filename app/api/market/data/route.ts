// app/api/market/data/route.ts
//
// Serves MarketWeekly for the market view (public GET + 5-min cache, mirroring
// /api/data). The whole tab is cached in memory; each request filters to one
// week so the week-selector stays snappy.
//
//   GET /api/market/data              -> latest week's rows + full week list
//   GET /api/market/data?week=YYYY-MM-DD -> that week's rows + full week list
//   GET /api/market/data?all=1        -> every row (for future trend charts)

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAB = 'MarketWeekly'
const CACHE_TTL = 5 * 60 * 1000

// numeric columns to coerce so the client doesn't have to parseFloat everywhere
const NUM_COLS = [
  'lat', 'lng', 'cc', 'ccLY', 'sales', 'salesLY', 'ccChg', 'salesChg',
  'nr', 'rr', 'invoice', 'product', 'payroll', 'waits', 'ssWaits',
  'cph', 'mbc', 'oci', 'newCust',
]

let cache: { rows: Record<string, any>[]; weeks: string[]; timestamp: number } | null = null

async function load() {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) return cache
  const raw = await readSheet(TAB)
  const objs = rowsToObjects(raw || [])
  const rows = objs.map(o => {
    const r: Record<string, any> = { ...o }
    r.salonNum = String(o.salonNum ?? '').trim()
    r.weekEnding = String(o.weekEnding ?? '').trim()
    for (const c of NUM_COLS) {
      const v = o[c]
      if (v === '' || v === null || v === undefined || v === '***') { r[c] = null; continue }
      const n = typeof v === 'number' ? v : parseFloat(String(v))
      r[c] = Number.isFinite(n) ? n : null
    }
    return r
  }).filter(r => r.weekEnding && r.salonNum)

  const weeks = Array.from(new Set(rows.map(r => r.weekEnding))).sort()
  cache = { rows, weeks, timestamp: Date.now() }
  return cache
}

export async function GET(request: Request) {
  try {
    const { rows, weeks } = await load()
    if (weeks.length === 0) {
      return NextResponse.json({ success: true, weeks: [], week: null, rows: [] })
    }

    const url = new URL(request.url)
    if (url.searchParams.get('all') === '1') {
      return NextResponse.json({ success: true, weeks, week: null, rows })
    }

    const requested = url.searchParams.get('week')
    const week = requested && weeks.includes(requested) ? requested : weeks[weeks.length - 1]
    const weekRows = rows.filter(r => r.weekEnding === week)

    return NextResponse.json({ success: true, weeks, week, rows: weekRows })
  } catch (error) {
    console.error('[market/data] error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to load market data' },
      { status: 500 }
    )
  }
}
