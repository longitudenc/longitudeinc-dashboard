// app/api/market/resolve-places/route.ts
//
// One-time (re-runnable) resolver: for each salon in MarketWeekly, find its
// Google listing via Places API (New) Text Search biased to the salon's
// coordinates, pick the closest "Great Clips" match, capture its rating +
// review count, and upsert a GooglePlaces tab keyed by salonNum.
//
// Run this once, then EYEBALL the GooglePlaces tab (or this route's JSON):
// anything with a large distanceM is a possible mis-match to fix before we
// wire up the recurring rating pull.
//
//   GET /api/market/resolve-places?secret=<CRON_SECRET>
//   GET /api/market/resolve-places?secret=...&only=3071   (single salon, for spot fixes)
//
// Requires env GOOGLE_PLACES_KEY (Places API New enabled + billing on).

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects, upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SRC_TAB = 'MarketWeekly'
const OUT_TAB = 'GooglePlaces'
const OUT_COLS = ['salonNum','salonName','placeId','matchedName','matchedAddress','distanceM','rating','reviews','resolvedAt']
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText'
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount'
const FLAG_DISTANCE_M = 400   // matches farther than this get flagged for review

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  return new URL(request.url).searchParams.get('secret') === expected
}

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, t = Math.PI / 180
  const dLat = (bLat - aLat) * t, dLng = (bLng - aLng) * t
  const x = Math.sin(dLat/2)**2 + Math.cos(aLat*t)*Math.cos(bLat*t)*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(x))
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function resolveOne(key: string, salon: { salonNum: string; name: string; lat: number; lng: number }) {
  const body = {
    textQuery: 'Great Clips',
    locationBias: { circle: { center: { latitude: salon.lat, longitude: salon.lng }, radius: 2000 } },
    maxResultCount: 10,
  }
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { salonNum: salon.salonNum, salonName: salon.name, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` }
  }
  const data = await res.json()
  const places: any[] = Array.isArray(data.places) ? data.places : []
  if (places.length === 0) return { salonNum: salon.salonNum, salonName: salon.name, error: 'no match' }

  // pick the closest returned place to the salon's coordinates
  let best: any = null, bestD = Infinity
  for (const p of places) {
    const lat = p?.location?.latitude, lng = p?.location?.longitude
    if (typeof lat !== 'number' || typeof lng !== 'number') continue
    const d = metersBetween(salon.lat, salon.lng, lat, lng)
    if (d < bestD) { bestD = d; best = p }
  }
  if (!best) best = places[0]

  return {
    salonNum: salon.salonNum,
    salonName: salon.name,
    placeId: best.id || '',
    matchedName: best.displayName?.text || '',
    matchedAddress: best.formattedAddress || '',
    distanceM: Number.isFinite(bestD) ? Math.round(bestD) : '',
    rating: typeof best.rating === 'number' ? best.rating : '',
    reviews: typeof best.userRatingCount === 'number' ? best.userRatingCount : '',
    resolvedAt: new Date().toISOString(),
  }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const key = process.env.GOOGLE_PLACES_KEY
  if (!key) return NextResponse.json({ ok: false, error: 'GOOGLE_PLACES_KEY not set' }, { status: 500 })

  try {
    // latest week's salons = the current roster with coordinates
    const objs = rowsToObjects((await readSheet(SRC_TAB)) || [])
    const weeks = Array.from(new Set(objs.map(o => String(o.weekEnding || '')).filter(Boolean))).sort()
    const latest = weeks[weeks.length - 1]
    const only = new URL(request.url).searchParams.get('only')
    let salons = objs
      .filter(o => String(o.weekEnding) === latest)
      .map(o => ({ salonNum: String(o.salonNum || '').trim(), name: String(o.name || '').trim(), lat: parseFloat(o.lat), lng: parseFloat(o.lng) }))
      .filter(s => s.salonNum && Number.isFinite(s.lat) && Number.isFinite(s.lng))
    if (only) salons = salons.filter(s => s.salonNum === only)

    if (salons.length === 0) return NextResponse.json({ ok: false, error: 'no salons with coordinates found' }, { status: 400 })

    const results = await mapLimit(salons, 5, s => resolveOne(key, s))
    const good = results.filter((r: any) => r.placeId)
    const errors = results.filter((r: any) => r.error)
    const flagged = good.filter((r: any) => typeof r.distanceM === 'number' && r.distanceM > FLAG_DISTANCE_M)

    if (good.length) {
      const rows = good.map((r: any) => { const o: Record<string, any> = {}; OUT_COLS.forEach(c => o[c] = (r as any)[c] ?? ''); return o })
      await upsertSheet(OUT_TAB, [...OUT_COLS], ['salonNum'], rows)
    }

    return NextResponse.json({
      ok: true,
      resolved: good.length,
      errored: errors.length,
      flaggedForReview: flagged.length,
      flagged: flagged.map((r: any) => ({ salonNum: r.salonNum, salonName: r.salonName, matchedName: r.matchedName, matchedAddress: r.matchedAddress, distanceM: r.distanceM })),
      errors: errors.map((r: any) => ({ salonNum: r.salonNum, salonName: r.salonName, error: r.error })),
      sample: good.slice(0, 5).map((r: any) => ({ salonNum: r.salonNum, matchedName: r.matchedName, distanceM: r.distanceM, rating: r.rating, reviews: r.reviews })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[market/resolve-places]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 50 })
  }
}
