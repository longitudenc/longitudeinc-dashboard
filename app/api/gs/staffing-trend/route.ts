// app/api/gs/staffing-trend/route.ts
//
// STAFFING-TREND-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET ?start=YYYY-MM-DD&end=YYYY-MM-DD[&salon=3045]
//
// The half-hour heat map averaged by DAY OF WEEK across a date range, so a
// pattern can be read off it: "Saturdays at 11 we are always short" is a
// scheduling decision; one Saturday is an anecdote.
//
// AGGREGATED HERE, NOT IN THE BROWSER. The existing heat maps average a
// fortnight client-side, which is fine for a fortnight. The range this serves
// is months -- 36,000 demand rows and 28,000 punches at the time of writing --
// and shipping those to average them in a page would be several megabytes to
// produce a grid of 7 x 28 cells. The grid is what travels.
//
// The measure is the same one dHeatMap uses, deliberately: line and busy read
// straight off the invoice clock, floor coverage time-weighted from actual
// punches, idle = worked - busy. A second definition of "understaffed" that
// disagreed with the daily view by a rounding rule would be worse than no
// trend view at all.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
import { getDemandRange, getChkInOutRange, getShiftsRange } from '@/lib/sheets'
import { scopeDaily } from '@/lib/scope-filter'
import { computeStaffingTrend } from '@/lib/staffing-trend'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown) => String(v ?? '').trim()
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

export async function GET(req: Request) {
  // view.dayofweek is exactly this: "weekday comparisons across a date window".
  // Reusing it rather than minting a capability keeps one answer for one idea.
  const gate = await requireCapability('view.dayofweek')
  if (!gate.ok) return gate.response

  try {
    const url = new URL(req.url)
    const start = S(url.searchParams.get('start'))
    const end = S(url.searchParams.get('end'))
    const salon = S(url.searchParams.get('salon'))
    if (!isDate(start) || !isDate(end) || start > end) {
      return NextResponse.json(
        { success: false, error: 'start and end (YYYY-MM-DD, start <= end) are required' },
        { status: 400 })
    }

    const [dm, ck, sh] = await Promise.all([
      getDemandRange(start, end).catch(() => ({ demand: [] as any[] })),
      getChkInOutRange(start, end).catch(() => ({ chkinout: [] as any[] })),
      getShiftsRange(start, end).catch(() => ({ shifts: [] as any[] })),
    ])

    // Same scoping as the daily view, from the same function -- an AM gets
    // their salons here for the same reason they get them there.
    const scoped = scopeDaily([], [], sh.shifts || [], [], dm.demand || [], ck.chkinout || [], gate.access)
    let demand = scoped.demand
    let punches = scoped.chkinout
    let shifts = scoped.shifts
    if (salon) {
      demand = demand.filter((r: any) => S(r.salonNum) === salon)
      punches = punches.filter((r: any) => S(r.salonNum) === salon)
      shifts = shifts.filter((r: any) => S(r.salonNum) === salon)
    }

    // The computation lives in lib/staffing-trend, shared with Staffing needs.
    return NextResponse.json({
      success: true,
      start, end,
      salon: salon || '',
      ...computeStaffingTrend(demand, punches, shifts, salon),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
