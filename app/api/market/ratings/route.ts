// app/api/market/ratings/route.ts
//
// Recurring rating refresh: reads GooglePlaces (resolved place IDs), re-fetches
// each salon's current rating / reviews / business status via Place Details,
// upserts GooglePlaces in place, AND appends a monthly snapshot to RatingHistory
// (keyed salonNum + month) so rating/reviews build a month-by-month time series.
//
//   GET /api/market/ratings?secret=<CRON_SECRET>
//
// Monthly via cron; also runnable on demand. Requires env GOOGLE_PLACES_KEY.

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects, upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TAB = 'GooglePlaces'
const HIST_TAB = 'RatingHistory'
const COLS = ['salonNum','salonName','placeId','matchedName','matchedAddress','businessStatus','distanceM','rating','reviews','resolvedAt']
const HIST_COLS = ['salonNum','month','rating','reviews','businessStatus','snapshotAt']
const DETAILS_URL = 'https://places.googleapis.com/v1/places/'
const DETAILS_MASK = 'rating,userRatingCount,businessStatus'

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  return new URL(request.url).searchParams.get('secret') === expected
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const key = process.env.GOOGLE_PLACES_KEY
  if (!key) return NextResponse.json({ ok: false, error: 'GOOGLE_PLACES_KEY not set' }, { status: 500 })

  try {
    const rows = rowsToObjects((await readSheet(TAB)) || [])
    const withId = rows.filter(r => String(r.placeId || '').trim())
    if (withId.length === 0) {
      return NextResponse.json({ ok: false, error: 'no place IDs in GooglePlaces — run resolve-places first' }, { status: 400 })
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const month = nowIso.slice(0, 7)   // YYYY-MM
    let updated = 0, errored = 0

    await mapLimit(withId, 5, async (r: any) => {
      const res = await fetch(DETAILS_URL + encodeURIComponent(String(r.placeId).trim()), {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_MASK },
      })
      if (!res.ok) { errored++; return }
      const p = await res.json()
      if (typeof p.rating === 'number') r.rating = p.rating
      if (typeof p.userRatingCount === 'number') r.reviews = p.userRatingCount
      if (p.businessStatus) r.businessStatus = p.businessStatus
      r.resolvedAt = nowIso
      updated++
    })

    // 1) refresh GooglePlaces (full rows, nothing else disturbed)
    const outRows = rows.map((r: any) => { const o: Record<string, any> = {}; COLS.forEach(c => o[c] = r[c] ?? ''); return o })
    await upsertSheet(TAB, [...COLS], ['salonNum'], outRows)

    // 2) append this month's snapshot (upsert by salonNum+month so a re-run in
    //    the same month overwrites rather than duplicates)
    const histRows = rows
      .filter((r: any) => String(r.placeId || '').trim())
      .map((r: any) => ({
        salonNum: r.salonNum, month,
        rating: r.rating ?? '', reviews: r.reviews ?? '',
        businessStatus: r.businessStatus ?? '', snapshotAt: nowIso,
      }))
    await upsertSheet(HIST_TAB, [...HIST_COLS], ['salonNum', 'month'], histRows)

    return NextResponse.json({ ok: true, refreshed: updated, errored, total: withId.length, snapshotMonth: month, snapshotRows: histRows.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[market/ratings]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
