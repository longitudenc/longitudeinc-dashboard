// app/api/market/resolve-places/route.ts
//
// Resolver: for each salon in MarketWeekly, find its Google listing via Places
// API (New) Text Search biased to the salon's coordinates, pick the closest
// "Great Clips" match, capture rating + reviews + business status, and upsert a
// GooglePlaces tab keyed by salonNum.
//
//   GET /api/market/resolve-places?secret=<CRON_SECRET>
//        → resolve all salons by proximity
//   GET ...&only=9085
//        → re-resolve a single salon by proximity
//   GET ...&only=9085&query=Great Clips 1542 E Broad St Statesville NC 28625
//        → resolve ONE salon by a custom text query (takes the TOP match, not
//          nearest) — use for stragglers a proximity search misses, e.g. a
//          temporarily-closed store.
//   GET ...&only=9085&placeId=ChIJ....
//        → pin ONE salon to an exact place ID (last-resort manual override).
//
// Requires env GOOGLE_PLACES_KEY (Places API New enabled + billing on).

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects, upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SRC_TAB = 'MarketWeekly'
const OUT_TAB = 'GooglePlaces'
const OUT_COLS = ['salonNum','salonName','placeId','matchedName','matchedAddress','businessStatus','distanceM','rating','reviews','resolvedAt']
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText'
const DETAILS_URL = 'https://places.googleapis.com/v1/places/'
const SEARCH_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.rating,places.userRatingCount'
const DETAILS_MASK = 'id,displayName,formattedAddress,location,businessStatus,rating,userRatingCount'
const FLAG_DISTANCE_M = 400

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

type Salon = { salonNum: string; name: string; lat: number; lng: number }

function rowFrom(salon: Salon, p: any, distM: number | '') {
  return {
    salonNum: salon.salonNum,
    salonName: salon.name,
    placeId: p.id || '',
    matchedName: p.displayName?.text || '',
    matchedAddress: p.formattedAddress || '',
    businessStatus: p.businessStatus || '',
    distanceM: distM === '' ? '' : Math.round(distM as number),
    rating: typeof p.rating === 'number' ? p.rating : '',
    reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : '',
    resolvedAt: new Date().toISOString(),
  }
}

// Text search. customQuery => take the TOP (most relevant) result; otherwise the
// closest "Great Clips" to the salon's coordinates.
async function resolveOne(key: string, salon: Salon, customQuery?: string) {
  const body: any = {
    textQuery: customQuery || 'Great Clips',
    locationBias: { circle: { center: { latitude: salon.lat, longitude: salon.lng }, radius: 2000 } },
    maxResultCount: 10,
  }
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': SEARCH_MASK },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { salonNum: salon.salonNum, salonName: salon.name, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` }
  }
  const data = await res.json()
  const places: any[] = Array.isArray(data.places) ? data.places : []
  if (places.length === 0) return { salonNum: salon.salonNum, salonName: salon.name, error: 'no match' }

  let best: any, bestD: number | '' = ''
  if (customQuery) {
    best = places[0]  // trust relevance for an explicit query
    const lat = best?.location?.latitude, lng = best?.location?.longitude
    if (typeof lat === 'number' && typeof lng === 'number') bestD = metersBetween(salon.lat, salon.lng, lat, lng)
  } else {
    let d = Infinity
    for (const p of places) {
      const lat = p?.location?.latitude, lng = p?.location?.longitude
      if (typeof lat !== 'number' || typeof lng !== 'number') continue
      const dist = metersBetween(salon.lat, salon.lng, lat, lng)
      if (dist < d) { d = dist; best = p }
    }
    if (!best) best = places[0]
    bestD = Number.isFinite(d) ? d : ''
  }
  return rowFrom(salon, best, bestD)
}

// Pin to an exact place ID (Place Details).
async function resolveByPlaceId(key: string, salon: Salon, placeId: string) {
  const res = await fetch(DETAILS_URL + encodeURIComponent(placeId), {
    method: 'GET',
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_MASK },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { salonNum: salon.salonNum, salonName: salon.name, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` }
  }
  const p = await res.json()
  let distM: number | '' = ''
  const lat = p?.location?.latitude, lng = p?.location?.longitude
  if (typeof lat === 'number' && typeof lng === 'number') distM = metersBetween(salon.lat, salon.lng, lat, lng)
  return rowFrom(salon, p, distM)
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const key = process.env.GOOGLE_PLACES_KEY
  if (!key) return NextResponse.json({ ok: false, error: 'GOOGLE_PLACES_KEY not set' }, { status: 500 })

  try {
    const params = new URL(request.url).searchParams
    const only = params.get('only')
    const query = params.get('query') || undefined
    const placeId = params.get('placeId') || undefined

    const objs = rowsToObjects((await readSheet(SRC_TAB)) || [])
    const weeks = Array.from(new Set(objs.map(o => String(o.weekEnding || '')).filter(Boolean))).sort()
    const latest = weeks[weeks.length - 1]
    let salons: Salon[] = objs
      .filter(o => String(o.weekEnding) === latest)
      .map(o => ({ salonNum: String(o.salonNum || '').trim(), name: String(o.name || '').trim(), lat: parseFloat(o.lat), lng: parseFloat(o.lng) }))
      .filter(s => s.salonNum && Number.isFinite(s.lat) && Number.isFinite(s.lng))
    if (only) salons = salons.filter(s => s.salonNum === only)
    if (salons.length === 0) return NextResponse.json({ ok: false, error: 'no matching salons with coordinates' }, { status: 400 })

    if ((query || placeId) && salons.length !== 1) {
      return NextResponse.json({ ok: false, error: 'query/placeId overrides require &only=<salonNum>' }, { status: 400 })
    }

    let results: any[]
    if (placeId) results = [await resolveByPlaceId(key, salons[0], placeId)]
    else if (query) results = [await resolveOne(key, salons[0], query)]
    else results = await mapLimit(salons, 5, s => resolveOne(key, s))

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
      flagged: flagged.map((r: any) => ({ salonNum: r.salonNum, salonName: r.salonName, matchedName: r.matchedName, matchedAddress: r.matchedAddress, businessStatus: r.businessStatus, distanceM: r.distanceM })),
      errors: errors.map((r: any) => ({ salonNum: r.salonNum, salonName: r.salonName, error: r.error })),
      written: good.slice(0, 5).map((r: any) => ({ salonNum: r.salonNum, matchedName: r.matchedName, matchedAddress: r.matchedAddress, businessStatus: r.businessStatus, distanceM: r.distanceM, rating: r.rating, reviews: r.reviews })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[market/resolve-places]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
