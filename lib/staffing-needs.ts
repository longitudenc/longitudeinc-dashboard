// lib/staffing-needs.ts
//
// STAFF-NEEDS-v1 -- where a salon needs more hours, and whether the team it
// already has can cover them or it needs to hire.
//
// NEED comes from the Staffing trends measure (lib/staffing-trend): a half-hour
// where customers averaged 8+ minutes waiting was short a stylist (12+: two);
// one where stylists stood idle with nobody waiting was over-covered. Summed
// across the typical week, that is SHORT and IDLE hours per week. It is
// measured, not modelled -- SCHEDULE-FIT-v1 in dashboard.html has the reason.
//
// THE LEVERS, cheapest first:
//   1. Reschedule -- idle hours at quiet times moved into the short ones.
//   2. Add hours  -- whatever is still short, given to people already on the
//                    team who have room: below the full-week cap AND with a
//                    record of working more (their own 90th-percentile week
//                    over 26 weeks is above their current average).
//   3. Hire       -- whatever is left, in new people at `hireHrs` a week each.
//
// Salondata has no "hours I am available" field, so room is read from what
// each person has actually worked. It will understate someone who wants more
// hours and has never been offered them -- the screen says so.

import {
  getDemandRange, getChkInOutRange, getShiftsRange, readSheet, readRowsInDateRange,
  rowsToObjects, getEmployeeProfiles,
} from './sheets'
import { scopeDaily, canSeeSalon } from './scope-filter'
import { computeStaffingTrend } from './staffing-trend'
import type { Access } from './auth-roles'

export interface StaffNeedsOpts { weeks: number; cap: number; hireHrs: number }

const S = (v: unknown) => String(v ?? '').trim()
const num = (v: unknown) => { const x = parseFloat(S(v)); return Number.isFinite(x) ? x : 0 }
const r1 = (x: number) => Math.round(x * 10) / 10
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}
function p90(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(0.9 * (s.length - 1))]
}

export async function staffingNeeds(access: Access, o: StaffNeedsOpts) {
  const end = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const start = addDays(end, -(o.weeks * 7) + 1)
  const start26 = addDays(end, -(26 * 7) + 1)

  const [dm, ck, sh, rosterRaw, weeklyRaw, payRaw, profiles] = await Promise.all([
    getDemandRange(start, end).catch(() => ({ demand: [] as any[] })),
    getChkInOutRange(start, end).catch(() => ({ chkinout: [] as any[] })),
    getShiftsRange(start, end).catch(() => ({ shifts: [] as any[] })),
    readSheet('SalonRoster'),
    readRowsInDateRange('SD_WEEKLY', start, end, { dateHeader: 'weekEnd' }),
    readRowsInDateRange('SD_PAYROLL', start26, end, { dateHeader: 'weekEnd' }),
    getEmployeeProfiles(),
  ])

  // Same scoping as Staffing trends: an AM gets their salons, a manager theirs.
  const scoped = scopeDaily([], [], sh.shifts || [], [], dm.demand || [], ck.chkinout || [], access)
  const trend = computeStaffingTrend(scoped.demand, scoped.chkinout, scoped.shifts, '')
  const trendBy = new Map<string, any>(trend.bySalon.map((r: any) => [r.salon, r]))

  const roster = rowsToObjects(rosterRaw || []).filter((r: any) => {
    const st = S(r.status).toLowerCase()
    return (!st || st === 'active') && canSeeSalon(access, S(r.salonNum))
  })
  const snOfStore: Record<string, string> = {}
  for (const r of rowsToObjects(rosterRaw || [])) snOfStore[S(r.storeId)] = S(r.salonNum)

  // Floor hours actually worked per week, from the weekly salon summary.
  const floor: Record<string, { hrs: number; weeks: Set<string> }> = {}
  for (const r of rowsToObjects(weeklyRaw || [])) {
    const sn = snOfStore[S(r.storeId)], we = S(r.weekEnd).slice(0, 10)
    if (!sn || we < start || we > end) continue
    const f = (floor[sn] ||= { hrs: 0, weeks: new Set() })
    f.hrs += num(r.floorHours); f.weeks.add(we)
  }

  // Each active person's weeks: hours summed across every salon they worked.
  const home: Record<string, { name: string; salon: string }> = {}
  for (const p of (profiles || []) as any[]) {
    if (S(p.inactive).toLowerCase() === 'true') continue
    const gid = S(p.globalId); if (!gid) continue
    home[gid] = { name: S(p.name), salon: S(p.homeStoreNum) }
  }
  const weeksOf: Record<string, Record<string, { tot: number; floor: number; ot: number }>> = {}
  for (const r of rowsToObjects(payRaw || [])) {
    const gid = S(r.globalId), we = S(r.weekEnd).slice(0, 10)
    if (!gid || !home[gid] || we < start26 || we > end) continue
    const w = ((weeksOf[gid] ||= {})[we] ||= { tot: 0, floor: 0, ot: 0 })
    w.tot += num(r.totalHours); w.floor += num(r.floorHours); w.ot += num(r.overtimeHours)
  }

  const salons = roster.map((r: any) => {
    const sn = S(r.salonNum)
    const t = trendBy.get(sn) || { shortHours: 0, overHours: 0, worstShort: null, worstOver: null }
    const f = floor[sn]
    const staff = Object.keys(home).filter(g => home[g].salon === sn).map(gid => {
      const all = Object.entries(weeksOf[gid] || {}).filter(([, w]) => w.tot > 0)
      const recent = all.filter(([we]) => we >= start)
      const avg = recent.length ? recent.reduce((s, [, w]) => s + w.tot, 0) / recent.length : 0
      const avgFloor = recent.length ? recent.reduce((s, [, w]) => s + w.floor, 0) / recent.length : 0
      const peak = p90(all.map(([, w]) => w.tot))
      const ot = recent.length ? recent.reduce((s, [, w]) => s + w.ot, 0) / recent.length : 0
      const isNew = recent.length > 0 && all.length < 3
      // Room: up to the cap, and never past what they have shown they can do.
      const room = (recent.length && !isNew) ? Math.max(0, Math.min(o.cap, peak) - avg) : 0
      return {
        globalId: gid, name: home[gid].name, weeks: recent.length,
        avgTotal: r1(avg), avgFloor: r1(avgFloor), peak: r1(peak), ot: r1(ot),
        room: room >= 1 ? r1(room) : 0, isNew, noHours: recent.length === 0,
      }
    }).sort((a, b) => b.room - a.room || b.avgTotal - a.avgTotal)

    const short = num(t.shortHours), over = num(t.overHours)
    const headroom = staff.reduce((s, p) => s + p.room, 0)
    const gap = Math.max(0, short - over)                 // still short after rescheduling
    const fromStaff = Math.min(gap, headroom)
    const remaining = gap - fromStaff
    const hires = remaining > 0 ? Math.ceil(remaining / o.hireHrs) : 0
    const verdict = gap <= 0 ? (short > 0 ? 'reschedule' : 'ok') : remaining <= 0 ? 'add-hours' : 'hire'
    return {
      salon: sn, name: S(r.name),
      floorPerWeek: f && f.weeks.size ? r1(f.hrs / f.weeks.size) : 0,
      weeksOfData: f ? f.weeks.size : 0,
      shortHours: r1(short), overHours: r1(over), movable: r1(Math.min(short, over)),
      gap: r1(gap), headroom: r1(headroom), fromStaff: r1(fromStaff), remaining: r1(remaining),
      hires, verdict, worstShort: t.worstShort, worstOver: t.worstOver,
      team: staff.filter(p => !p.noHours).length, staff,
    }
  })

  const rank: Record<string, number> = { hire: 0, 'add-hours': 1, reschedule: 2, ok: 3 }
  salons.sort((a: any, b: any) => rank[a.verdict] - rank[b.verdict] || b.remaining - a.remaining || b.gap - a.gap)
  return { start, end, weeks: o.weeks, cap: o.cap, hireHrs: o.hireHrs, salons }
}
