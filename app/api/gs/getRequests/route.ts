// app/api/gs/getRequests/route.ts
//
// Single source for the Request tracker. Reads SD_EMP_DAILY for a date window,
// role-scopes it, and aggregates requestCount + custCount into compact
// (stylist, salon, week) buckets. Every surface (Individual measure, Salon
// Performance, Company Overview, Trends, and the dedicated report) rolls these
// same buckets up its own way, so the number is defined in exactly one place.
//
// Request rate is ALWAYS ΣrequestCount / ΣcustCount over the chosen span
// (cc-weighted, never an average of daily rates). Rows whose requestCount is
// blank — a day the invoice feed couldn't measure — are dropped from BOTH sums,
// so the rate reflects only measured days rather than being diluted by fake
// zeros. This is informational only; it is not wired into scoring or bonuses.
//
// Usage:
//   /api/gs/getRequests?start=YYYY-MM-DD&end=YYYY-MM-DD   (both required)
//
// Response:
//   { success, start, end,
//     weeks:  ["2025-01-03", ...],                 // distinct week-ends in range (trend x-axis)
//     names:  { "<globalId>": { n:"Last, First", p:"M", s:"3071" } },
//     cells:  [ { g:"<globalId>", s:"3071", w:"2025-01-03", r:12, c:210 }, ... ] }
//
//   g=globalId  s=salonNum  w=week-ending Friday  r=requests  c=customers
//   Roll up: stylist book = Σ over that g; salon rate = Σ over that s;
//   company = Σ all; trend = the per-week series.

import { NextResponse } from 'next/server'
import { getDailyRange } from '@/lib/sheets'
import { requireSignedIn } from '@/lib/require-role'
import { scopeDaily } from '@/lib/scope-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Week-ending Friday for an ISO date (weeks run Sat→Fri), UTC-safe so there's
// no timezone drift. Every date maps to the Friday that closes its Sat–Fri week.
function weekEndFriday(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const dow = dt.getUTCDay()            // 0=Sun … 5=Fri … 6=Sat
  const offset = (5 - dow + 7) % 7      // days forward to this week's Friday
  dt.setUTCDate(dt.getUTCDate() + offset)
  return dt.toISOString().slice(0, 10)
}

export async function GET(request: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  try {
    const url = new URL(request.url)
    const start = url.searchParams.get('start')
    const end = url.searchParams.get('end')
    if (!start || !end) {
      return NextResponse.json(
        { success: false, error: 'start and end (YYYY-MM-DD) query params are required' },
        { status: 400 },
      )
    }
    if (start > end) {
      return NextResponse.json(
        { success: false, error: 'start must be on or before end' },
        { status: 400 },
      )
    }

    // Only SD_EMP_DAILY is needed; getDailyRange also returns salonDaily, ignored here.
    const { empDaily } = await getDailyRange(start, end)
    // Role scope: AMs see only their salons; managers/stylists see none.
    const scoped = scopeDaily([], empDaily, [], [], [], [], gate.access)
    const rows = scoped.empDaily as any[]

    // (globalId | salonNum | weekEnd) → { r, c }
    const cellMap = new Map<string, { g: string; s: string; w: string; r: number; c: number }>()
    const names: Record<string, { n: string; p: string; s: string }> = {}
    const weekSet = new Set<string>()

    for (const row of rows) {
      const g = String(row.globalId || '').trim()
      const s = String(row.salonNum || '').trim()
      const date = String(row.date || '').slice(0, 10)
      if (!g || !s || !date) continue

      // Blank requestCount = unmeasured day → excluded from both sums.
      const rc = String(row.requestCount ?? '').trim()
      if (rc === '') continue
      const req = Number(rc)
      const cust = Number(String(row.custCount ?? '').trim())
      if (!Number.isFinite(req) || !Number.isFinite(cust)) continue

      const w = weekEndFriday(date)
      weekSet.add(w)
      const key = g + '|' + s + '|' + w
      const cell = cellMap.get(key) || { g, s, w, r: 0, c: 0 }
      cell.r += req
      cell.c += cust
      cellMap.set(key, cell)

      if (!names[g]) {
        names[g] = {
          n: String(row.employeeName || '').trim(),
          p: String(row.position || '').trim(),
          s: s, // first-seen salon; the UI already resolves home salon from the roster
        }
      }
    }

    const weeks = [...weekSet].sort()
    const cells = [...cellMap.values()]

    return NextResponse.json({
      success: true,
      start,
      end,
      weeks,
      names,
      cells,
      cellCount: cells.length,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
