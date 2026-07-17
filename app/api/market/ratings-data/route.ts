// app/api/market/ratings-data/route.ts
//
// Lightweight ratings map for the dashboard's salon tables:
//   { "ratings": { "3015": { "rating": 4.3, "reviews": 245, "status": "OPERATIONAL" }, ... } }
// Public GET + 5-min cache, mirroring /api/data. Reads the GooglePlaces tab.

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAB = 'GooglePlaces'
const CACHE_TTL = 5 * 60 * 1000
let cache: { ratings: Record<string, any>; timestamp: number } | null = null

const toNum = (v: any) => { if (v === '' || v == null || v === '***') return null; const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : null }

export async function GET() {
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return NextResponse.json({ success: true, ratings: cache.ratings, cached: true })
    }
    const rows = rowsToObjects((await readSheet(TAB)) || [])
    const ratings: Record<string, any> = {}
    for (const r of rows) {
      const sn = String(r.salonNum ?? '').trim(); if (!sn) continue
      ratings[sn] = { rating: toNum(r.rating), reviews: toNum(r.reviews), status: String(r.businessStatus ?? '').trim() }
    }
    cache = { ratings, timestamp: Date.now() }
    return NextResponse.json({ success: true, ratings })
  } catch (error) {
    console.error('[market/ratings-data]', error)
    return NextResponse.json({ success: false, ratings: {} }, { status: 200 })
  }
}
