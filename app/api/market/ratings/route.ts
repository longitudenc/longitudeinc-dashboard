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
// WEEKLY snapshots, separate from the MONTHLY RatingHistory above. Keeping
// them apart on purpose: /api/market/data reads RatingHistory expecting one
// row per salon per month, and writing weekly rows into it would give that
// view four points where it expects one.
const SNAP_TAB = 'RatingSnapshots'
const SNAP_COLS = ['salonNum','date','rating','reviews','businessStatus']
// The captured review archive. Keyed on reviewId so the weekly run ACCUMULATES:
// Google returns at most 5 reviews per place and cannot be queried
// retroactively, so the archive can only ever grow forwards from the first
// capture. Every week not captured is lost permanently.
const REVIEW_TAB = 'GoogleReviews'
const REVIEW_COLS = ['reviewId','salonNum','salonName','author','stars','text','publishedAt','capturedAt']
const DETAILS_URL = 'https://places.googleapis.com/v1/places/'
const DETAILS_MASK = 'rating,userRatingCount,businessStatus'
// `reviews` returns up to FIVE, most-relevant-first -- a hard Places API limit,
// not a parameter we can raise. Requested ONLY for salons we operate: the other
// 53 rows in GooglePlaces are market comparators whose review text we do not
// want, and reviews sit in a pricier SKU than the plain rating fields.
const REVIEW_MASK = DETAILS_MASK + ',reviews'

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
    const day = nowIso.slice(0, 10)    // YYYY-MM-DD
    let updated = 0, errored = 0
    const captured: Record<string, any>[] = []
    // The first response for one of OUR salons, so a run that captures nothing
    // says why. The workflow prints this endpoint's JSON, so the Actions log
    // shows which fields Google actually returned.
    let debugFields: string[] | null = null
    let reviewsSeen = 0

    // Only our own salons get review text requested.
    let ourSalons = new Set<string>()
    try {
      ourSalons = new Set(rowsToObjects((await readSheet('SalonRoster')) || [])
        .map((r: any) => String(r.salonNum || '').trim()).filter(Boolean))
    } catch { /* no roster -> fall back to ratings only */ }

    await mapLimit(withId, 5, async (r: any) => {
      const isOurs = ourSalons.has(String(r.salonNum || '').trim())
      const res = await fetch(DETAILS_URL + encodeURIComponent(String(r.placeId).trim()), {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': (isOurs ? REVIEW_MASK : DETAILS_MASK) },
      })
      if (!res.ok) { errored++; return }
      const p = await res.json()
      if (typeof p.rating === 'number') r.rating = p.rating
      if (typeof p.userRatingCount === 'number') r.reviews = p.userRatingCount
      if (p.businessStatus) r.businessStatus = p.businessStatus
      r.resolvedAt = nowIso
      updated++

      if (isOurs && !debugFields) debugFields = Object.keys(p || {})
      if (isOurs && Array.isArray(p.reviews)) reviewsSeen += p.reviews.length

      // Reviews. `name` is the stable review resource id, which is what makes
      // the weekly upsert additive instead of duplicating the same five rows.
      for (const rv of (Array.isArray(p.reviews) ? p.reviews : [])) {
        const reviewId = String(rv?.name || '').trim()
        if (!reviewId) continue
        captured.push({
          reviewId,
          salonNum: r.salonNum ?? '',
          salonName: r.salonName ?? '',
          author: String(rv?.authorAttribution?.displayName || '').trim(),
          stars: typeof rv?.rating === 'number' ? rv.rating : '',
          // Empty text is still a real captured review, so it is kept.
          text: String(rv?.text?.text || rv?.originalText?.text || '').trim(),
          publishedAt: String(rv?.publishTime || '').slice(0, 10),
          capturedAt: day,
        })
      }
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

    // 3) weekly rating snapshot
    const snapRows = rows
      .filter((r: any) => String(r.placeId || '').trim())
      .map((r: any) => ({
        salonNum: r.salonNum, date: day,
        rating: r.rating ?? '', reviews: r.reviews ?? '',
        businessStatus: r.businessStatus ?? '',
      }))
    if (snapRows.length) await upsertSheet(SNAP_TAB, [...SNAP_COLS], ['salonNum', 'date'], snapRows)

    // 4) review archive — additive, keyed on the review id
    if (captured.length) await upsertSheet(REVIEW_TAB, [...REVIEW_COLS], ['reviewId'], captured)

    return NextResponse.json({
      ok: true, refreshed: updated, errored, total: withId.length,
      snapshotMonth: month, snapshotRows: histRows.length,
      weeklySnapshotDate: day, weeklySnapshotRows: snapRows.length,
      reviewsCaptured: captured.length,
      ourSalons: ourSalons.size, reviewsSeen,
      // If reviewsCaptured is 0, this shows what Google actually returned.
      fieldsReturned: debugFields,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[market/ratings]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
