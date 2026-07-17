// app/api/market/data/route.ts
//
// Serves MarketWeekly for the market view (public GET + 5-min cache), now with
// each salon's Google rating / review count / business status joined in from the
// GooglePlaces tab (same rating attached to every week — it's a current snapshot).
//
//   GET /api/market/data              -> latest week's rows + full week list
//   GET /api/market/data?week=YYYY-MM-DD
//   GET /api/market/data?all=1        -> every row

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAB = 'MarketWeekly'
const RATINGS_TAB = 'GooglePlaces'
const CACHE_TTL = 5 * 60 * 1000

const NUM_COLS = [
  'lat', 'lng', 'cc', 'ccLY', 'sales', 'salesLY', 'ccChg', 'salesChg',
  'nr', 'rr', 'invoice', 'product', 'payroll', 'waits', 'ssWaits',
  'cph', 'mbc', 'oci', 'newCust',
]

let cache: { rows: Record<string, any>[]; weeks: string[]; timestamp: number } | null = null

async function ratingsMap(): Promise<Record<string, { rating: number | null; reviews: number | null; googleStatus: string; placeId: string }>> {
  try {
    const rows = rowsToObjects((await readSheet(RATINGS_TAB)) || [])
    const map: Record<string, any> = {}
    for (const r of rows) {
      const sn = String(r.salonNum ?? '').trim()
      if (!sn) continue
      const rating = r.rating === '' || r.rating == null ? null : parseFloat(String(r.rating))
      const reviews = r.reviews === '' || r.reviews == null ? null : parseFloat(String(r.reviews))
      map[sn] = {
        rating: Number.isFinite(rating) ? rating : null,
        reviews: Number.isFinite(reviews) ? reviews : null,
        googleStatus: String(r.businessStatus ?? '').trim(),
        placeId: String(r.placeId ?? '').trim(),
      }
    }
    return map
  } catch {
    return {}   // ratings tab may not exist yet — degrade gracefully
  }
}

async function load() {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) return cache
  const [raw, ratings] = await Promise.all([readSheet(TAB), ratingsMap()])
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
    const g = ratings[r.salonNum]
    r.rating = g ? g.rating : null
    r.reviews = g ? g.reviews : null
    r.googleStatus = g ? g.googleStatus : ''
    return r
  }).filter(r => r.weekEnding && r.salonNum)

  const weeks = Array.from(new Set(rows.map(r => r.weekEnding))).sort()
  cache = { rows, weeks, timestamp: Date.now() }
  return cache
}

export async function GET(request: Request) {
  try {
    const { rows, weeks } = await load()
    if (weeks.length === 0) return NextResponse.json({ success: true, weeks: [], week: null, rows: [] })

    const url = new URL(request.url)
    if (url.searchParams.get('all') === '1') return NextResponse.json({ success: true, weeks, week: null, rows })

    const requested = url.searchParams.get('week')
    const week = requested && weeks.includes(requested) ? requested : weeks[weeks.length - 1]
    return NextResponse.json({ success: true, weeks, week, rows: rows.filter(r => r.weekEnding === week) })
  } catch (error) {
    console.error('[market/data] error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load market data' }, { status: 500 })
  }
}
