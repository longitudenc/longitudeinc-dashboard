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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown) => String(v ?? '').trim()
const num = (v: unknown) => { const x = Number(S(v)); return Number.isFinite(x) ? x : 0 }
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

/** 'true' / '1' / 'yes', matching hmTrue() in the client. */
const truthy = (v: unknown) => ['true', '1', 'yes'].includes(S(v).toLowerCase())

/** Minutes past midnight from "HH:MM" / "HH:MM:SS" / "H:MM AM". */
function minOfDay(v: unknown): number | null {
  const s = S(v)
  if (!s) return null
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/)
  if (!m) return null
  let h = Number(m[1])
  const mins = Number(m[2])
  const ap = (m[3] || '').toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || mins > 59) return null
  return h * 60 + mins
}

/** Minutes of [a,b] that fall inside half-hour slot hh. */
function overlap(a: number, b: number, hh: number): number {
  const s = hh * 30, e = s + 30
  const ov = Math.min(b, e) - Math.max(a, s)
  return ov > 0 ? ov : 0
}

/**
 * Minutes past midnight out of an SD_SHIFTS timestamp ("2026-07-06T08:30:00.000").
 * Read off the local clock in the string rather than parsed as a Date: these are
 * salon-local wall times with no zone, and letting a Date interpret them would
 * shift a morning shift by however far the server sits from Charlotte.
 */
function shiftMin(v: string): number | null {
  const m = S(v).match(/T(\d{2}):(\d{2})/)
  if (!m) return null
  const h = Number(m[1]), mins = Number(m[2])
  if (h > 23 || mins > 59) return null
  return h * 60 + mins
}

/** Local day of week for a plain YYYY-MM-DD, without timezone drift. */
function dowOf(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getDay()   // 0 = Sunday
}

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

    // The DENOMINATOR is salon-days, not rows. Every (date, salon) that traded
    // at all counts once for every slot, so a half-hour the salon was shut
    // averages toward zero instead of being quietly excluded and reading busy.
    // Salon-days per salon per weekday -- the denominator, per salon.
    const salonDays: Record<string, Record<number, Set<string>>> = {}
    const openDays: Record<number, Set<string>> = {}
    const salonsSeen = new Set<string>()
    for (const r of demand) {
      const d = S(r.date).slice(0, 10), sn = S(r.salonNum)
      if (!isDate(d) || !sn) continue
      salonsSeen.add(sn)
      const dow = dowOf(d)
      ;(openDays[dow] ||= new Set()).add(d + '|' + sn)
      ;((salonDays[sn] ||= {})[dow] ||= new Set()).add(d)
    }

    // salon -> dow -> hh -> sums. Keyed by salon even when the caller asked for
    // everything: the combined view is then a sum of real salons rather than a
    // separate code path that could disagree with them.
    interface Sums {
      line: number; busy: number; ftMin: number; served: number; w15: number
      waitSum: number; waitN: number
      schedMin: number; actMin: number; arrivals: number
      days: Set<string>
    }
    const acc: Record<string, Record<number, Record<number, Sums>>> = {}
    const cell = (sn: string, dow: number, hh: number): Sums => {
      const bySalon = (acc[sn] ||= {})
      const byDow = (bySalon[dow] ||= {})
      return (byDow[hh] ||= {
        line: 0, busy: 0, ftMin: 0, served: 0, w15: 0, waitSum: 0, waitN: 0,
        schedMin: 0, actMin: 0, arrivals: 0, days: new Set<string>(),
      })
    }

    let minHH = 99, maxHH = 0
    const mark = (hh: number) => { if (hh < minHH) minHH = hh; if (hh > maxHH) maxHH = hh }

    for (const r of demand) {
      const d = S(r.date).slice(0, 10)
      const hh = Number(S(r.halfHour))
      if (!isDate(d) || !Number.isFinite(hh)) continue
      const sn = S(r.salonNum)
      if (!sn) continue
      const c = cell(sn, dowOf(d), hh)
      const line = num(r.avgLine), busy = num(r.avgBusy)
      c.line += line
      c.busy += busy
      c.served += num(r.served)
      c.w15 += num(r.waitedOver15)
      // Service-weighted, not a mean of means: a slot that served twelve people
      // should count twelve times as much as one that served one.
      const wait = num(r.avgWaitMin), servedN = num(r.served)
      if (wait > 0 && servedN > 0) { c.waitSum += wait * servedN; c.waitN += servedN }
      c.arrivals += num(r.arrivals)
      if (line > 0 || busy > 0 || num(r.arrivals) > 0) mark(hh)
    }

    // Floor coverage from real punches: stylist minutes in each slot. Only
    // asStylist segments, absent dropped -- the same filter the daily map uses.
    for (const p of punches) {
      const d = S(p.date).slice(0, 10)
      if (!isDate(d)) continue
      if (!truthy(p.asStylist) || truthy(p.absent)) continue
      const a = minOfDay(p.checkInTime), b = minOfDay(p.checkOutTime)
      if (a == null || b == null || b <= a) continue
      const sn = S(p.salonNum)
      if (!sn) continue
      const dow = dowOf(d)
      const h0 = Math.floor(a / 30), h1 = Math.ceil(b / 30) - 1
      for (let hh = h0; hh <= h1; hh++) {
        cell(sn, dow, hh).ftMin += overlap(a, b, hh)
        mark(hh)
      }
    }

    // SCHEDULE-FIT-v1. Scheduled and actual minutes per slot, straight off
    // SD_SHIFTS, which carries both on the same row.
    //
    // A split shift arrives as comma-separated starts and ends that pair up by
    // position ("08:30,12:00" with "11:30,15:30"), so they are walked together
    // rather than taking the first of each -- half a person's day would go
    // missing otherwise, and it would go missing from the middle of the day,
    // which is exactly where the interesting slots are.
    let schedTotal = 0, actTotal = 0
    const salonHours: Record<string, { sched: number; act: number }> = {}
    const hrs = (sn: string) => (salonHours[sn] ||= { sched: 0, act: 0 })
    for (const r of shifts) {
      const d = S(r.date).slice(0, 10)
      const sn = S(r.salonNum)
      if (!isDate(d) || !sn) continue
      const dow = dowOf(d)

      const ss = S(r.schedStart).split(','), se = S(r.schedEnd).split(',')
      for (let i = 0; i < ss.length; i++) {
        const a = shiftMin(ss[i]), b = shiftMin(se[i] || '')
        if (a == null || b == null || b <= a) continue
        schedTotal += (b - a) / 60
        hrs(sn).sched += (b - a) / 60
        for (let hh = Math.floor(a / 30); hh <= Math.ceil(b / 30) - 1; hh++) {
          cell(sn, dow, hh).schedMin += overlap(a, b, hh)
          mark(hh)
        }
      }

      const aa = shiftMin(S(r.actualStart)), ab = shiftMin(S(r.actualEnd))
      if (aa == null || ab == null || ab <= aa) continue
      actTotal += (ab - aa) / 60
      hrs(sn).act += (ab - aa) / 60
      for (let hh = Math.floor(aa / 30); hh <= Math.ceil(ab / 30) - 1; hh++) {
        cell(sn, dow, hh).actMin += overlap(aa, ab, hh)
        mark(hh)
      }
    }

    // ── per salon, then combined ───────────────────────────────────────────
    //
    // The combined grid is the SUM of the salon grids rather than a separate
    // pass, so "all salons" cannot disagree with the salons it is made of.
    //
    // Note what summing means for each field: a wait is service-weighted across
    // salons (a salon that served fifty people should not count the same as one
    // that served five), while heads and queues are TOTALS across the estate.
    // The combined view is therefore about scale -- how many stylists the whole
    // company is short at 10am on a Saturday -- and a single salon is what you
    // build a rota from.
    const RECOMMEND = {
      add1: 8, add2: 12,      // avg wait (min) at or above which a slot was short
      calm: 4,                // wait below which nobody was really queueing
      drop1: 1.0, drop2: 2.0, // avg idle stylists at or above which it was over-covered
    }
    function recommendFor(waitMin: number, idle: number): number {
      if (waitMin >= RECOMMEND.add2) return 2
      if (waitMin >= RECOMMEND.add1) return 1
      if (waitMin < RECOMMEND.calm && idle >= RECOMMEND.drop2) return -2
      if (waitMin < RECOMMEND.calm && idle >= RECOMMEND.drop1) return -1
      return 0
    }

    interface Cell {
      dow: number; hh: number
      line: number; busy: number; fte: number; served: number; w15: number
      waitMin: number; arrivals: number; schedFte: number; actFte: number; w15Pct: number
    }

    const gridsBySalon: Record<string, Cell[]> = {}
    for (const sn of Object.keys(acc)) {
      const out: Cell[] = []
      for (const dowStr of Object.keys(acc[sn])) {
        const dow = Number(dowStr)
        const days = salonDays[sn]?.[dow]?.size || 0
        if (!days) continue
        for (const hhStr of Object.keys(acc[sn][dow])) {
          const hh = Number(hhStr)
          const c = acc[sn][dow][hh]
          const line = c.line / days
          const busy = c.busy / days
          const fte = (c.ftMin / 30) / days
          const schedFte = (c.schedMin / 30) / days
          const actFte = (c.actMin / 30) / days
          // Nothing waiting, nothing cut, nobody on the floor or rostered.
          if (line < 0.005 && busy < 0.005 && fte < 0.005 && schedFte < 0.005) continue
          out.push({
            dow, hh,
            line: Math.round(line * 100) / 100,
            busy: Math.round(busy * 100) / 100,
            fte: Math.round(fte * 100) / 100,
            served: Math.round((c.served / days) * 10) / 10,
            w15: Math.round((c.w15 / days) * 10) / 10,
            // Averaged over months the LENGTH of a queue stops discriminating --
            // half a person waiting is ordinary trading. How long they waited
            // does not: on this estate a 0.5-1.0 line runs a 5.6 minute wait,
            // 1-2 runs 9.1, and 2-3 runs 14.1 with 38% over a quarter of an hour.
            waitMin: c.waitN ? Math.round((c.waitSum / c.waitN) * 10) / 10 : 0,
            arrivals: Math.round((c.arrivals / days) * 10) / 10,
            schedFte: Math.round(schedFte * 100) / 100,
            actFte: Math.round(actFte * 100) / 100,
            w15Pct: c.served ? Math.round((c.w15 / c.served) * 1000) / 10 : 0,
          })
        }
      }
      gridsBySalon[sn] = out
    }

    const wantSalon = salon || (Object.keys(gridsBySalon).length === 1 ? Object.keys(gridsBySalon)[0] : '')
    let grid: Cell[]
    if (wantSalon) {
      grid = gridsBySalon[wantSalon] || []
    } else {
      const merged: Record<string, any> = {}
      for (const sn of Object.keys(gridsBySalon)) {
        for (const c of gridsBySalon[sn]) {
          const k = c.dow + '|' + c.hh
          const m = (merged[k] ||= { dow: c.dow, hh: c.hh, line: 0, busy: 0, fte: 0, served: 0, w15: 0, arrivals: 0, schedFte: 0, actFte: 0, waitW: 0, waitN: 0 })
          m.line += c.line; m.busy += c.busy; m.fte += c.fte; m.served += c.served
          m.w15 += c.w15; m.arrivals += c.arrivals
          m.schedFte += c.schedFte; m.actFte += c.actFte
          if (c.waitMin > 0 && c.served > 0) { m.waitW += c.waitMin * c.served; m.waitN += c.served }
        }
      }
      grid = Object.values(merged).map((m: any) => ({
        dow: m.dow, hh: m.hh,
        line: Math.round(m.line * 100) / 100,
        busy: Math.round(m.busy * 100) / 100,
        fte: Math.round(m.fte * 100) / 100,
        served: Math.round(m.served * 10) / 10,
        w15: Math.round(m.w15 * 10) / 10,
        waitMin: m.waitN ? Math.round((m.waitW / m.waitN) * 10) / 10 : 0,
        arrivals: Math.round(m.arrivals * 10) / 10,
        schedFte: Math.round(m.schedFte * 100) / 100,
        actFte: Math.round(m.actFte * 100) / 100,
        w15Pct: m.served ? Math.round((m.w15 / m.served) * 1000) / 10 : 0,
      }))
    }

    // ── the per-salon table ────────────────────────────────────────────────
    // One row per salon, so a manager can be handed their own salon's answer
    // rather than the estate's. Ranked on hours, not slot counts: a salon short
    // two heads for four hours is a bigger problem than one short one head for
    // five, and counting slots would say the opposite.
    const bySalon = Object.keys(gridsBySalon).map(sn => {
      let shortSlots = 0, overSlots = 0, shortHours = 0, overHours = 0
      let worstShort: any = null, worstOver: any = null
      for (const c of gridsBySalon[sn]) {
        const idle = Math.max(0, c.actFte - c.busy)
        const rec = recommendFor(c.waitMin, idle)
        // A cell is one half-hour of ONE weekday, so it stands for half an hour
        // a week -- the hours below are per week, which is the unit a rota is
        // written in.
        if (rec > 0) { shortSlots++; shortHours += rec * 0.5 }
        if (rec < 0) { overSlots++; overHours += -rec * 0.5 }
        if (c.waitMin > 0 && (!worstShort || c.waitMin > worstShort.waitMin)) worstShort = c
        if (idle > 0 && c.waitMin < RECOMMEND.calm && (!worstOver || idle > worstOver.idle)) worstOver = { ...c, idle }
      }
      const h = salonHours[sn] || { sched: 0, act: 0 }
      return {
        salon: sn,
        schedHours: Math.round(h.sched),
        actualHours: Math.round(h.act),
        adherencePct: h.sched ? Math.round(((h.act - h.sched) / h.sched) * 1000) / 10 : 0,
        shortSlots, overSlots,
        shortHours: Math.round(shortHours * 10) / 10,
        overHours: Math.round(overHours * 10) / 10,
        worstShort: worstShort && worstShort.waitMin >= RECOMMEND.add1
          ? { dow: worstShort.dow, hh: worstShort.hh, waitMin: worstShort.waitMin }
          : null,
        worstOver: worstOver && worstOver.idle >= RECOMMEND.drop1
          ? { dow: worstOver.dow, hh: worstOver.hh, idle: Math.round(worstOver.idle * 10) / 10 }
          : null,
      }
    }).sort((a, b) => (b.shortHours + b.overHours) - (a.shortHours + a.overHours))

    // How many of each weekday the average rests on -- a Saturday averaged over
    // two Saturdays is not the same claim as one averaged over twelve, and the
    // screen has no way to say so unless this is sent.
    const dayCounts: Record<number, number> = {}
    for (const k of Object.keys(openDays)) {
      const dow = Number(k)
      const dates = new Set<string>()
      for (const key of openDays[dow]) dates.add(key.split('|')[0])
      dayCounts[dow] = dates.size
    }

    return NextResponse.json({
      success: true,
      start, end,
      salon: salon || '',
      salonCount: salonsSeen.size,
      salons: [...salonsSeen].sort(),
      // Hours ROSTERED against hours WORKED across the whole period. The
      // per-slot numbers answer "when"; this answers "how much", which is the
      // question a payroll conversation starts from.
      schedHours: Math.round(schedTotal),
      actualHours: Math.round(actTotal),
      // One row per salon: which salons to look at, and where in their week.
      bySalon,
      minHH: minHH > maxHH ? 0 : minHH,
      maxHH: minHH > maxHH ? 0 : maxHH,
      dayCounts,
      grid,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
