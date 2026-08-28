// app/api/market/ratings-data/route.ts
//
// Lightweight ratings map for the dashboard's salon tables:
//   { "ratings": { "3015": { "rating": 4.3, "reviews": 245, "status": "OPERATIONAL" }, ... } }
// Owner/admin/viewer/AM/manager/office + 5-min cache. Reads the GooglePlaces tab.

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { requireSalonView } from '@/lib/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAB = 'GooglePlaces'
const CACHE_TTL = 5 * 60 * 1000
let cache: { ratings: Record<string, any>; timestamp: number } | null = null

const toNum = (v: any) => { if (v === '' || v == null || v === '***') return null; const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : null }

export async function GET() {
  // Our own salons' Google ratings. Manager and up; not stylists.
  // The dashboard reads this as GRATINGS=(rd&&rd.ratings)||{}, so a refusal
  // degrades to "no ratings shown" rather than breaking the page.
  const gate = await requireSalonView()
  if (!gate.ok) return gate.response
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
