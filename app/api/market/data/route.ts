// app/api/market/data/route.ts
//
// Serves MarketWeekly for the market view (public GET + 5-min cache). Joins each
// salon's current Google rating / reviews / status from GooglePlaces, and on
// ?all=1 also returns the monthly RatingHistory time series for rating trends.
//
//   GET /api/market/data              -> latest week's rows + week list
//   GET /api/market/data?week=YYYY-MM-DD
//   GET /api/market/data?all=1        -> every row + ratingHistory[]

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAB = 'MarketWeekly'
const RATINGS_TAB = 'GooglePlaces'
const HIST_TAB = 'RatingHistory'
const CACHE_TTL = 5 * 60 * 1000

const NUM_COLS = [
  'lat', 'lng', 'cc', 'ccLY', 'sales', 'salesLY', 'ccChg', 'salesChg',
  'nr', 'rr', 'invoice', 'product', 'payroll', 'waits', 'ssWaits',
  'cph', 'mbc', 'oci', 'newCust',
]

let cache: { rows: Record<string, any>[]; weeks: string[]; ratingHistory: any[]; timestamp: number } | null = null

const toNum = (v: any) => { if (v === '' || v == null || v === '***') return null; const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : null }

async function ratingsMap(): Promise<Record<string, any>> {
  try {
    const rows = rowsToObjects((await readSheet(RATINGS_TAB)) || [])
    const map: Record<string, any> = {}
    for (const r of rows) {
      const sn = String(r.salonNum ?? '').trim(); if (!sn) continue
      map[sn] = { rating: toNum(r.rating), reviews: toNum(r.reviews), googleStatus: String(r.businessStatus ?? '').trim(), placeId: String(r.placeId ?? '').trim() }
    }
    return map
  } catch { return {} }
}

async function ratingHistory(): Promise<any[]> {
  try {
    const rows = rowsToObjects((await readSheet(HIST_TAB)) || [])
    return rows.map(r => ({
      salonNum: String(r.salonNum ?? '').trim(),
      month: String(r.month ?? '').trim(),
      rating: toNum(r.rating),
      reviews: toNum(r.reviews),
    })).filter(r => r.salonNum && r.month)
  } catch { return [] }
}

async function load() {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) return cache
  const [raw, ratings, hist] = await Promise.all([readSheet(TAB), ratingsMap(), ratingHistory()])
  const objs = rowsToObjects(raw || [])
  const rows = objs.map(o => {
    const r: Record<string, any> = { ...o }
    r.salonNum = String(o.salonNum ?? '').trim()
    r.weekEnding = String(o.weekEnding ?? '').trim()
    for (const c of NUM_COLS) r[c] = toNum(o[c])
    const g = ratings[r.salonNum]
    r.rating = g ? g.rating : null
    r.reviews = g ? g.reviews : null
    r.googleStatus = g ? g.googleStatus : ''
    return r
  }).filter(r => r.weekEnding && r.salonNum)

  const weeks = Array.from(new Set(rows.map(r => r.weekEnding))).sort()
  cache = { rows, weeks, ratingHistory: hist, timestamp: Date.now() }
  return cache
}

export async function GET(request: Request) {
  try {
    const { rows, weeks, ratingHistory: hist } = await load()
    if (weeks.length === 0) return NextResponse.json({ success: true, weeks: [], week: null, rows: [], ratingHistory: [] })

    const url = new URL(request.url)
    if (url.searchParams.get('all') === '1') return NextResponse.json({ success: true, weeks, week: null, rows, ratingHistory: hist })

    const requested = url.searchParams.get('week')
    const week = requested && weeks.includes(requested) ? requested : weeks[weeks.length - 1]
    return NextResponse.json({ success: true, weeks, week, rows: rows.filter(r => r.weekEnding === week) })
  } catch (error) {
    console.error('[market/data] error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load market data' }, { status: 500 })
  }
}
