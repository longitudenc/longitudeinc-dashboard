// app/api/market/resolve-places/route.ts
//
// Resolver: match each MarketWeekly salon to its Google listing via Places API
// (New) Text Search, capture rating/reviews/business status, upsert GooglePlaces.
//
//   GET /api/market/resolve-places?secret=<CRON_SECRET>
//        → resolve all salons that have coordinates, by proximity
//   GET ...&only=9085
//        → re-resolve a single salon by proximity
//   GET ...&only=4138&query=Great Clips 2744 Celanese Rd Rock Hill SC 29732
//        → resolve ONE salon by a custom text query (TOP match). Works even for
//          a salon with NO coordinates, and writes the discovered lat/lng back
//          into MarketWeekly so the salon appears on the map. Use for new stores.
//   GET ...&only=4138&placeId=ChIJ....
//        → pin ONE salon to an exact place ID (also backfills coords if missing).
//   GET ...&only=4138&lat=34.97718598&lng=-81.02745031
//        → resolve ONE salon by proximity to SUPPLIED coordinates, and force-write
//          those coordinates into MarketWeekly (every week's row) so the salon
//          appears on the market map. Use when a salon has no coords, or has the
//          wrong ones. Combine with &query=... to also constrain the text search.
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
const hasCoords = (s: Salon) => Number.isFinite(s.lat) && Number.isFinite(s.lng)

function rowFrom(salon: Salon, p: any, distM: number | '') {
  return {
    salonNum: salon.salonNum, salonName: salon.name,
    placeId: p.id || '', matchedName: p.displayName?.text || '', matchedAddress: p.formattedAddress || '',
    businessStatus: p.businessStatus || '',
    distanceM: distM === '' ? '' : Math.round(distM as number),
    rating: typeof p.rating === 'number' ? p.rating : '',
    reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : '',
    resolvedAt: new Date().toISOString(),
    _lat: p?.location?.latitude, _lng: p?.location?.longitude,   // internal (for coord backfill)
  }
}

async function resolveOne(key: string, salon: Salon, customQuery?: string) {
  const body: any = { textQuery: customQuery || 'Great Clips', maxResultCount: 10 }
  if (hasCoords(salon)) body.locationBias = { circle: { center: { latitude: salon.lat, longitude: salon.lng }, radius: 2000 } }
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': SEARCH_MASK },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const txt = await res.text().catch(() => ''); return { salonNum: salon.salonNum, salonName: salon.name, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` } }
  const data = await res.json()
  const places: any[] = Array.isArray(data.places) ? data.places : []
  if (places.length === 0) return { salonNum: salon.salonNum, salonName: salon.name, error: 'no match' }

  let best: any, bestD: number | '' = ''
  if (customQuery || !hasCoords(salon)) {
    best = places[0]
    if (hasCoords(salon) && typeof best?.location?.latitude === 'number') bestD = metersBetween(salon.lat, salon.lng, best.location.latitude, best.location.longitude)
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

async function resolveByPlaceId(key: string, salon: Salon, placeId: string) {
  const res = await fetch(DETAILS_URL + encodeURIComponent(placeId), { method: 'GET', headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_MASK } })
  if (!res.ok) { const txt = await res.text().catch(() => ''); return { salonNum: salon.salonNum, salonName: salon.name, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` } }
  const p = await res.json()
  let distM: number | '' = ''
  if (hasCoords(salon) && typeof p?.location?.latitude === 'number') distM = metersBetween(salon.lat, salon.lng, p.location.latitude, p.location.longitude)
  return rowFrom(salon, p, distM)
}

// Write discovered coordinates back into every MarketWeekly row for one salon.
async function backfillCoords(rawObjs: any[], header: string[], salonNum: string, lat: number, lng: number): Promise<number> {
  const mine = rawObjs.filter(o => String(o.salonNum ?? '').trim() === salonNum)
  if (mine.length === 0) return 0
  for (const o of mine) { o.lat = lat; o.lng = lng }
  await upsertSheet(SRC_TAB, header, ['weekEnding', 'salonNum'], mine)
  return mine.length
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

    // Optional explicit coordinates. Both must be present and finite.
    const latRaw = params.get('lat'), lngRaw = params.get('lng')
    const latOv = latRaw == null ? NaN : parseFloat(latRaw)
    const lngOv = lngRaw == null ? NaN : parseFloat(lngRaw)
    const hasCoordOverride = Number.isFinite(latOv) && Number.isFinite(lngOv)
    if ((latRaw != null || lngRaw != null) && !hasCoordOverride) {
      return NextResponse.json({ ok: false, error: 'lat and lng must BOTH be supplied as finite numbers' }, { status: 400 })
    }

    const raw = (await readSheet(SRC_TAB)) || []
    const header: string[] = (raw[0] || []).map((h: any) => String(h))
    const objs = rowsToObjects(raw)
    const weeks = Array.from(new Set(objs.map(o => String(o.weekEnding || '')).filter(Boolean))).sort()
    const latest = weeks[weeks.length - 1]

    let salons: Salon[] = objs
      .filter(o => String(o.weekEnding) === latest)
      .map(o => ({ salonNum: String(o.salonNum || '').trim(), name: String(o.name || '').trim(), lat: parseFloat(o.lat), lng: parseFloat(o.lng) }))
      .filter(s => s.salonNum)
    if (only) salons = salons.filter(s => s.salonNum === only)
    else salons = salons.filter(hasCoords)   // bulk run: only salons that already have coords
    if (salons.length === 0) return NextResponse.json({ ok: false, error: 'no matching salons' }, { status: 400 })

    if ((query || placeId || hasCoordOverride) && salons.length !== 1) {
      return NextResponse.json({ ok: false, error: 'query/placeId/lat+lng overrides require &only=<salonNum>' }, { status: 400 })
    }

    // Remember whether the sheet already had coords BEFORE we apply any override,
    // so the existing coord-backfill rule for coord-less salons still behaves.
    const hadCoordsInSheet = salons.length === 1 ? hasCoords(salons[0]) : false
    if (hasCoordOverride) salons[0] = { ...salons[0], lat: latOv, lng: lngOv }

    let results: any[]
    if (placeId) results = [await resolveByPlaceId(key, salons[0], placeId)]
    else if (query) results = [await resolveOne(key, salons[0], query)]
    else results = await mapLimit(salons, 5, s => resolveOne(key, s))

    // If a single coord-less salon was just resolved, write its coordinates into MarketWeekly.
    let coordsWritten = 0
    if (only && results.length === 1 && results[0].placeId) {
      const r0 = results[0]
      if (hasCoordOverride) {
        // Explicit coords win: write exactly what was supplied (the salon's real
        // location), not the matched listing's pin, so the map is authoritative.
        coordsWritten = await backfillCoords(objs, header, salons[0].salonNum, latOv, lngOv)
      } else if (!hadCoordsInSheet && typeof r0._lat === 'number' && typeof r0._lng === 'number') {
        coordsWritten = await backfillCoords(objs, header, salons[0].salonNum, r0._lat, r0._lng)
      }
    }

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
      coordsWrittenToMarketWeekly: coordsWritten,
      coordSource: hasCoordOverride ? `supplied ${latOv},${lngOv}` : (hadCoordsInSheet ? 'MarketWeekly' : 'discovered'),
      flaggedForReview: flagged.length,
      flagged: flagged.map((r: any) => ({ salonNum: r.salonNum, salonName: r.salonName, matchedName: r.matchedName, matchedAddress: r.matchedAddress, businessStatus: r.businessStatus, distanceM: r.distanceM })),
      errors: errors.map((r: any) => ({ salonNum: r.salonNum, salonName: r.salonName, error: r.error })),
      written: good.slice(0, 5).map((r: any) => ({ salonNum: r.salonNum, matchedName: r.matchedName, matchedAddress: r.matchedAddress, businessStatus: r.businessStatus, lat: r._lat, lng: r._lng, distanceM: r.distanceM, rating: r.rating, reviews: r.reviews })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[market/resolve-places]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
