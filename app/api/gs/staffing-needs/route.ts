// app/api/gs/staffing-needs/route.ts
//
// STAFF-NEEDS-v1  GET ?weeks=8&cap=38&hire=24
//
// Per salon: the hours it is short and over-covered in a typical week (the
// Staffing trends measure), what its current team could add, and whether that
// closes the gap or it needs to hire. See lib/staffing-needs.ts.
//
// Same permission as Staffing trends -- view.dayofweek, "weekday comparisons
// across a date window" -- and the same salon scoping.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
import { staffingNeeds } from '@/lib/staffing-needs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const clamp = (v: string | null, lo: number, hi: number, dflt: number) => {
  const n = parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

export async function GET(req: Request) {
  const gate = await requireCapability('view.dayofweek')
  if (!gate.ok) return gate.response
  try {
    const q = new URL(req.url).searchParams
    const res = await staffingNeeds(gate.access, {
      weeks: clamp(q.get('weeks'), 2, 26, 8),
      cap: clamp(q.get('cap'), 20, 40, 38),
      hireHrs: clamp(q.get('hire'), 8, 40, 24),
    })
    return NextResponse.json({ success: true, ...res })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
