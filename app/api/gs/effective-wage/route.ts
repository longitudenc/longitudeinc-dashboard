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
// A WEEKLY SERIES comes back alongside the monthly one, ON THE PERSON and
// nowhere else. `wk` carries floor hours plus each pay component, one number
// per week, aligned to `weekEnds`. Company, salon and composition lines are all
// SUMMED FROM THESE in the browser.
//
// It used to also send a pre-aggregated weekly series by salon, which was
// smaller. It had to go: anything pre-aggregated here cannot be filtered there,
// so the moment the screen grew a "leavers in or out" switch the pre-aggregate
// silently ignored it. One source that everything sums from is worth the bytes.
//
// The monthly bonus is spread across that month's weeks by floor hours -- the
// same rule that splits it across a partial month, applied one level finer. It
// makes the bonus component of a weekly line smoother than reality: the money
// arrives once a month, and the chart says so.
//
// PAID TIME OFF is reported but never counted. Vacation and holiday hours earn
// base wage and nothing else, so they belong in neither half of a floor-hour
// wage -- but they are real money the person receives ($74,162 across the
// estate so far this year), and a compensation screen that cannot see them at
// all is not telling the whole truth either. They come back as their own
// figures for a screen to show beside the wage rather than inside it.
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
// THE OVERTIME PREMIUM AND SIX-DAY PAY ARE IN IT, recovered rather than read.
// SD_PAYROLL has no column for either: SD3 files six-day inside "All Other
// Incentives", which is not scraped. But it does store TWO effective-wage
// columns per row, and they turn out to be complete:
//
//   effectiveWageNoOt x hoursWorked = subTotalPay + every incentive
//   effectiveWageOt   x hoursWorked = the same, plus the overtime premium
//
// So the incentives we do not have a column for are the RESIDUAL of the first,
// and the overtime premium is the DIFFERENCE between the two. Checked against
// 2026: the residual is zero on 3,228 rows, positive on 1,975, and where it is
// positive it clusters on round per-floor-hour rates -- $2.00 on 420 rows,
// $1.00 on 158, $3.00 on 34 -- which is exactly the shape of the six-day rule
// ("$rate per floor hour for the week"). That is $40,438 of incentive and
// $3,050 of overtime premium this year that used to be invisible.
//
// IT IS DERIVED, NOT READ, and the response says so. The rate columns are
// stored to the cent, so multiplying by ~30 hours leaves about 15 cents of
// rounding on a row; anything under 50 cents is treated as noise and dropped.
// 22 rows of 5,225 come out negative, worst -$94, and are left as they fall --
// a correction is as real as a payment.
//
// VACATION AND HOLIDAY PAY IS IN IT TOO, as its own bucket, in the numerator
// over floor hours. It is earned by working the floor even though it is not
// worked on the floor. Putting the hours in as well would answer a different
// question -- what an hour of anything is worth -- and pull the number toward
// base wage; leaving it out entirely made the floor hour look cheaper than it
// is. The one thing to know is that a short window containing somebody's
// vacation week will read high, because the pay lands in a window the hours
// it accrued over do not.
//
// SCOPE. Pay is the most sensitive thing here, so this uses seesEmployee --
// the same rule behind disciplinary points and reviews. You always see
// yourself; an AM or manager sees the people homed at their salons; office,
// maintenance and anyone unscoped see only themselves.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
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
  other: number; overtime: number; pto: number
}

interface Bucket {
  floorHours: number; nonFloorHours: number
  /** Vacation + holiday hours, and what they paid at base wage. */
  ptoHours: number; ptoPay: number
  floorBasePay: number; productivity: number; product: number; newReturn: number
  /** Six-day and anything else SD3 files under All Other Incentives. Derived. */
  otherIncentives: number
  /** The half-time premium, at SD3's own blended rate. Derived. */
  overtimePremium: number
  bonus: number; tips: number
  /** Distinct weeks with floor time. The denominator for average weekly hours:
   *  dividing a month by a flat 4.33 would report a starter who worked two
   *  weeks of March as a half-time employee all month. */
  weeks: Set<string>
}
const emptyBucket = (): Bucket => ({
  floorHours: 0, nonFloorHours: 0, ptoHours: 0, ptoPay: 0,
  floorBasePay: 0, productivity: 0, product: 0, newReturn: 0,
  otherIncentives: 0, overtimePremium: 0, bonus: 0, tips: 0,
  weeks: new Set<string>(),
})
const bucketEarned = (b: Bucket) =>
  b.floorBasePay + b.productivity + b.product + b.newReturn
  + b.otherIncentives + b.overtimePremium + b.bonus + b.tips + b.ptoPay

/**
 * What SD3 paid that we have no column for.
 *   residual = effectiveWageNoOt x hoursWorked - (subTotalPay + the three incentives)
 *   premium  = (effectiveWageOt - effectiveWageNoOt) x hoursWorked
 * Both rate columns are stored to the cent, so a thirty-hour row carries about
 * fifteen cents of rounding either way -- below the floor these are noise.
 */
function derivedPay(r: Record<string, any>) {
  const worked = N(r.totalHoursWorked)
  if (worked <= 0) return { other: 0, overtime: 0 }
  const noOt = N(r.effectiveWageNoOt), withOt = N(r.effectiveWageOt)
  if (noOt <= 0) return { other: 0, overtime: 0 }
  const known = N(r.subTotalPay) + N(r.productivityIncentive)
    + N(r.productIncentive) + N(r.newReturnIncentive)
  const other = noOt * worked - known
  const overtime = (withOt - noOt) * worked
  return {
    other: Math.abs(other) < 0.5 ? 0 : other,
    overtime: Math.abs(overtime) < 0.5 ? 0 : overtime,
  }
}

export async function GET(req: Request) {
  // view.wages first (who may see pay at all), then seesEmployee below (whose).
  // A salon manager has scope over their salon's people but not this.
  const gate = await requireCapability('view.wages')
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
    // Termination travels with the person so a screen can offer to leave
    // leavers out. It is a flag, never a filter here: a leaver's hours and pay
    // are part of what the year actually cost, and dropping them server-side
    // would make the report stop reconciling to payroll.
    const gone = new Map<string, string>()
    for (const p of profiles) {
      const gid = S(p.globalId)
      if (!gid) continue
      homeSalon.set(gid, S(p.homeStoreNum))
      if (S(p.inactive).toLowerCase() === 'true') gone.set(gid, S(p.inactiveDate))
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

      const extra = derivedPay(r)
      for (const t of targets) {
        t.otherIncentives += extra.other
        t.overtimePremium += extra.overtime
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
        const pto = N(r.vacationHours) + N(r.holidayHours)
        t.ptoHours += pto
        t.ptoPay += pto * wage
      }
      if (mk !== null) {
        recs.push({
          gid, weekEnd: S(r.weekEnd), monthKey: mk, floor,
          base: floor * wage,
          productivity: N(r.productivityIncentive),
          product: N(r.productIncentive),
          newReturn: N(r.newReturnIncentive),
          tips: N(r.totalTips),
          other: extra.other,
          overtime: extra.overtime,
          pto: (N(r.vacationHours) + N(r.holidayHours)) * wage,
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
        ptoHours: r2(b.ptoHours),
        ptoPay: r2(b.ptoPay),
        base: r2(b.floorBasePay),
        productivity: r2(b.productivity),
        product: r2(b.product),
        newReturn: r2(b.newReturn),
        otherIncentives: r2(b.otherIncentives),
        overtimePremium: r2(b.overtimePremium),
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
        inactive: gone.has(a.globalId),
        inactiveDate: gone.get(a.globalId) || '',
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

    // Per person, per week: floor hours and every pay component. Six arrays
    // rather than two, because the composition view has to be filterable the
    // same way every other view is.
    const zeros = () => new Array(weekEnds.length).fill(0)
    interface Wk { h: number[]; base: number[]; tips: number[]; prod: number[]; bonus: number[]; other: number[]; pto: number[] }
    const personWk = new Map<string, Wk>()
    const wkOf = (gid: string): Wk => {
      let w = personWk.get(gid)
      if (!w) personWk.set(gid, w = { h: zeros(), base: zeros(), tips: zeros(), prod: zeros(), bonus: zeros(), other: zeros(), pto: zeros() })
      return w
    }
    for (const rc of recs) {
      const i = wIndex.get(rc.weekEnd)
      if (i === undefined) continue
      const w = wkOf(rc.gid)
      w.h[i] += rc.floor
      w.base[i] += rc.base
      w.tips[i] += rc.tips
      w.prod[i] += rc.productivity
      // Product, new/return, six-day and the overtime premium are one line on
      // screen: they are what is left after base, tips, productivity and the
      // monthly bonus, and separating four near-nil components taught nothing.
      w.other[i] += rc.product + rc.newReturn + rc.other + rc.overtime
      w.pto[i] += rc.pto
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
      const w = wkOf(aw.gid)
      for (const rc of list) {
        const i = wIndex.get(rc.weekEnd)
        if (i !== undefined) w.bonus[i] += aw.amount * (rc.floor / tot)
      }
    }

    // Onto the people themselves, rounded once at the end so a sum of weeks
    // still lands on the person's total. `g` is kept as the sum of the parts so
    // a caller that only wants the line does not have to add five arrays up.
    for (const p of people) {
      const w = personWk.get(p.globalId)
      if (!w) { (p as any).wk = { h: zeros(), g: zeros(), base: zeros(), tips: zeros(), prod: zeros(), bonus: zeros(), other: zeros(), pto: zeros() }; continue }
      ;(p as any).wk = {
        h: w.h.map(r2),
        g: w.h.map((_, i) => r2(w.base[i] + w.tips[i] + w.prod[i] + w.bonus[i] + w.other[i] + w.pto[i])),
        base: w.base.map(r2), tips: w.tips.map(r2), prod: w.prod.map(r2),
        bonus: w.bonus.map(r2), other: w.other.map(r2), pto: w.pto.map(r2),
      }
    }

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
      people,
      scopeAverage: totFloor > 0 ? r2(totEarned / totFloor) : null,
      scopeFloorHours: r2(totFloor),
      excludes: [],
      derived: {
        note: 'Six-day pay and the overtime premium have no column in SD_PAYROLL. They are '
          + 'recovered from the two effective-wage columns, which carry them: the incentives are the '
          + 'residual of effectiveWageNoOt x hours worked, and the premium is the gap between the two '
          + 'rate columns. Both are stored to the cent, so anything under fifty cents on a row is '
          + 'treated as rounding.',
      },
      note: 'The denominator is floor hours only: training, admin, reception, closing, vacation, '
        + 'holiday and sick hours are not in it. Vacation and holiday PAY is, as its own bucket, '
        + 'because it is earned by working the floor even though it is not worked on the floor. '
        + 'A week counts when the Friday it was paid on falls inside the window; a monthly bonus is '
        + 'split by floor hours when only part of its month does.',
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
