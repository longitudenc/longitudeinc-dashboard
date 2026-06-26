// lib/auth-roles.ts
//
// AUTH MAPPING (the "rulebook"): given a verified email, decide what role the
// person has and what data they're allowed to see. This file does NOT verify
// identity — that's the magic-link login's job. By the time resolveAccess()
// runs, the email is already proven to belong to the person (they clicked a
// one-time link sent to it). This just translates "who they are" → "what they
// can see".
//
// Resolution order (first match wins):
//   1. Users tab        — manual list: owner / admin / viewer + non-employees.
//                         Checked FIRST so owners/admins are never locked out
//                         and never depend on SD3.
//   2. AreaManagers tab — if their globalId is a listed AM → area_manager,
//                         scoped to the salons AMAssignments says they manage.
//   3. ManagerTable     — if their globalId manages a salon → manager, scoped
//                         to that salon.
//   4. EmployeeProfile  — any other known employee → stylist, scoped to self.
//   5. No match         → null (NO ACCESS). The security backstop.
//
// Everything here runs SERVER-side only. Email is never returned to the client.

import {
  getUsers,
  getAreaManagers,
  getManagerTable,
  getAMAssignments,
  getEmployeeProfiles,
  getSalonRoster,
} from './sheets'

export type Role =
  | 'owner'
  | 'admin'
  | 'viewer'
  | 'area_manager'
  | 'manager'
  | 'stylist'

export interface Access {
  role: Role
  globalId?: string      // the person's employee id (when they're an employee)
  salons?: string[]      // salons in scope (area_manager / manager)
  name?: string          // display name for the signed-in person (owner/admin from Users tab)
  // owner/admin/viewer have no salon scope — they see everything their role allows
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

// Which salons does an AM currently manage? Derived from AMAssignments
// (effective-dated). "Current" = assignment with no endPeriod, or whose window
// includes today. amKey matches the AreaManagers key.
function currentSalonsForAm(amKey: string, assignments: any[], roster: any[]): string[] {
  const key = norm(amKey)
  const out = new Set<string>()
  let sawOverride = false
  for (const a of assignments) {
    if (norm(a.amKey) !== key) continue
    sawOverride = true
    // An assignment is "current" if it has no end, i.e. still in effect.
    if (!String(a.endPeriod || '').trim()) {
      if (a.salonNum) out.add(String(a.salonNum).trim())
    }
  }
  // FALLBACK: AMAssignments is an override/change log — it only contains rows
  // for AMs whose assignments have CHANGED (e.g. the Dawn step-down). Most AMs
  // have no rows at all. When an AM has no override rows, derive their current
  // salons from the SalonRoster `am` column (the maintained salon→AM mapping).
  // This way unchanged AMs still resolve correctly without manual backfill.
  if (!sawOverride && Array.isArray(roster)) {
    for (const r of roster) {
      if (norm(r.am) !== key) continue
      const status = norm(r.status || 'active')
      if (status === 'sold' || status === 'closed') continue // not a current salon
      if (r.salonNum) out.add(String(r.salonNum).trim())
    }
  }
  return [...out]
}

// Resolve a verified email to a role + scope, or null for no access.
export async function resolveAccess(email: string): Promise<Access | null> {
  const e = norm(email)
  if (!e) return null

  // Load the inputs. Each reader tolerates a missing tab (returns []).
  const [users, areaManagers, managerTable, amAssignments, profiles, roster] =
    await Promise.all([
      getUsers(),
      getAreaManagers(),
      getManagerTable(),
      getAMAssignments(),
      getEmployeeProfiles(),
      getSalonRoster(),
    ])

  // 1) Manual list (owner / admin / viewer / exceptions). Wins over everything.
  // Tolerant of header variations: email/Email/E-mail, role/Role/Access, and
  // globalId/GlobalId, salons/Salons.
  const pick = (row: any, ...names: string[]) => {
    for (const n of names) {
      for (const k of Object.keys(row)) {
        if (k.trim().toLowerCase() === n.toLowerCase()) return row[k]
      }
    }
    return ''
  }
  const u = users.find((r: any) => norm(pick(r, 'email', 'e-mail', 'emailaddress', 'email address')) === e)
  if (u) {
    const role = norm(pick(u, 'role', 'access', 'tier')) as Role
    if (role) {
      const access: Access = { role }
      const nm = String(pick(u, 'name', 'full name', 'fullname', 'display name', 'displayname') || '').trim()
      if (nm) access.name = nm
      const gid = String(pick(u, 'globalId', 'global id', 'globalemployeekey') || '').trim()
      if (gid) access.globalId = gid
      const salons = String(pick(u, 'salons', 'salon', 'salonnums') || '').trim()
      if (salons) access.salons = salons.split(/[,\s]+/).filter(Boolean)
      return access
    }
  }

  // For employee roles we need their globalId, from the SD3 email list.
  const profile = profiles.find((p: any) => norm(p.email) === e)
  if (!profile || !String(profile.globalId || '').trim()) {
    return null // email not a known employee and not in the manual list → no access
  }
  const globalId = String(profile.globalId).trim()

  // 2) Area manager FIRST — an active AM (with at least one current, un-ended
  //    assignment) resolves as area_manager EVEN IF they are also the listed
  //    manager of one of their salons (e.g. Cassi manages 3058, Dana manages
  //    7728 — they're still AMs). Being an AM is the broader role.
  //    Conditions, so the role is driven by dated assignment history:
  //      (a) their globalId is in AreaManagers (identity), AND
  //      (b) their amKey has at least one CURRENT (un-ended) AM assignment.
  //    When an AM's last assignment ends (they step down, like Dawn 5/30),
  //    condition (b) fails → they fall through to manager/stylist below.
  const am = areaManagers.find((a: any) => String(a.globalId || '').trim() === globalId)
  if (am) {
    const salons = currentSalonsForAm(am.amKey || am.key || '', amAssignments, roster)
    if (salons.length > 0) {
      return { role: 'area_manager', globalId, salons }
    }
    // Listed in AreaManagers but no current assignments → former AM. Fall
    // through to manager/stylist resolution below for their CURRENT role.
  }

  // 3) Manager? Reached only when the person is NOT an active AM. This covers
  //    a true single-salon manager, or an AM who STEPPED DOWN to manage one
  //    salon (no current AM assignments). Their historical AM data still
  //    computes correctly because bonus math reads stored data, not this role.
  const mgr = managerTable.find((m: any) => String(m.globalId || '').trim() === globalId)
  if (mgr) {
    return {
      role: 'manager',
      globalId,
      salons: mgr.salonNum ? [String(mgr.salonNum).trim()] : [],
    }
  }

  // 4) Otherwise a known employee → stylist, scoped to self.
  return { role: 'stylist', globalId }
}
