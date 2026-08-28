// lib/access-audit.ts
//
// EVERY login the app will accept, and WHERE each one's role comes from.
//
// This exists because most roles are not assigned anywhere — they are DERIVED.
// resolveAccess() walks a five-step cascade (Users, then AreaManagers,
// ManagerTable, EmployeeProfile, then nothing), so a panel that only listed the
// Users tab would show five owners and imply nobody else could sign in.
//
// It deliberately calls the SAME employeeAccessFor() the real auth path calls,
// over the SAME tables, rather than restating the rules. A second copy of the
// cascade would drift, and a permissions screen that is confidently wrong is
// worse than no permissions screen.

import {
  loadAccessTables,
  employeeAccessFor,
  type Access,
  type Role,
} from './auth-roles'
import { getUsers } from './sheets'

export type AccessSource = 'Users' | 'AreaManagers' | 'ManagerTable' | 'EmployeeProfile'

export interface AccessEntry {
  email: string
  name: string
  role: Role
  source: AccessSource
  why: string           // plain-English derivation, shown in the panel
  salons: string[]
  globalId: string
  amId: string          // Users-tab column the client reads as USER_AM_ID
  editable: boolean     // only Users-tab rows can be changed from the panel
}

export interface AccessAudit {
  entries: AccessEntry[]
  /** Employees with no email on file — they simply cannot sign in. */
  noEmail: { name: string; globalId: string; salon: string }[]
  /** Departed employees, flagged inactive and therefore refused. */
  inactiveDenied: number
  counts: Record<string, number>
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
const str = (v: unknown) => String(v ?? '').trim()

/** Tolerant column read, mirroring the one in auth-roles. */
function pick(row: any, ...names: string[]): string {
  for (const n of names) {
    for (const k of Object.keys(row || {})) {
      if (norm(k) === norm(n)) return str(row[k])
    }
  }
  return ''
}

function nameOfProfile(p: any): string {
  const full = pick(p, 'employeeName', 'name', 'fullName')
  if (full) return full
  const first = pick(p, 'firstName', 'first')
  const last = pick(p, 'lastName', 'last')
  return [first, last].filter(Boolean).join(' ')
}

/** Everyone who can sign in, with the reason their role resolves as it does. */
export async function listAllAccess(): Promise<AccessAudit> {
  const [users, tables] = await Promise.all([getUsers(), loadAccessTables()])

  const entries: AccessEntry[] = []
  const seen = new Set<string>()

  // 1) The manual list. Checked first by resolveAccess, so it WINS over any
  //    derived role — worth showing plainly, because an employee listed here
  //    keeps this role no matter what the employee tables say.
  for (const u of users) {
    const email = norm(pick(u, 'email', 'e-mail', 'emailaddress', 'email address'))
    const role = norm(pick(u, 'role', 'access', 'tier')) as Role
    if (!email || !role) continue
    seen.add(email)
    const salons = pick(u, 'salons', 'salon', 'salonNums')
    entries.push({
      email,
      name: pick(u, 'name', 'full name', 'fullname', 'display name', 'displayname'),
      role,
      source: 'Users',
      why: 'Listed on the Users tab. This is checked first, so it overrides any role the employee tables would give.',
      salons: salons ? salons.split(/[,\s]+/).filter(Boolean) : [],
      globalId: pick(u, 'globalId', 'global id', 'globalemployeekey'),
      amId: pick(u, 'amId', 'am id', 'am'),
      editable: true,
    })
  }

  // 2) Everyone else resolves through the employee cascade.
  const noEmail: AccessAudit['noEmail'] = []
  let inactiveDenied = 0
  for (const p of tables.profiles) {
    const email = norm(pick(p, 'email'))
    const globalId = pick(p, 'globalId', 'global id', 'globalemployeekey')
    if (!email) {
      if (globalId) {
        noEmail.push({ name: nameOfProfile(p), globalId, salon: pick(p, 'homeSalon', 'salonNum', 'salon') })
      }
      continue
    }
    if (seen.has(email)) continue     // Users tab already won
    seen.add(email)

    // Counted before resolving, so the panel can SAY these are refused rather
    // than just omitting them -- "not listed" and "blocked" look identical.
    if (norm(pick(p, 'inactive')) === 'true') { inactiveDenied++; continue }

    const access: Access | null = employeeAccessFor(email, tables)
    if (!access) continue             // no globalId -> cannot sign in

    let source: AccessSource = 'EmployeeProfile'
    let why = 'A known employee with no other role, so they see only their own numbers.'
    if (access.role === 'area_manager') {
      source = 'AreaManagers'
      why = 'Listed in AreaManagers with at least one current (un-ended) salon assignment.'
    } else if (access.role === 'manager') {
      source = 'ManagerTable'
      why = 'Listed in ManagerTable as the manager of this salon.'
    }

    entries.push({
      email,
      name: nameOfProfile(p),
      role: access.role,
      source,
      why,
      salons: access.salons || [],
      globalId: access.globalId || globalId,
      amId: '',
      editable: false,
    })
  }

  entries.sort((a, b) =>
    a.role === b.role ? a.name.localeCompare(b.name) : a.role.localeCompare(b.role))

  const counts: Record<string, number> = {}
  for (const e of entries) counts[e.role] = (counts[e.role] || 0) + 1

  return { entries, noEmail, inactiveDenied, counts }
}
