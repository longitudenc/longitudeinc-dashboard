// app/api/gs/effective-wage/route.ts
//
// EFFECTIVE-WAGE-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET ?year=2026[&globalId=2023-0001-1394]
//
// What an hour ON THE FLOOR is actually worth to a stylist, year to date.
//
// THE DENOMINATOR IS FLOOR HOURS ONLY. Not hours worked, not hours paid.
// Training, admin, reception, closing, vacation, holiday and sick time are all
// paid at base wage and earn no tips and no incentives, so leaving them in
// drags the figure toward base wage and tells a stylist their cutting hour is
// worth less than it is. On this data that is 8.2% of paid time, and it is not
// spread evenly -- somebody with 240 hours of vacation and training would be
// understated far more than a colleague with none.
//
// The numerator matches: floor hours at base wage, plus the three incentives,
// plus tips. Every one of those is earned by being on the floor.
//
// WHAT IS DELIBERATELY NOT IN IT, because SD_PAYROLL does not carry the
// columns and a partial number would be worse than a stated one:
//   • the overtime premium
//   • 6-day pay (SD3 files it inside All Other Incentives)
// Both are small and both are hours-based rather than floor-earned. The
// response says so rather than leaving a reader to assume completeness.
//
// SCOPE. Pay is the most sensitive thing here, so this uses seesEmployee --
// the same rule behind disciplinary points and reviews. You always see
// yourself; an AM or manager sees the people homed at their salons; office,
// maintenance and anyone unscoped see only themselves.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { readSheet, rowsToObjects, getEmployeeProfiles } from '@/lib/sheets'
import { seesEmployee } from '@/lib/scope-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown) => String(v ?? '').trim()
const N = (v: unknown) => { const n = Number(S(v)); return Number.isFinite(n) ? n : 0 }
const r2 = (n: number) => Math.round(n * 100) / 100

/** Paid time that is not floor time. All of it earns base wage and nothing else. */
const NON_FLOOR = [
  'closingHours', 'trainingHours', 'adminHours', 'receptionHours',
  'vacationHours', 'holidayHours', 'sickHours',
] as const

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const url = new URL(req.url)
    const year = S(url.searchParams.get('year')) || String(new Date().getFullYear())
    if (!/^\d{4}$/.test(year)) {
      return NextResponse.json({ success: false, error: 'year must be YYYY' }, { status: 400 })
    }
    const only = S(url.searchParams.get('globalId'))

    const rows = rowsToObjects((await readSheet('SD_PAYROLL')) || [])
      .filter(r => S(r.weekEnd) >= `${year}-01-01` && S(r.weekEnd) <= `${year}-12-31`)

    const profiles = (await getEmployeeProfiles()) as any[]
    const homeSalon = new Map<string, string>()
    for (const p of profiles) {
      const gid = S(p.globalId)
      if (gid) homeSalon.set(gid, S(p.homeStoreNum))
    }

    interface Acc {
      globalId: string; name: string; salons: Set<string>; weeks: Set<string>
      floorHours: number; floorBasePay: number; incentives: number; tips: number
      nonFloorHours: number; lastWage: number; lastWeek: string
    }
    const by = new Map<string, Acc>()

    for (const r of rows) {
      const gid = S(r.globalId)
      if (!gid) continue
      if (only && gid !== only) continue
      if (!seesEmployee(gate.access, gid, homeSalon.get(gid) || '')) continue

      let a = by.get(gid)
      if (!a) by.set(gid, a = {
        globalId: gid, name: S(r.employeeName), salons: new Set(), weeks: new Set(),
        floorHours: 0, floorBasePay: 0, incentives: 0, tips: 0,
        nonFloorHours: 0, lastWage: 0, lastWeek: '',
      })

      const wage = N(r.baseWage)
      const floor = N(r.floorHours)
      a.floorHours += floor
      // Floor time at the wage that applied THAT week, so a raise mid-year is
      // carried correctly instead of being back-applied to January.
      a.floorBasePay += floor * wage
      a.incentives += N(r.productivityIncentive) + N(r.productIncentive) + N(r.newReturnIncentive)
      a.tips += N(r.totalTips)
      for (const k of NON_FLOOR) a.nonFloorHours += N((r as any)[k])
      a.salons.add(S(r.salonNum))
      a.weeks.add(S(r.weekEnd))
      const wk = S(r.weekEnd)
      if (wage > 0 && wk >= a.lastWeek) { a.lastWage = wage; a.lastWeek = wk }
    }

    const people = [...by.values()]
      .map(a => {
        const earned = a.floorBasePay + a.incentives + a.tips
        return {
          globalId: a.globalId,
          name: a.name,
          salons: [...a.salons].filter(Boolean).sort(),
          weeks: a.weeks.size,
          floorHours: r2(a.floorHours),
          nonFloorHours: r2(a.nonFloorHours),
          currentWage: r2(a.lastWage),
          floorBasePay: r2(a.floorBasePay),
          incentives: r2(a.incentives),
          tips: r2(a.tips),
          totalEarned: r2(earned),
          // The headline. Zero floor hours means no answer rather than a
          // divide-by-zero dressed up as $0.00.
          effectiveWage: a.floorHours > 0 ? r2(earned / a.floorHours) : null,
          basePerHour: a.floorHours > 0 ? r2(a.floorBasePay / a.floorHours) : null,
          incentivePerHour: a.floorHours > 0 ? r2(a.incentives / a.floorHours) : null,
          tipsPerHour: a.floorHours > 0 ? r2(a.tips / a.floorHours) : null,
        }
      })
      .sort((x, y) => (y.effectiveWage ?? 0) - (x.effectiveWage ?? 0))

    // A company line for context, over the same people this caller may see --
    // so a manager compares their salon against their salon, not against an
    // average built from rows they are not allowed to know about.
    const totFloor = people.reduce((s, p) => s + p.floorHours, 0)
    const totEarned = people.reduce((s, p) => s + p.totalEarned, 0)

    return NextResponse.json({
      success: true,
      year,
      people,
      scopeAverage: totFloor > 0 ? r2(totEarned / totFloor) : null,
      scopeFloorHours: r2(totFloor),
      excludes: ['overtime premium', '6-day pay'],
      note: 'Floor hours only. Training, admin, reception, closing, vacation, holiday and sick '
        + 'time are excluded from both the hours and the pay, because they earn base wage and '
        + 'no tips or incentives.',
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
