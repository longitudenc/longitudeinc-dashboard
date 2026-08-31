// app/api/market/ratings-data/route.ts
//
// Lightweight ratings map for the dashboard's salon tables:
//   { "ratings": { "3015": { "rating": 4.3, "reviews": 245, "status": "OPERATIONAL" }, ... } }
// Owner/admin/viewer/AM/manager/office + 5-min cache. Reads the GooglePlaces tab.

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { requireCapability } from '@/lib/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAB = 'GooglePlaces'
const HIST_TAB = 'RatingHistory'
// GooglePlaces holds the whole Charlotte market -- 71 places, only 18 of which
// we operate. Everything served here is about OUR salons (the dashboard's
// rating column and the Google Reviews page), so the comparators are filtered
// out. Market-wide comparison lives at /api/market/data, which is a different
// question with a different audience.
const ROSTER_TAB = 'SalonRoster'
const CACHE_TTL = 5 * 60 * 1000
let cache: { ratings: Record<string, any>; history: any[]; timestamp: number } | null = null

const toNum = (v: any) => { if (v === '' || v == null || v === '***') return null; const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : null }

export async function GET() {
  // Our own salons' Google ratings. Manager and up; not stylists.
  // The dashboard reads this as GRATINGS=(rd&&rd.ratings)||{}, so a refusal
  // degrades to "no ratings shown" rather than breaking the page.
  const gate = await requireCapability('view.salondata')
  if (!gate.ok) return gate.response
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return NextResponse.json({ success: true, ratings: cache.ratings, history: cache.history, cached: true })
    }
    // RatingHistory is the month-by-month series the ratings refresh appends to.
    // Shipped alongside the current numbers so the client can show movement
    // without a second round trip. Tolerant of a missing tab.
    // Sold or closed salons drop out too: a store we no longer run is not
    // part of "how are our reviews doing".
    let ours: Set<string> | null = null
    try {
      const roster = rowsToObjects((await readSheet(ROSTER_TAB)) || [])
      const live = roster.filter((r: any) => {
        const st = String(r.status ?? '').trim().toLowerCase()
        return !st || st === 'active'
      })
      const set = new Set(live.map((r: any) => String(r.salonNum ?? '').trim()).filter(Boolean))
      if (set.size) ours = set
    } catch { ours = null }   // no roster -> fall back to returning everything
    const isOurs = (sn: string) => !ours || ours.has(sn)

    let history: any[] = []
    try {
      history = rowsToObjects((await readSheet(HIST_TAB)) || []).map((r: any) => ({
        salonNum: String(r.salonNum ?? '').trim(),
        month: String(r.month ?? '').trim(),
        rating: toNum(r.rating),
        reviews: toNum(r.reviews),
      })).filter((r: any) => r.salonNum && r.month && isOurs(r.salonNum))
    } catch { history = [] }

    const rows = rowsToObjects((await readSheet(TAB)) || [])
    const ratings: Record<string, any> = {}
    for (const r of rows) {
      const sn = String(r.salonNum ?? '').trim(); if (!sn || !isOurs(sn)) continue
      ratings[sn] = { rating: toNum(r.rating), reviews: toNum(r.reviews), status: String(r.businessStatus ?? '').trim() }
    }
    cache = { ratings, history, timestamp: Date.now() }
    return NextResponse.json({ success: true, ratings, history })
  } catch (error) {
    console.error('[market/ratings-data]', error)
    return NextResponse.json({ success: false, ratings: {}, history: [] }, { status: 200 })
  }
}
