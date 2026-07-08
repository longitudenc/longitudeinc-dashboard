// lib/scope-filter.ts
//
// Server-side data scoping for read endpoints. The client UI already gates what
// each role sees; this enforces the SAME boundaries on the API so a signed-in
// user can't pull data the UI hides (notably pay rates) by calling the endpoint
// directly. This is the single source of truth for "what slice does a role get."
//
// Policy (confirmed):
//   owner / admin / viewer -> everything, including pay.
//   area_manager           -> all-salon SUMMARIES stay (their company view and
//                             company-wide Standouts are unchanged), but pay and
//                             per-employee buckets are scoped to their salons.
//   manager / stylist /etc -> no dashboard yet; pay stripped. (Tighten to self
//                             when the /my employee portal ships.)

import type { Access } from './auth-roles'

function seesEverything(a: Access): boolean {
  return a.role === 'owner' || a.role === 'admin' || a.role === 'viewer'
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
    // TEMP DEBUG — remove after diagnosing AM review scope. Prints what the filter
    // sees for one known case (Emma Allen, home 1304).
    try {
      const _g = '2018-0001-0905'
      const _emmaRows = (data.bonusPeriods || []).flatMap((p: any) =>
        (p.employees || []).filter((e: any) => String(e.globalId || '').trim() === _g)
          .map((e: any) => ({ period: p.periodKey, salonNum: e.salonNum })))
      console.log('[SCOPE-DEBUG]', JSON.stringify({
        role: access.role,
        accessSalons: access.salons,
        salonSet: [...salons],
        inScope1304: inScope('1304'),
        emmaHomeSalon: homeSalonOf(_g),
        emmaHomeInScope: inScope(homeSalonOf(_g)),
        emmaHasHomeDataRow: !!(data.homeDataMap && data.homeDataMap[_g]),
        emmaBonusRowsInFull: _emmaRows,
      }))
    } catch (err) { console.log('[SCOPE-DEBUG] err', String(err)) }
    // Managers/AMs assigned to one of THIS AM's salons: keep their personal bonus
    // & payroll rows even when their own primary salon sits outside this AM's
    // scope. Without this, such a manager's aggregated row is dropped entirely and
    // the manager bonus falls back to salon product % for the −25% penalty.
    const keepGids = new Set<string>()
    for (const m of (data.managerTable || [])) {
      if (m && m.globalId && inScope(m.salonNum)) keepGids.add(String(m.globalId).trim())
    }
    const empInScope = (e: any) =>
      inScope(e.salonNum) ||
      // Employees HOMED at one of this AM's salons keep ALL their bonus rows even
      // when a given month is attributed to a salon they floated to. Reviews list
      // stylists by home salon, so without this their review comes back empty.
      inScope(homeSalonOf(String(e.globalId || '').trim())) ||
      keepGids.has(String(e.globalId || '').trim()) ||
      // Keep ALL manager (position "M") rows. The AM only DISPLAYS managers for
      // their own salons, but the manager bonus needs each manager's personal
      // product %, and a manager's single aggregated bonus row can be attributed
      // to a salon outside this AM's scope. This guarantees it's always present.
      String(e.position || '').trim().toUpperCase() === 'M' 
    const out: any = { ...data }

    // 1) Pay: keep baseWage only for employees homed at the AM's salons.
    if (data.homeDataMap) {
      out.homeDataMap = {}
      for (const [gid, row] of Object.entries<any>(data.homeDataMap)) {
        out.homeDataMap[gid] = inScope((row as any)?.homeSalon) ? row : withoutWage(row)
      }
    }
    // 2) Per-employee buckets -> the AM's salons only.
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

  // manager / stylist / unknown -> strip all pay; leave the rest at the current
  // posture (no UI consumes it). Tighten to self when /my ships.
  if (data.homeDataMap) {
    const out: any = { ...data, homeDataMap: {} }
    for (const [gid, row] of Object.entries<any>(data.homeDataMap)) {
      out.homeDataMap[gid] = withoutWage(row)
    }
    return out
  }
  return data
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
  return { salonDaily: [], empDaily: [], shifts: [], halfHour: [], demand: [], chkinout: [] } // manager / stylist
}
