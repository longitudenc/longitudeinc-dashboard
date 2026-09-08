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
// THE STYLIST BONUS IS IN IT, from BonusData, because it is earned by cutting
// and it is not small -- $31,602 across the estate so far this year, and $1,290
// for the top earner. Leaving a monthly bonus out of "what your hour is worth"
// would understate the people who earn the most of it, which is exactly
// backwards for a review conversation. It is attributed to the month it was
// earned rather than smeared across the year.
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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Aug 26" -> 7 (zero-based month), or null. */
function monthOfPeriod(key: string): number | null {
  const m = S(key).toLowerCase().match(/^([a-z]{3})\s*(\d{2})$/)
  if (!m) return null
  const i = MONTHS.indexOf(m[1])
  return i < 0 ? null : i
}

/** A week is attributed to the month its Friday falls in. */
function monthOfWeek(weekEnd: string): number | null {
  const m = S(weekEnd).match(/^\d{4}-(\d{2})-\d{2}$/)
  if (!m) return null
  const i = Number(m[1]) - 1
  return i >= 0 && i < 12 ? i : null
}

interface Bucket {
  floorHours: number; nonFloorHours: number
  floorBasePay: number; productivity: number; product: number; newReturn: number
  bonus: number; tips: number
}
const emptyBucket = (): Bucket => ({
  floorHours: 0, nonFloorHours: 0,
  floorBasePay: 0, productivity: 0, product: 0, newReturn: 0, bonus: 0, tips: 0,
})
const bucketEarned = (b: Bucket) =>
  b.floorBasePay + b.productivity + b.product + b.newReturn + b.bonus + b.tips

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
      total: Bucket; months: Bucket[]
      /** Floor hours per salon, so a floater can be attributed to where they
       *  actually worked rather than to whichever salon number sorts first. */
      salonHours: Map<string, number>
      lastWage: number; lastWeek: string
    }
    const by = new Map<string, Acc>()
    const blank = (gid: string, name: string): Acc => ({
      globalId: gid, name, salons: new Set(), weeks: new Set(),
      total: emptyBucket(),
      months: Array.from({ length: 12 }, emptyBucket),
      salonHours: new Map<string, number>(),
      lastWage: 0, lastWeek: '',
    })

    for (const r of rows) {
      const gid = S(r.globalId)
      if (!gid) continue
      if (only && gid !== only) continue
      if (!seesEmployee(gate.access, gid, homeSalon.get(gid) || '')) continue

      let a = by.get(gid)
      if (!a) by.set(gid, a = blank(gid, S(r.employeeName)))

      const wage = N(r.baseWage)
      const floor = N(r.floorHours)
      const mi = monthOfWeek(S(r.weekEnd))
      const targets = mi === null ? [a.total] : [a.total, a.months[mi]]

      for (const t of targets) {
        t.floorHours += floor
        // Floor time at the wage that applied THAT week, so a raise mid-year is
        // carried correctly instead of being back-applied to January.
        t.floorBasePay += floor * wage
        t.productivity += N(r.productivityIncentive)
        t.product += N(r.productIncentive)
        t.newReturn += N(r.newReturnIncentive)
        t.tips += N(r.totalTips)
        for (const k of NON_FLOOR) t.nonFloorHours += N((r as any)[k])
      }
      const sn = S(r.salonNum)
      if (sn) {
        a.salons.add(sn)
        a.salonHours.set(sn, (a.salonHours.get(sn) || 0) + floor)
      }
      a.weeks.add(S(r.weekEnd))
      const wk = S(r.weekEnd)
      if (wage > 0 && wk >= a.lastWeek) { a.lastWage = wage; a.lastWeek = wk }
    }

    // The monthly stylist bonus, onto the month it was earned. Only for people
    // already in the map: a bonus row without a payroll row would divide by
    // zero floor hours, and somebody who earned a bonus in a year they logged
    // no floor time is a data question, not a wage.
    try {
      const bonusRows = rowsToObjects((await readSheet('BonusData')) || [])
      for (const r of bonusRows) {
        const gid = S(r.globalId)
        const a = gid ? by.get(gid) : undefined
        if (!a) continue
        const key = S(r.periodKey)
        if (!key.endsWith(year.slice(2))) continue
        const amount = N(r.payout)
        if (!amount) continue
        a.total.bonus += amount
        const mi = monthOfPeriod(key)
        if (mi !== null) a.months[mi].bonus += amount
      }
    } catch { /* no bonus tab: the breakdown simply has no bonus line */ }

    const shape = (b: Bucket) => {
      const earned = bucketEarned(b)
      return {
        floorHours: r2(b.floorHours),
        nonFloorHours: r2(b.nonFloorHours),
        base: r2(b.floorBasePay),
        productivity: r2(b.productivity),
        product: r2(b.product),
        newReturn: r2(b.newReturn),
        bonus: r2(b.bonus),
        tips: r2(b.tips),
        gross: r2(earned),
        // Zero floor hours means no answer rather than a divide-by-zero dressed
        // up as $0.00 -- a month somebody did not work should read blank.
        effectiveWage: b.floorHours > 0 ? r2(earned / b.floorHours) : null,
      }
    }

    const people = [...by.values()]
      .map(a => ({
        globalId: a.globalId,
        name: a.name,
        salons: [...a.salons].filter(Boolean).sort(),
        salonHours: Object.fromEntries([...a.salonHours].map(([k, v]) => [k, r2(v)])),
        // Where they worked MOST. A floater genuinely belongs to several, but a
        // report where one person appears in three salon totals cannot be
        // summed, so each is counted once, where most of their hours were.
        homeSalon: [...a.salonHours].sort((x, y) => y[1] - x[1])[0]?.[0] || '',
        weeks: a.weeks.size,
        currentWage: r2(a.lastWage),
        ...shape(a.total),
        months: a.months.map(shape),
      }))
      .sort((x, y) => (y.effectiveWage ?? 0) - (x.effectiveWage ?? 0))

    // A company line for context, over the same people this caller may see --
    // so a manager compares their salon against their salon, not against an
    // average built from rows they are not allowed to know about.
    const totFloor = people.reduce((s, p) => s + p.floorHours, 0)
    const totEarned = people.reduce((s, p) => s + p.gross, 0)

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
