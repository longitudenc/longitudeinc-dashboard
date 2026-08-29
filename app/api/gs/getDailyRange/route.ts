// app/api/gs/getDailyRange/route.ts
//
// Read-only reader: returns SD_DAILY rows for an arbitrary date range.
// Powers the Day-of-Week view (which needs 6wk / YTD / Rolling-12 / All windows,
// well past the 14-day cap on /api/gs/getDaily).
//
// AUTHENTICATED AND SCOPED — it was neither until 2026-08-28. It had no session
// check at all, so it returned every salon's daily numbers to anyone who knew
// the URL, signed in or not. The UI hid the Day-of-Week view from most roles;
// this endpoint answered regardless. If you add another reader here, it needs
// BOTH the gate and the scope call below — a filter applied in the browser is
// not a filter.
//
// The scoping policy itself lives in lib/scope-filter.ts, shared with
// /api/gs/getDaily, so the two daily readers cannot drift apart.
//
// GET /api/gs/getDailyRange?start=YYYY-MM-DD&end=YYYY-MM-DD

import { NextResponse } from 'next/server'
import { readSheet, getSalonRoster } from '@/lib/sheets'
import { requireCapability } from '@/lib/require-role'
import { scopeSalonRows } from '@/lib/scope-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SD_DAILY_TAB = 'SD_DAILY'

function inRange(iso: string, start: string, end: string): boolean {
  if (!iso) return false
  const d = String(iso).slice(0, 10)
  return d >= start && d <= end
}

export async function GET(req: Request) {
  const gate = await requireCapability('view.dayofweek')
  if (!gate.ok) return gate.response

  try {
    const url = new URL(req.url)
    const start = (url.searchParams.get('start') || '').slice(0, 10)
    const end = (url.searchParams.get('end') || '').slice(0, 10)
    if (!start || !end) {
      return NextResponse.json({ ok: false, error: 'start and end (YYYY-MM-DD) required' }, { status: 400 })
    }

    const [values, roster] = await Promise.all([
      readSheet(SD_DAILY_TAB) as Promise<any[][]>,
      getSalonRoster(),
    ])
    if (!values || values.length < 2) {
      return NextResponse.json({ ok: true, start, end, count: 0, rows: [] })
    }

    // SD_DAILY keys on storeId only, but every scoping rule is written in terms
    // of salonNum, so attach it here — the same join lib/sheets.ts does. Rows
    // whose store is missing from SalonRoster get salonNum '' and are therefore
    // dropped for a scoped role, which is the safe direction to fail.
    const salonNumByStore: Record<string, string> = {}
    for (const r of roster) {
      const sid = String((r as any).storeId || '').trim()
      if (sid) salonNumByStore[sid] = String((r as any).salonNum || '').trim()
    }

    const header: string[] = values[0].map((h) => String(h).trim())
    const dateIdx = header.indexOf('date')
    const storeIdx = header.indexOf('storeId')

    const rows: Record<string, any>[] = []
    for (let i = 1; i < values.length; i++) {
      const raw = values[i]
      if (!raw || !raw.length) continue
      if (dateIdx >= 0 && !inRange(raw[dateIdx], start, end)) continue
      const obj: Record<string, any> = {}
      for (let c = 0; c < header.length; c++) obj[header[c]] = raw[c] ?? ''
      // Additive: the client still maps storeId -> salonNum itself via
      // SalonRoster, so nothing downstream depends on this field.
      obj.salonNum = storeIdx >= 0 ? (salonNumByStore[String(raw[storeIdx] ?? '').trim()] || '') : ''
      rows.push(obj)
    }

    const scoped = scopeSalonRows(rows, gate.access)
    return NextResponse.json({ ok: true, start, end, count: scoped.length, rows: scoped })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
