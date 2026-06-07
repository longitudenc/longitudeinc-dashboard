// app/api/scrape/roster/route.ts
//
// Salon roster scraper — pulls the current salon list from SD3 (listx) and
// upserts one row per salon into the SalonRoster tab. Used as the source of
// truth for "what salons are in our portfolio right now," AM assignments,
// and active-vs-LY comparison logic.
//
// CRITICAL: this scraper is NON-DESTRUCTIVE to manual fields.
//   SD3-sourced fields (name, city, state, market, district, entity, openedOn)
//   are refreshed every run. Manual fields (am, status, closedDate, soldDate,
//   notes) are preserved across runs. New salons get inserted with sensible
//   defaults; salons no longer in listx are kept in the sheet untouched (so
//   their historical status survives).
//
// Storage: SalonRoster tab, keyed by storeId (stable across renames).
// Cadence: weekly is plenty — roster changes are rare.
//
// Manual override:
//   ?secret=... required (or Bearer header)

import { NextResponse } from 'next/server'
import { authenticate, fetchSalons } from '@/lib/sd3'
import { readSheet, rowsToObjects, upsertSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SALON_ROSTER_TAB = 'SalonRoster'

// Column order = sheet header order. Mix of SD3 fields and manual fields.
const COLUMNS = [
  'salonNum',     // public salon number (e.g. "1304") — SD3-sourced
  'storeId',      // SD3 internal id — SD3-sourced, primary key
  'name',         // plaza name (e.g. "Hilltop Plaza") — SD3-sourced
  'city',         // SD3-sourced
  'state',        // SD3-sourced
  'market',       // SD3-sourced
  'district',     // SD3-sourced
  'entity',       // SD3-sourced
  'openedOn',     // SD3-sourced
  'am',           // MANUAL: which AM owns this salon (cassi/dawn/luann/dana/bridgette/kayla/'')
  'status',       // MANUAL: 'active' | 'sold' | 'closed'
  'closedDate',   // MANUAL: YYYY-MM-DD when closed (status='closed')
  'soldDate',     // MANUAL: YYYY-MM-DD when sold (status='sold')
  'notes',        // MANUAL: free-form notes
  'lastSyncedAt', // bookkeeping: last time SD3 refreshed this row
] as const

// Fields refreshed from SD3 every run. Anything NOT in this list is preserved
// from whatever's already in the sheet (manual fields).
const SD3_FIELDS = new Set([
  'salonNum',
  'name',
  'city',
  'state',
  'market',
  'district',
  'entity',
  'openedOn',
])

// AM defaults — used only when a salon is brand new (never seen before in roster).
// After insert, the `am` field in the sheet is manual and can be edited freely
// without being overwritten on subsequent runs.
const DEFAULT_AM_BY_SALON: Record<string, string> = {
  '1304': 'luann',
  '3015': 'cassi',
  '3025': 'dana',
  '3027': 'dana',
  '3043': 'luann',
  '3053': 'bridgette',
  '3058': 'cassi',
  '3062': 'dawn',
  '3071': 'dawn',
  '3545': 'luann',
  '3685': 'bridgette',
  '4138': 'cassi',
  '7728': 'dana',
  '8725': 'luann',
  '9489': 'dawn',
  '9689': 'bridgette',
  // Unassigned (Kayla's set) — left blank; she picks these up dynamically
  // via the "NAMED set" logic in the dashboard.
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

export async function GET(request: Request) {
  const startedAt = Date.now()

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const results = {
    listxCount: 0,
    existingCount: 0,
    newlyAdded: 0,
    refreshed: 0,
    preserved: 0,
    rowsUpserted: 0,
    inserted: 0,
    updated: 0,
    error: null as string | null,
  }

  try {
    // 1. Read existing roster (if any) — preserves manual fields across runs
    const existingRaw = await readSheet(SALON_ROSTER_TAB)
    const existingObjects = rowsToObjects(existingRaw)
    const existingByStoreId = new Map<string, Record<string, any>>()
    for (const row of existingObjects) {
      const sid = String(row.storeId || '').trim()
      if (sid) existingByStoreId.set(sid, row)
    }
    results.existingCount = existingByStoreId.size

    // 2. Pull fresh from SD3
    const session = await authenticate()
    const salons = await fetchSalons(session)
    results.listxCount = salons.length

    console.log(
      `[scrape/roster] listx returned ${salons.length} salons; ` +
        `${existingByStoreId.size} existing rows in ${SALON_ROSTER_TAB}`
    )

    // 3. Build the merged row set: existing rows + listx rows.
    //    Listx wins on SD3 fields; existing row wins on manual fields.
    const now = new Date().toISOString()
    const seenStoreIds = new Set<string>()
    const outRows: Record<string, any>[] = []

    for (const s of salons) {
      const sid = String(s.storeId)
      seenStoreIds.add(sid)
      const existing = existingByStoreId.get(sid)

      const sd3Row = {
        salonNum: s.salonNum,
        storeId: s.storeId,
        name: s.name,
        city: s.city,
        state: s.state,
        market: s.market,
        district: s.district,
        entity: s.entity,
        openedOn: s.openedOn ?? '',
      }

      if (existing) {
        // Refresh SD3 fields, preserve manual fields
        const merged: Record<string, any> = { ...existing }
        for (const f of SD3_FIELDS) {
          merged[f] = (sd3Row as Record<string, any>)[f]
        }
        merged.storeId = s.storeId
        merged.lastSyncedAt = now
        outRows.push(merged)
        results.refreshed++
      } else {
        // Brand new salon — insert with sensible manual-field defaults
        outRows.push({
          ...sd3Row,
          am: DEFAULT_AM_BY_SALON[s.salonNum] ?? '',
          status: 'active',
          closedDate: '',
          soldDate: '',
          notes: '',
          lastSyncedAt: now,
        })
        results.newlyAdded++
      }
    }

    // 4. Carry over rows for salons that are no longer in listx — they're
    //    historical (sold/closed) and we want to keep them in the sheet so
    //    historical data stays joinable. We do NOT touch their manual fields
    //    or update lastSyncedAt (so you can tell at a glance which rows are
    //    no longer refreshed).
    for (const [sid, existing] of existingByStoreId) {
      if (seenStoreIds.has(sid)) continue
      outRows.push(existing)
      results.preserved++
    }

    // 5. Upsert. Key = storeId. The composite-key upsert handles brand-new
    //    rows (insert) and existing rows (update) atomically.
    if (outRows.length > 0) {
      const upsertResult = await upsertSheet(
        SALON_ROSTER_TAB,
        [...COLUMNS],
        ['storeId'],
        outRows
      )
      results.rowsUpserted = outRows.length
      results.updated = upsertResult.updated
      results.inserted = upsertResult.inserted
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[scrape/roster] ✓ ${results.listxCount} from listx, ` +
        `${results.newlyAdded} new, ${results.refreshed} refreshed, ` +
        `${results.preserved} preserved (no longer in listx), ${durationMs}ms`
    )

    return NextResponse.json({ ok: true, durationMs, ...results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    results.error = msg
    console.error('[scrape/roster] fatal:', msg)
    return NextResponse.json({ ok: false, ...results }, { status: 500 })
  }
}