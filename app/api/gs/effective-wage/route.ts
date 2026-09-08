// app/api/gs/effective-wage/route.ts
//
// EFFECTIVE-WAGE-v2  (Ctrl+F this string to confirm the file saved)
//
//   GET ?start=2026-07-01&end=2026-09-07[&globalId=...]
//   GET ?year=2026[&globalId=2023-0001-1394]      (shorthand for that whole year)
//
// What an hour ON THE FLOOR is actually worth to a stylist, over a date window.
//
// THE WINDOW IS BY WEEK, because payroll is. A week counts if its weekEnd --
// the Friday it was paid on -- falls inside the window. Slicing a week in half
// would put five days of hours against seven days of incentive, so a week is
// either in or it is out, and the response names the weeks it used.
//
// A WEEKLY SERIES comes back alongside the monthly one, at two grains:
//
//   • every person gets `wk.h` and `wk.g` -- floor hours and floor earnings,
//     one number per week, aligned to `weekEnds`. Company and salon lines are
//     SUMMED FROM THESE in the browser rather than sent separately, so the
//     three levels of the chart cannot disagree with each other or with the
//     tables. It is two numbers a week per person; a year of the whole estate
//     is about 13,000 of them.
//   • `weekly` keeps the same weeks broken into base / tips / productivity /
//     bonus / other, by home salon, for the composition view. That is five
//     more numbers a week and only ever read at salon or company level, which
//     is why it is not on the person.
//
// The monthly bonus is spread across that month's weeks by floor hours -- the
// same rule that splits it across a partial month, applied one level finer. It
// makes the bonus component of a weekly line smoother than reality: the money
// arrives once a month, and the chart says so.
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
const MON_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Aug 26" -> "2026-08", or null. The two-digit year is this century. */
function monthKeyOfPeriod(key: string): string | null {
  const m = S(key).toLowerCase().match(/^([a-z]{3})\s*(\d{2})$/)
  if (!m) return null
  const i = MONTHS.indexOf(m[1])
  if (i < 0) return null
  return '20' + m[2] + '-' + String(i + 1).padStart(2, '0')
}

/** A week belongs to the month its Friday falls in: "2026-08-28" -> "2026-08". */
const monthKeyOfWeek = (weekEnd: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(S(weekEnd)) ? S(weekEnd).slice(0, 7) : null

/** Every month key from `a` to `b` inclusive, in order. */
function monthSpan(a: string, b: string): string[] {
  const out: string[] = []
  let y = Number(a.slice(0, 4)), m = Number(a.slice(5, 7))
  const ey = Number(b.slice(0, 4)), em = Number(b.slice(5, 7))
  // A window is a couple of years at most; the counter only guards a bad param.
  for (let i = 0; i < 400 && (y < ey || (y === ey && m <= em)); i++) {
    out.push(y + '-' + String(m).padStart(2, '0'))
    if (++m > 12) { m = 1; y++ }
  }
  return out
}

/** One payroll row, kept so the weekly series can be built after each person's
 *  home salon is known -- a floater's weeks belong to where they are homed, so
 *  the chart and the tables cannot disagree. */
interface Rec {
  gid: string; weekEnd: string; monthKey: string
  floor: number; base: number; productivity: number
  product: number; newReturn: number; tips: number
}

interface Bucket {
  floorHours: number; nonFloorHours: number
  floorBasePay: number; productivity: number; product: number; newReturn: number
  bonus: number; tips: number
  /** Distinct weeks with floor time. The denominator for average weekly hours:
   *  dividing a month by a flat 4.33 would report a starter who worked two
   *  weeks of March as a half-time employee all month. */
  weeks: Set<string>
}
const emptyBucket = (): Bucket => ({
  floorHours: 0, nonFloorHours: 0,
  floorBasePay: 0, productivity: 0, product: 0, newReturn: 0, bonus: 0, tips: 0,
  weeks: new Set<string>(),
})
const bucketEarned = (b: Bucket) =>
  b.floorBasePay + b.productivity + b.product + b.newReturn + b.bonus + b.tips

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const url = new URL(req.url)
    const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
    let start = S(url.searchParams.get('start'))
    let end = S(url.searchParams.get('end'))
    if (!start || !end) {
      const year = S(url.searchParams.get('year')) || String(new Date().getFullYear())
      if (!/^\d{4}$/.test(year)) {
        return NextResponse.json({ success: false, error: 'year must be YYYY' }, { status: 400 })
      }
      start = year + '-01-01'; end = year + '-12-31'
    }
    if (!isDate(start) || !isDate(end) || start > end) {
      return NextResponse.json(
        { success: false, error: 'start and end must be YYYY-MM-DD, start on or before end' },
        { status: 400 })
    }
    const only = S(url.searchParams.get('globalId'))

    const months = monthSpan(start.slice(0, 7), end.slice(0, 7))
    const mIndex = new Map(months.map((k, i) => [k, i]))

    // Read the WHOLE months the window touches, not just the window itself. The
    // rows outside it are never counted -- they exist only to work out what
    // share of a monthly bonus a partial month has actually earned.
    const wide = rowsToObjects((await readSheet('SD_PAYROLL')) || [])
      .filter(r => {
        const mk = S(r.weekEnd).slice(0, 7)
        return mk >= months[0] && mk <= months[months.length - 1]
      })
    const rows = wide.filter(r => S(r.weekEnd) >= start && S(r.weekEnd) <= end)

    const profiles = (await getEmployeeProfiles()) as any[]
    const homeSalon = new Map<string, string>()
    for (const p of profiles) {
      const gid = S(p.globalId)
      if (gid) homeSalon.set(gid, S(p.homeStoreNum))
    }

    interface Acc {
      globalId: string; name: string; salons: Set<string>; weeks: Set<string>
      total: Bucket; months: Bucket[]
      /** Floor hours over each WHOLE month the window touches, in-window or not.
       *  The denominator for prorating a monthly bonus into a partial month. */
      monthFloorAll: Map<string, number>
      /** Floor hours per salon, so a floater can be attributed to where they
       *  actually worked rather than to whichever salon number sorts first. */
      salonHours: Map<string, number>
      lastWage: number; lastWeek: string
    }
    const by = new Map<string, Acc>()
    const recs: Rec[] = []
    const blank = (gid: string, name: string): Acc => ({
      globalId: gid, name, salons: new Set(), weeks: new Set(),
      total: emptyBucket(),
      months: Array.from({ length: months.length }, emptyBucket),
      monthFloorAll: new Map<string, number>(),
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
      const mk = monthKeyOfWeek(S(r.weekEnd))
      const mi = mk === null ? undefined : mIndex.get(mk)
      const targets = mi === undefined ? [a.total] : [a.total, a.months[mi]]

      for (const t of targets) {
        t.floorHours += floor
        // Floor time at the wage that applied THAT week, so a raise mid-year is
        // carried correctly instead of being back-applied to January.
        t.floorBasePay += floor * wage
        t.productivity += N(r.productivityIncentive)
        t.product += N(r.productIncentive)
        t.newReturn += N(r.newReturnIncentive)
        t.tips += N(r.totalTips)
        if (floor > 0) t.weeks.add(S(r.weekEnd))
        for (const k of NON_FLOOR) t.nonFloorHours += N((r as any)[k])
      }
      if (mk !== null) {
        recs.push({
          gid, weekEnd: S(r.weekEnd), monthKey: mk, floor,
          base: floor * wage,
          productivity: N(r.productivityIncentive),
          product: N(r.productIncentive),
          newReturn: N(r.newReturnIncentive),
          tips: N(r.totalTips),
        })
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

    /** Bonus actually awarded to a person for a month, after the partial-month
     *  split. The weekly series spreads each of these over that month's weeks. */
    const awards: { gid: string; monthKey: string; amount: number }[] = []

    // Whole-month floor hours, so a partial month can take its share of a
    // monthly bonus rather than all of it or none of it.
    for (const r of wide) {
      const a = by.get(S(r.globalId))
      if (!a) continue
      const mk = monthKeyOfWeek(S(r.weekEnd))
      if (!mk) continue
      a.monthFloorAll.set(mk, (a.monthFloorAll.get(mk) || 0) + N(r.floorHours))
    }

    // The monthly stylist bonus, onto the month it was earned. Only for people
    // already in the map: a bonus row without a payroll row would divide by
    // zero floor hours, and somebody who earned a bonus in a year they logged
    // no floor time is a data question, not a wage.
    //
    // PRORATED BY FLOOR HOURS when the window covers only part of that month.
    // The bonus is earned by cutting, so the share of the month's cutting that
    // falls inside the window is the share of the bonus that belongs to it. A
    // whole month in the window takes the whole bonus, exactly as before.
    try {
      const bonusRows = rowsToObjects((await readSheet('BonusData')) || [])
      for (const r of bonusRows) {
        const gid = S(r.globalId)
        const a = gid ? by.get(gid) : undefined
        if (!a) continue
        const mk = monthKeyOfPeriod(S(r.periodKey))
        const mi = mk === null ? undefined : mIndex.get(mk)
        if (mk === null || mi === undefined) continue
        const amount = N(r.payout)
        if (!amount) continue
        const whole = a.monthFloorAll.get(mk) || 0
        const share = whole > 0 ? Math.min(1, a.months[mi].floorHours / whole) : 0
        if (share <= 0) continue
        a.total.bonus += amount * share
        a.months[mi].bonus += amount * share
        awards.push({ gid, monthKey: mk, amount: amount * share })
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
        weeks: b.weeks.size,
        avgWeeklyHours: b.weeks.size > 0 ? r2(b.floorHours / b.weeks.size) : null,
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
        currentWage: r2(a.lastWage),
        // shape() supplies `weeks`: weeks with FLOOR time. a.weeks counted any
        // week with a payroll row, including one that was all holiday pay, which
        // would drag an average weekly hours figure down for no reason.
        ...shape(a.total),
        months: a.months.map(shape),
      }))
      .sort((x, y) => (y.effectiveWage ?? 0) - (x.effectiveWage ?? 0))

    // A company line for context, over the same people this caller may see --
    // so a manager compares their salon against their salon, not against an
    // average built from rows they are not allowed to know about.
    const totFloor = people.reduce((s, p) => s + p.floorHours, 0)
    const totEarned = people.reduce((s, p) => s + p.gross, 0)

    // ── the weeks themselves ──────────────────────────────────────────────
    // Taken from the rows this caller may actually see, so every array indexed
    // by week lines up with what is on screen.
    const weekEnds = [...new Set(recs.map(r => r.weekEnd))].sort()
    const wIndex = new Map(weekEnds.map((w, i) => [w, i]))

    // Per person, per week: floor hours and floor earnings. The bonus goes on
    // by the same proportion the weekly salon series uses.
    const zeros = () => new Array(weekEnds.length).fill(0)
    const personWk = new Map<string, { h: number[]; g: number[] }>()
    const wkOf = (gid: string) => {
      let w = personWk.get(gid)
      if (!w) personWk.set(gid, w = { h: zeros(), g: zeros() })
      return w
    }
    for (const rc of recs) {
      const i = wIndex.get(rc.weekEnd)
      if (i === undefined) continue
      const w = wkOf(rc.gid)
      w.h[i] += rc.floor
      w.g[i] += rc.base + rc.productivity + rc.product + rc.newReturn + rc.tips
    }

    // ── the weekly series, by home salon ──────────────────────────────────
    // Built after `people`, because a week belongs to the salon its owner is
    // homed at rather than the salon the row was filed under. Doing it the
    // other way would put a floater's Tuesday in one line of the chart and the
    // same Tuesday in a different row of the table.
    const homeOf = new Map(people.map(p => [p.globalId, p.homeSalon]))
    type Cell = {
      floorHours: number; base: number; productivity: number
      product: number; newReturn: number; bonus: number; tips: number
    }
    const cell = (): Cell => ({ floorHours: 0, base: 0, productivity: 0, product: 0, newReturn: 0, bonus: 0, tips: 0 })
    const weekly = new Map<string, Map<string, Cell>>()
    const at = (wk: string, sn: string) => {
      let row = weekly.get(wk)
      if (!row) weekly.set(wk, row = new Map<string, Cell>())
      let c = row.get(sn)
      if (!c) row.set(sn, c = cell())
      return c
    }
    for (const rc of recs) {
      const c = at(rc.weekEnd, homeOf.get(rc.gid) || '')
      c.floorHours += rc.floor; c.base += rc.base; c.productivity += rc.productivity
      c.product += rc.product; c.newReturn += rc.newReturn; c.tips += rc.tips
    }

    // Each award over the weeks of its month, by floor hours. A month where
    // somebody logged no floor time cannot receive an award in the first place,
    // so there is no zero-hours case to divide by.
    const perPersonMonth = new Map<string, Rec[]>()
    for (const rc of recs) {
      const k = rc.gid + '|' + rc.monthKey
      const list = perPersonMonth.get(k)
      if (list) list.push(rc); else perPersonMonth.set(k, [rc])
    }
    for (const aw of awards) {
      const list = perPersonMonth.get(aw.gid + '|' + aw.monthKey) || []
      const tot = list.reduce((t, rc) => t + rc.floor, 0)
      if (tot <= 0) continue
      const sn = homeOf.get(aw.gid) || ''
      const w = wkOf(aw.gid)
      for (const rc of list) {
        const cut = aw.amount * (rc.floor / tot)
        at(rc.weekEnd, sn).bonus += cut
        const i = wIndex.get(rc.weekEnd)
        if (i !== undefined) w.g[i] += cut
      }
    }

    // Onto the people themselves, rounded once at the end so a sum of weeks
    // still lands on the person's total.
    for (const p of people) {
      const w = personWk.get(p.globalId)
      ;(p as any).wk = w
        ? { h: w.h.map(r2), g: w.g.map(r2) }
        : { h: zeros(), g: zeros() }
    }

    const weeklySeries = [...weekly.keys()].sort().map(wk => {
      const row = weekly.get(wk)!
      const bySalon: Record<string, any> = {}
      for (const [sn, c] of row) {
        bySalon[sn] = {
          floorHours: r2(c.floorHours), base: r2(c.base), productivity: r2(c.productivity),
          product: r2(c.product), newReturn: r2(c.newReturn), bonus: r2(c.bonus), tips: r2(c.tips),
        }
      }
      return { weekEnd: wk, bySalon }
    })

    const label = (k: string) => MON_LABEL[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(2, 4)
    const oneYear = start.slice(0, 4) === end.slice(0, 4)

    return NextResponse.json({
      success: true,
      start, end,
      year: start.slice(0, 4),
      // The months the window touches, in order and parallel to every person's
      // `months` array, so a caller never has to guess what column 0 is. The
      // year is only in the label when the window actually spans two.
      monthKeys: months.map(k => ({
        key: k,
        label: oneYear ? MON_LABEL[Number(k.slice(5, 7)) - 1] : label(k),
        full: label(k),
      })),
      // Every pay week in the window, in order. `people[].wk.h` and `.g` are
      // indexed by this, and so is anything the client derives from them.
      weekEnds,
      weeksInWindow: weekEnds,
      // The same weeks split into their components, by home salon, for the
      // composition view only.
      weekly: weeklySeries,
      people,
      scopeAverage: totFloor > 0 ? r2(totEarned / totFloor) : null,
      scopeFloorHours: r2(totFloor),
      excludes: ['overtime premium', '6-day pay'],
      note: 'Floor hours only. Training, admin, reception, closing, vacation, holiday and sick '
        + 'time are excluded from both the hours and the pay, because they earn base wage and '
        + 'no tips or incentives. A week counts when the Friday it was paid on falls inside the '
        + 'window; a monthly bonus is split by floor hours when only part of its month does.',
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
