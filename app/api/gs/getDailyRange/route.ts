// app/api/gs/getDailyRange/route.ts
//
// Read-only reader: returns raw SD_DAILY rows for an arbitrary date range.
// Powers the Day-of-Week view (which needs 6wk / YTD / Rolling-12 / All windows,
// well past the 14-day cap on /api/gs/getDaily).
//
// This endpoint does NOT write, does NOT touch auth/payroll logic, and does NOT
// transform the data — it hands back SD_DAILY rows as objects keyed by header.
// storeId is left intact; the client maps storeId -> salonNum via SalonRoster.
//
// GET /api/gs/getDailyRange?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// ── VERIFY ON YOUR STACK (two things) ───────────────────────────────────────
// 1. The import below assumes `readSheet(tabName)` from '@/lib/sheets' returns the
//    raw Google Sheets `values` (a 2-D string array, header row first) — same shape
//    your other readers consume. If yours returns objects already, drop the
//    header-mapping block and return rows directly.
// 2. SD_DAILY's date column is named `date` and is ISO 'YYYY-MM-DD'. If your tab
//    stores it differently (e.g. M/D/YYYY), normalize in `inRange()` below.

import { NextResponse } from 'next/server'
import { readSheet } from '@/lib/sheets'

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
  try {
    const url = new URL(req.url)
    const start = (url.searchParams.get('start') || '').slice(0, 10)
    const end = (url.searchParams.get('end') || '').slice(0, 10)
    if (!start || !end) {
      return NextResponse.json({ ok: false, error: 'start and end (YYYY-MM-DD) required' }, { status: 400 })
    }

    const values = (await readSheet(SD_DAILY_TAB)) as any[][]
    if (!values || values.length < 2) {
      return NextResponse.json({ ok: true, start, end, count: 0, rows: [] })
    }

    const header: string[] = values[0].map((h) => String(h).trim())
    const dateIdx = header.indexOf('date')

    const rows: Record<string, any>[] = []
    for (let i = 1; i < values.length; i++) {
      const raw = values[i]
      if (!raw || !raw.length) continue
      if (dateIdx >= 0 && !inRange(raw[dateIdx], start, end)) continue
      const obj: Record<string, any> = {}
      for (let c = 0; c < header.length; c++) obj[header[c]] = raw[c] ?? ''
      rows.push(obj)
    }

    return NextResponse.json({ ok: true, start, end, count: rows.length, rows })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
