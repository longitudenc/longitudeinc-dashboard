// app/api/gs/getSalonRoster/route.ts
//
// Returns the current SalonRoster tab as JSON. One row per salon —
// active and historical — so the dashboard can derive its salon universe
// from a single source of truth instead of hardcoded constants.
//
// Used by:
//   - The dashboard at page load (also folded into /api/gs/getAllData)
//   - Future admin UI for editing AM assignments, status, etc.
//
// Cadence: the roster scraper writes weekly; this read-side route reflects
// whatever's in the sheet right now (no caching — roster is tiny).

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { requireSignedIn } from '@/lib/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SALON_ROSTER_TAB = 'SalonRoster'

export async function GET() {
  const gate = await requireSignedIn(); if (!gate.ok) return gate.response
  try {
    const raw = await readSheet(SALON_ROSTER_TAB)
    const rows = rowsToObjects(raw)

    // Normalize numeric/coerced fields so downstream consumers don't have to
    // re-coerce on every read. Everything else passes through as string.
    const roster = rows.map(r => ({
      salonNum: String(r.salonNum || '').trim(),
      storeId: Number(r.storeId) || 0,
      name: String(r.name || '').trim(),
      city: String(r.city || '').trim(),
      state: String(r.state || '').trim(),
      market: String(r.market || '').trim(),
      district: String(r.district || '').trim(),
      entity: String(r.entity || '').trim(),
      openedOn: String(r.openedOn || '').trim(),
      am: String(r.am || '').trim().toLowerCase(),
      status: (String(r.status || 'active').trim().toLowerCase() || 'active') as
        | 'active'
        | 'sold'
        | 'closed',
      closedDate: String(r.closedDate || '').trim(),
      soldDate: String(r.soldDate || '').trim(),
      notes: String(r.notes || '').trim(),
      lastSyncedAt: String(r.lastSyncedAt || '').trim(),
    }))

    return NextResponse.json({
      success: true,
      count: roster.length,
      activeCount: roster.filter(r => r.status === 'active').length,
      roster,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[gs/getSalonRoster] error:', msg)
    return NextResponse.json(
      { success: false, error: msg, roster: [] },
      { status: 500 }
    )
  }
}