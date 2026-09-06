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
import { getDemandRange, getChkInOutRange } from '@/lib/sheets'
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

    const [dm, ck] = await Promise.all([
      getDemandRange(start, end).catch(() => ({ demand: [] as any[] })),
      getChkInOutRange(start, end).catch(() => ({ chkinout: [] as any[] })),
    ])

    // Same scoping as the daily view, from the same function -- an AM gets
    // their salons here for the same reason they get them there.
    const scoped = scopeDaily([], [], [], [], dm.demand || [], ck.chkinout || [], gate.access)
    let demand = scoped.demand
    let punches = scoped.chkinout
    if (salon) {
      demand = demand.filter((r: any) => S(r.salonNum) === salon)
      punches = punches.filter((r: any) => S(r.salonNum) === salon)
    }

    // The DENOMINATOR is salon-days, not rows. Every (date, salon) that traded
    // at all counts once for every slot, so a half-hour the salon was shut
    // averages toward zero instead of being quietly excluded and reading busy.
    const openDays: Record<number, Set<string>> = {}
    const salonsSeen = new Set<string>()
    for (const r of demand) {
      const d = S(r.date).slice(0, 10), sn = S(r.salonNum)
      if (!isDate(d) || !sn) continue
      salonsSeen.add(sn)
      ;(openDays[dowOf(d)] ||= new Set()).add(d + '|' + sn)
    }

    // dow -> hh -> sums
    const acc: Record<number, Record<number, {
      line: number; busy: number; ftMin: number; served: number; w15: number
      waitSum: number; waitN: number
    }>> = {}
    const cell = (dow: number, hh: number) => {
      const byDow = (acc[dow] ||= {})
      return (byDow[hh] ||= { line: 0, busy: 0, ftMin: 0, served: 0, w15: 0, waitSum: 0, waitN: 0 })
    }

    let minHH = 99, maxHH = 0
    const mark = (hh: number) => { if (hh < minHH) minHH = hh; if (hh > maxHH) maxHH = hh }

    for (const r of demand) {
      const d = S(r.date).slice(0, 10)
      const hh = Number(S(r.halfHour))
      if (!isDate(d) || !Number.isFinite(hh)) continue
      const c = cell(dowOf(d), hh)
      const line = num(r.avgLine), busy = num(r.avgBusy)
      c.line += line
      c.busy += busy
      c.served += num(r.served)
      c.w15 += num(r.waitedOver15)
      // Service-weighted, not a mean of means: a slot that served twelve people
      // should count twelve times as much as one that served one.
      const wait = num(r.avgWaitMin), servedN = num(r.served)
      if (wait > 0 && servedN > 0) { c.waitSum += wait * servedN; c.waitN += servedN }
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
      const dow = dowOf(d)
      const h0 = Math.floor(a / 30), h1 = Math.ceil(b / 30) - 1
      for (let hh = h0; hh <= h1; hh++) {
        cell(dow, hh).ftMin += overlap(a, b, hh)
        mark(hh)
      }
    }

    const grid: any[] = []
    for (const dowStr of Object.keys(acc)) {
      const dow = Number(dowStr)
      const days = openDays[dow]?.size || 0
      if (!days) continue
      for (const hhStr of Object.keys(acc[dow])) {
        const hh = Number(hhStr)
        const c = acc[dow][hh]
        const line = c.line / days
        const busy = c.busy / days
        const fte = (c.ftMin / 30) / days
        // Nothing waiting, nothing being cut, nobody on the floor: closed.
        if (line < 0.005 && busy < 0.005 && fte < 0.005) continue
        grid.push({
          dow, hh,
          line: Math.round(line * 100) / 100,
          busy: Math.round(busy * 100) / 100,
          fte: Math.round(fte * 100) / 100,
          served: Math.round((c.served / days) * 10) / 10,
          w15: Math.round((c.w15 / days) * 10) / 10,
          // THE MEASURE THE TREND VIEW COLOURS BY. Averaged over months, the
          // length of a queue stops discriminating -- half a person waiting is
          // ordinary trading. How long they waited does not: across this
          // estate a 0.5-1.0 line runs a 5.6 minute wait, 1-2 runs 9.1, and 2-3
          // runs 14.1 with 38% of customers over a quarter of an hour.
          waitMin: c.waitN ? Math.round((c.waitSum / c.waitN) * 10) / 10 : 0,
          // Share of served customers who waited more than fifteen minutes.
          w15Pct: c.served ? Math.round((c.w15 / c.served) * 1000) / 10 : 0,
        })
      }
    }

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
      minHH: minHH > maxHH ? 0 : minHH,
      maxHH: minHH > maxHH ? 0 : maxHH,
      dayCounts,
      grid,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
