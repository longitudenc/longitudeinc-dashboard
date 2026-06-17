// app/api/gs/getDaily/route.ts
//
// On-demand endpoint for the Daily view. Returns salon-level (SD_DAILY) and
// per-stylist (SD_EMP_DAILY) rows for a date window. Signed-in only; rows are
// scoped to the caller's role (AMs get their salons; managers/stylists get none).
//
// NOT part of getAllData — only hit when the Daily tab is opened, so the main
// dashboard load stays fast as these tabs grow.
//
// Usage:
//   /api/gs/getDaily?start=YYYY-MM-DD&end=YYYY-MM-DD   (both required)
//
// Response:
//   { success, start, end,
//     salonDaily: [ {date, storeId, salonNum, customerCount, serviceSales, ...} ],
//     empDaily:   [ {date, salonNum, storeId, payId, globalId, employeeName,
//                    position, floorHours, custCount, hcTime, cph, productPct,
//                    mbc, nonCutMph, productivity, payrollPct} ] }
//
// The UI computes salon-level KPIs from the raw SD_DAILY fields; the per-stylist
// metrics in SD_EMP_DAILY are already computed by SD3 (cph, hcTime, productPct…).

import { NextResponse } from 'next/server'
import { getDailyRange, getShiftsRange, getHalfHourRange } from '@/lib/sheets'
import { requireSignedIn } from '@/lib/require-role'
import { scopeDaily } from '@/lib/scope-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
        { status: 400 }
      )
    }
    if (start > end) {
      return NextResponse.json(
        { success: false, error: 'start must be on or before end' },
        { status: 400 }
      )
    }

    const raw = await getDailyRange(start, end)
    const rawShifts = await getShiftsRange(start, end)
    const rawHalf = await getHalfHourRange(start, end)
    const { salonDaily, empDaily, shifts, halfHour } =
      scopeDaily(raw.salonDaily, raw.empDaily, rawShifts.shifts, rawHalf.halfHour, gate.access)

    return NextResponse.json({
      success: true,
      start,
      end,
      salonDailyCount: salonDaily.length,
      empDailyCount: empDaily.length,
      shiftsCount: shifts.length,
      halfHourCount: halfHour.length,
      salonDaily,
      empDaily,
      shifts,
      halfHour,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
