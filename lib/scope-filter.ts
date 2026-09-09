// lib/scope-filter.ts
//
// Server-side data scoping for read endpoints. The client UI already gates what
// each role sees; this enforces the SAME boundaries on the API so a signed-in
// user can't pull data the UI hides (notably pay rates) by calling the endpoint
// directly. This is the single source of truth for "what slice does a role get."
//
// Policy (confirmed):
//   owner / admin / viewer -> everything, including pay.
//   office                 -> everything too. SCOPE-v2: office is an admin who
//                             also keeps leases and the supply list, and runs
//                             payroll, so it already sees pay in the ADP
//                             builder. Treating it as a stylist here was a
//                             leftover from when the role only meant "payroll".
//   area_manager           -> all-salon SUMMARIES stay (their company view and
//                             company-wide Standouts are unchanged), but pay and
//                             per-employee buckets are scoped to their salons.
//   manager                -> strictly their own salon.
//   stylist / maintenance  -> themselves. SCOPE-v2: this branch used to strip
//                             pay and pass everything else through, on the
//                             grounds that no UI rendered it for them -- but
//                             getAllData is requireSignedIn, so a stylist could
//                             read every employee's bonus payout by calling it
//                             directly. "Nothing displays it" is not a boundary.

import type { Access } from './auth-roles'

function seesEverything(a: Access): boolean {
  return a.role === 'owner' || a.role === 'admin' || a.role === 'viewer' || a.role === 'office'
}

/** Keep only the rows belonging to this person. */
function mineOnly<T extends { globalId?: any }>(rows: T[], a: Access): T[] {
  const gid = String(a.globalId || '').trim()
  if (!gid) return []
  return (rows || []).filter(r => String(r.globalId || '').trim() === gid)
}

function amSalonSet(a: Access): Set<string> {
  return new Set((a.salons || []).map(s => String(s).trim()))
}

// baseWage is the only pay-rate field shipped to the browser; drop it, keep the rest.
function withoutWage(row: any): any {
  if (!row || row.baseWage === undefined) return row
  const { baseWage, ...rest } = row
  return rest
}

// Period buckets look like { ..., employees: [{ salonNum, ... }] }.
function scopePeriods(periods: any[], keep: (e: any) => boolean): any[] {
  return (periods || []).map(p => ({
    ...p,
    employees: (p.employees || []).filter((e: any) => keep(e)),
  }))
}

/** Scope the full getAllData payload to what `access` may receive. Never mutates `data`. */
export function scopeAllData(data: any, access: Access): any {
  if (seesEverything(access)) return data

  if (access.role === 'area_manager') {
    const salons = amSalonSet(access)
    const inScope = (sn: any) => salons.has(String(sn || '').trim())
    const homeSalonOf = (gid: string) => data.homeDataMap?.[gid]?.homeSalon
    // Managers/AMs assigned to one of THIS AM's salons: keep their personal bonus
    // & payroll rows even when their own primary salon sits outside this AM's
    // scope. Without this, such a manager's aggregated row is dropped entirely and
    // the manager bonus falls back to salon product % for the −25% penalty.
    const keepGids = new Set<string>()
    for (const m of (data.managerTable || [])) {
      if (m && m.globalId && inScope(m.salonNum)) keepGids.add(String(m.globalId).trim())
    }
    // And themselves. calcAmBonus falls back to the AM's OWN bonus row for a
    // salon with no assigned manager, and an AM's aggregated row can be filed
    // under a salon outside their own scope -- the same shape of problem
    // keepGids solves for managers.
    if (access.globalId) keepGids.add(String(access.globalId).trim())
    const empInScope = (e: any) =>
      inScope(e.salonNum) ||
      // Employees HOMED at one of this AM's salons keep ALL their bonus rows even
      // when a given month is attributed to a salon they floated to. Reviews list
      // stylists by home salon, so without this their review comes back empty.
      inScope(homeSalonOf(String(e.globalId || '').trim())) ||
      keepGids.has(String(e.globalId || '').trim())
      // SCOPE-v2: a blanket "keep every position M row" clause used to sit here,
      // so every AM received all eighteen managers' names, salons and bonus
      // PAYOUTS. It was justified by the manager bonus needing each manager's
      // personal product % -- but calcAmBonus loops over the AM's OWN salons,
      // looks up that salon's manager by globalId in managerTable, and finds
      // only that row. keepGids above is already exactly that set. The clause
      // was solving a problem the line above it had solved.
    const out: any = { ...data }

    // 1) Pay: keep baseWage only for employees homed at the AM's salons.
    if (data.homeDataMap) {
      out.homeDataMap = {}
      for (const [gid, row] of Object.entries<any>(data.homeDataMap)) {
        out.homeDataMap[gid] = inScope((row as any)?.homeSalon) ? row : withoutWage(row)
      }
    }
    // 2) Per-employee buckets -> the AM's salons only. Every row that survives
    // is now one they are entitled to whole, so there is nothing to redact.
    out.bonusPeriods = scopePeriods(data.bonusPeriods, empInScope)
    out.payrollConsolidatedPeriods = scopePeriods(data.payrollConsolidatedPeriods, empInScope)
    if (Array.isArray(data.empWeeklyConsRows))
      out.empWeeklyConsRows = data.empWeeklyConsRows.filter((r: any) => inScope(r.salonNum))
    // 3) Disciplinary tracker (keyed by globalId) -> only the AM's employees.
    if (data.trackerData) {
      out.trackerData = {}
      for (const [gid, entries] of Object.entries<any>(data.trackerData)) {
        if (inScope(homeSalonOf(gid))) out.trackerData[gid] = entries
      }
    }
    // weeks (salon summaries + emp performance) and salonSummaryPeriods stay full:
    // AMs already see all-salon summaries and company-wide Standouts in the UI.
    return out
  }

  // MANAGER -> exactly their own salon. Deliberately NOT the area_manager
  // branch above: that one keeps EVERY position-"M" row company-wide so the AM
  // bonus maths has each manager's personal product %, and reusing it here would
  // hand a manager every other manager's pay. This branch scopes strictly.
  if (access.role === 'manager' && (access.salons || []).length) {
    const salons = amSalonSet(access)
    const inScope = (sn: any) => salons.has(String(sn || '').trim())
    const homeSalonOf = (gid: string) => data.homeDataMap?.[gid]?.homeSalon
    const empInScope = (e: any) =>
      inScope(e.salonNum) || inScope(homeSalonOf(String(e.globalId || '').trim()))
    const out: any = { ...data }

    // Pay: baseWage only for people homed at THEIR salon.
    if (data.homeDataMap) {
      out.homeDataMap = {}
      for (const [gid, row] of Object.entries<any>(data.homeDataMap)) {
        out.homeDataMap[gid] = inScope((row as any)?.homeSalon) ? row : withoutWage(row)
      }
    }
    out.bonusPeriods = scopePeriods(data.bonusPeriods, empInScope)
    out.payrollConsolidatedPeriods = scopePeriods(data.payrollConsolidatedPeriods, empInScope)
    if (Array.isArray(data.empWeeklyConsRows))
      out.empWeeklyConsRows = data.empWeeklyConsRows.filter((r: any) => inScope(r.salonNum))
    if (data.trackerData) {
      out.trackerData = {}
      for (const [gid, entries] of Object.entries<any>(data.trackerData)) {
        if (inScope(homeSalonOf(gid))) out.trackerData[gid] = entries
      }
    }
    return out
  }

  // stylist / maintenance / anyone unscoped -> themselves, and the reference
  // data the page needs to render at all.
  //
  // This is a DENY list, not an allow list, and that is a deliberate trade: an
  // allow list would be safer against a future field but would break the client
  // the moment somebody adds one it needs. Everything named here carries a
  // person's name, salon, hours, percentages or pay; what passes through is
  // reference data -- the salon roster, the manager table, AM assignments,
  // thresholds -- which the salon picker and the forms depend on and which
  // names no individual's numbers.
  //
  // If you add a per-employee bucket to getAllData, add it here too.
  const gid = String(access.globalId || '').trim()
  const out: any = { ...data }

  // Weekly performance: their own rows. Salon-level weekly numbers go entirely
  // -- eighteen salons' revenue is not a stylist's business and nothing renders
  // it for them.
  out.weeks = (data.weeks || []).map((w: any) => ({
    ...w,
    salons: [],
    emps: mineOnly(w.emps || [], access),
  }))

  out.bonusPeriods = scopePeriods(data.bonusPeriods, (e: any) =>
    !!gid && String(e.globalId || '').trim() === gid)
  out.payrollConsolidatedPeriods = scopePeriods(data.payrollConsolidatedPeriods, (e: any) =>
    !!gid && String(e.globalId || '').trim() === gid)
  out.salonSummaryPeriods = (data.salonSummaryPeriods || []).map((p: any) => ({ ...p, salons: [] }))
  out.empWeeklyConsRows = mineOnly(data.empWeeklyConsRows || [], access)

  // Disciplinary history is keyed by globalId; keep their own, which they are
  // entitled to and which getDiscPoints returns them anyway.
  out.trackerData = {}
  if (gid && data.trackerData?.[gid]) out.trackerData[gid] = data.trackerData[gid]

  // Pay: their own wage, nobody else's.
  out.homeDataMap = {}
  for (const [k, row] of Object.entries<any>(data.homeDataMap || {})) {
    out.homeDataMap[k] = (gid && k === gid) ? row : withoutWage(row)
  }
  return out
}

/** Scope getDaily rows to the role's salons. */
export function scopeDaily(
  salonDaily: any[],
  empDaily: any[],
  shifts: any[],
  halfHour: any[],
  demand: any[],
  chkinout: any[],
  access: Access
): { salonDaily: any[]; empDaily: any[]; shifts: any[]; halfHour: any[]; demand: any[]; chkinout: any[] } {
  if (seesEverything(access)) return { salonDaily, empDaily, shifts, halfHour, demand, chkinout }
  if (access.role === 'area_manager') {
    const salons = amSalonSet(access)
    const inScope = (sn: any) => salons.has(String(sn || '').trim())
    return {
      salonDaily: (salonDaily || []).filter(r => inScope(r.salonNum)),
      empDaily: (empDaily || []).filter(r => inScope(r.salonNum)),
      shifts: (shifts || []).filter(r => inScope(r.salonNum)),
      halfHour: (halfHour || []).filter(r => inScope(r.salonNum)),
      demand: (demand || []).filter(r => inScope(r.salonNum)),
      chkinout: (chkinout || []).filter(r => inScope(r.salonNum)),
    }
  }
  if (access.role === 'manager' && (access.salons || []).length) {
    const salons = amSalonSet(access)
    const inScope = (sn: any) => salons.has(String(sn || '').trim())
    return {
      salonDaily: (salonDaily || []).filter(r => inScope(r.salonNum)),
      empDaily: (empDaily || []).filter(r => inScope(r.salonNum)),
      shifts: (shifts || []).filter(r => inScope(r.salonNum)),
      halfHour: (halfHour || []).filter(r => inScope(r.salonNum)),
      demand: (demand || []).filter(r => inScope(r.salonNum)),
      chkinout: (chkinout || []).filter(r => inScope(r.salonNum)),
    }
  }
  return { salonDaily: [], empDaily: [], shifts: [], halfHour: [], demand: [], chkinout: [] } // stylist / unknown
}

/**
 * Scope raw daily rows (each already carrying salonNum) to what `access` may
 * receive. Same policy as scopeDaily above, for readers that hand back a flat
 * row list rather than the six-bucket shape.
 *
 * Manager and stylist get [] here, matching scopeDaily and today's UI, which
 * offers Day-of-Week to canSeeAllSalons() || isAMRole() only. Widening this to
 * "a manager sees their own store" is a deliberate ACCESS EXPANSION and belongs
 * with the capability model — not in a change whose job is closing holes.
 */
/**
 * May this person see the employee homed at `homeSalon`?
 *
 * The single rule behind every per-employee read: disciplinary points,
 * performance reviews, and the employee picker that forms draw on. Those three
 * routes each used to answer it differently, or not at all, so they are now
 * required to agree.
 *
 * You can ALWAYS see yourself. That is what lets a stylist read their own
 * review without opening the door to anyone else's, and it is why the globalId
 * check comes before the role check rather than after.
 *
 * Anyone not in the sees-everything set and not scoped to a salon sees nobody.
 * SCOPE-v2 moved OFFICE out of that group -- office is an admin who also keeps
 * leases and supplies -- and maintenance stays in it: they act on forms
 * addressed to them, which carry their own visibility rules, and have no reason
 * to read the HR record of someone they will never manage.
 */
export function seesEmployee(access: Access, globalId: string, homeSalon: string): boolean {
  if (seesEverything(access)) return true
  const gid = String(globalId || '').trim()
  if (gid && gid === String(access.globalId || '').trim()) return true
  if (access.role === 'area_manager' || access.role === 'manager') {
    return amSalonSet(access).has(String(homeSalon || '').trim())
  }
  return false
}

/**
 * May this person see anything filed against this salon?
 *
 * The companion to scopeSalonRows, for the cases where the question is asked
 * about ONE salon rather than a list — a write, usually, where the row does not
 * exist yet and there is nothing to filter.
 *
 * `maintenance` is here and not in scopeSalonRows on purpose: the maintenance
 * role exists to fix buildings, so it covers every building. It is a
 * salon-scope question, not a business-data one — that role still sees no
 * payroll, no bonuses and no reports.
 */
export function canSeeSalon(access: Access, salonNum: string): boolean {
  const sn = String(salonNum || '').trim()
  if (!sn) return false
  if (seesEverything(access)) return true
  if (access.role === 'maintenance') return true
  if (access.role === 'area_manager' || access.role === 'manager') return amSalonSet(access).has(sn)
  return false
}

export function scopeSalonRows<T extends { salonNum?: any }>(rows: T[], access: Access): T[] {
  if (seesEverything(access)) return rows
  if (access.role === 'area_manager' || access.role === 'manager') {
    const salons = amSalonSet(access)
    return (rows || []).filter(r => salons.has(String(r.salonNum || '').trim()))
  }
  return []
}
