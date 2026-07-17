// app/api/market/ratings/route.ts
//
// Recurring rating refresh: reads the GooglePlaces tab (resolved place IDs) and
// re-fetches each salon's current rating, review count, and business status via
// Places API (New) Place Details, then upserts the tab in place. Name/address/
// distance columns are preserved (only the rating fields + resolvedAt change).
//
//   GET /api/market/ratings?secret=<CRON_SECRET>
//
// Runs monthly via cron (Vercel adds the Bearer CRON_SECRET header automatically)
// or on demand. Requires env GOOGLE_PLACES_KEY.

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects, upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TAB = 'GooglePlaces'
const COLS = ['salonNum','salonName','placeId','matchedName','matchedAddress','businessStatus','distanceM','rating','reviews','resolvedAt']
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

    const now = new Date().toISOString()
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
      r.resolvedAt = now
      updated++
    })

    // write full rows back so nothing else is disturbed
    const outRows = rows.map((r: any) => { const o: Record<string, any> = {}; COLS.forEach(c => o[c] = r[c] ?? ''); return o })
    await upsertSheet(TAB, [...COLS], ['salonNum'], outRows)

    return NextResponse.json({ ok: true, refreshed: updated, errored, total: withId.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[market/ratings]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
