// lib/capabilities.ts
//
// WHAT each role can see, as named capabilities with per-person overrides.
//
// Before this, every gate was a hand-written role list scattered across routes
// and dashboard.html — including a literal `USER_AM_ID === 'kayla'` inside
// canSeeDayReview(). Granting one person one extra screen meant editing code
// and redeploying. Now the defaults live here and exceptions live in a sheet.
//
// TWO THINGS THIS IS NOT:
//
//   1. It is NOT scope. Capabilities answer "which FEATURES", access.salons
//      answers "which ROWS". An AM with view.dayofweek still only sees their
//      own salons, because lib/scope-filter.ts filters the data separately.
//      Keeping these apart is what stops a capability grant from quietly
//      widening someone's data.
//
//   2. It is NOT a client concern. The browser gets the resolved list so it can
//      hide things, but every capability that guards data is ALSO checked
//      server-side via requireCapability(). Hiding a button is not a gate.
//
// The defaults below reproduce the previous role lists EXACTLY. Introducing the
// model should change nobody's access; only an override row should.

import { readSheet, rowsToObjects } from './sheets'
import type { Access, Role } from './auth-roles'

export const TAB_CAPABILITIES = 'Capabilities'

export type Capability =
  | 'manage.access'
  | 'edit.settings'
  | 'view.company'
  | 'view.dayreview'
  | 'view.dayofweek'
  | 'view.market'
  | 'view.salondata'
  | 'view.payroll'
  // CAPABILITIES-v2 -- the office tools, which were gated by role lists written
  // into each route and mirrored by hand in dashboard.html. Each of these is
  // enforced server-side in the routes named beside it; none is a client-only
  // toggle, because a switch the server ignores is worse than no switch.
  | 'view.supplies'      // GET  /api/office/supply-items
  | 'edit.supplies'      // POST /api/office/supply-items
  | 'view.leases'        // GET  /api/leases/*
  | 'edit.leases'        // write /api/leases/*
  | 'edit.newsletter'    // write /api/newsletter/*
  | 'manage.forms'       // POST /api/forms/access, /api/forms/fields, the importers
  // CAPABILITIES-v3 -- the remaining role-shaped guards, so the panel lists
  // everything rather than most things.
  | 'view.points'        // the Disciplinary points screen
  | 'edit.points'        // POST /api/gs/saveDiscPoints, /api/gs/reprocessDiscPoints
  | 'delete.submissions' // DELETE /api/forms/submissions
  | 'run.dataops'        // the rebuild / dedupe / bulk-generate endpoints

export interface CapabilityMeta {
  key: Capability
  label: string
  description: string
  /** Section heading in the Users & Access panel. */
  group: string
  /**
   * What turning this off actually does.
   *
   *   'data'   the API refuses without it. Off means the rows never leave the
   *            server, whatever the browser asks for.
   *   'screen' it chooses which SCREEN appears. The underlying endpoint is
   *            scoped per person anyway (lib/scope-filter), so off means "not
   *            in the menu", not "cannot be reached".
   *
   * Shown in the panel, because "who can see what" is not answerable without
   * knowing which kind of switch you are looking at.
   */
  kind: 'data' | 'screen'
  /** The guard this maps to, quoted in the panel so a claim can be checked. */
  enforcedOn: string
}

/** Shown in the Users & Access panel, in this order, under these headings. */
export const CAPABILITY_META: CapabilityMeta[] = [
  { group: 'Reports', key: 'view.company',   kind: 'screen', enforcedOn: 'company screens',            label: 'Company-wide views',  description: 'All-salon tables and totals, not just their own salons.' },
  { group: 'Reports', key: 'view.dayreview', kind: 'screen', enforcedOn: 'Day Review screen',          label: 'Day Review',          description: 'The whole company on a single day.' },
  { group: 'Reports', key: 'view.dayofweek', kind: 'data',   enforcedOn: 'GET /api/gs/getDailyRange',  label: 'Day of Week',         description: 'Weekday comparisons across a date window.' },
  { group: 'Reports', key: 'view.salondata', kind: 'data',   enforcedOn: 'GET /api/market/caq, /api/market/ratings-data', label: 'Ratings & CAQ', description: 'Google ratings and address quality for our salons.' },
  { group: 'Reports', key: 'view.market',    kind: 'data',   enforcedOn: 'GET /api/market/data',       label: 'Market Compare',      description: 'Market-wide data, including salons we do not operate.' },

  { group: 'People',  key: 'view.points',    kind: 'screen', enforcedOn: 'Disciplinary points screen', label: 'Disciplinary points', description: 'The points screen. Everyone can already see their own; this is other people\'s, within their salons.' },
  { group: 'People',  key: 'edit.points',    kind: 'data',   enforcedOn: 'POST /api/gs/saveDiscPoints, /api/gs/reprocessDiscPoints', label: 'Award & edit points', description: 'Add, change or clear disciplinary points. Needs the line above.' },

  { group: 'Office',  key: 'view.payroll',   kind: 'data',   enforcedOn: 'all /api/office/payroll/*',  label: 'Payroll tools',       description: 'The ADP upload builder, its settings and the finalised files.' },
  { group: 'Office',  key: 'view.supplies',  kind: 'data',   enforcedOn: 'GET /api/office/supply-items', label: 'Supply catalogue',  description: 'See which product each supply order option buys.' },
  { group: 'Office',  key: 'edit.supplies',  kind: 'data',   enforcedOn: 'POST /api/office/supply-items', label: 'Edit the catalogue', description: 'Change the product a supply order option buys. Needs the line above.' },
  { group: 'Office',  key: 'edit.newsletter',kind: 'data',   enforcedOn: 'write /api/newsletter/*',    label: 'Build the newsletter', description: 'Write, edit and publish the monthly issue. Everyone can read a published one.' },

  { group: 'Leases',  key: 'view.leases',    kind: 'data',   enforcedOn: 'GET /api/leases/*',          label: 'See leases',          description: 'Lease records and documents — rent, terms, landlords, guarantees.' },
  { group: 'Leases',  key: 'edit.leases',    kind: 'data',   enforcedOn: 'write /api/leases/*',        label: 'Edit leases',         description: 'Upload, file, rename and delete lease documents. Needs the line above.' },

  { group: 'Forms',   key: 'manage.forms',   kind: 'data',   enforcedOn: 'POST /api/forms/access, /api/forms/fields', label: 'Form settings & questions', description: 'Who can submit each form, who sees its responses, its wording and its questions.' },
  { group: 'Forms',   key: 'delete.submissions', kind: 'data', enforcedOn: 'DELETE /api/forms/submissions', label: 'Delete submissions', description: 'Remove a submission and its comments for good. For test rows, not for outcomes.' },

  { group: 'Administration', key: 'edit.settings', kind: 'data', enforcedOn: 'POST /api/gs/save*, /api/home/save', label: 'Edit settings', description: 'Thresholds, AM assignments, manager table, waivers and the home page.' },
  { group: 'Administration', key: 'run.dataops',   kind: 'data', enforcedOn: 'POST /api/gs/triggerProcessAndLoad and the other rebuild endpoints', label: 'Run data jobs', description: 'Rebuild, de-duplicate and bulk-generate. Heavy, and it rewrites shared tabs.' },
  { group: 'Administration', key: 'manage.access', kind: 'data', enforcedOn: 'GET/POST /api/admin/users, /api/admin/capabilities', label: 'Manage access', description: 'This panel. Who can sign in and what they can see.' },
]

/** Group headings in the order the panel should show them. */
export const CAPABILITY_GROUPS: string[] = CAPABILITY_META
  .map(c => c.group)
  .filter((g, i, a) => a.indexOf(g) === i)

// An edit capability is meaningless without the matching view: you cannot
// change a catalogue you cannot open. The panel pairs the checkboxes, and
// resolveCapabilities() drops an edit whose view is missing -- so a row typed
// straight into the sheet cannot create the state either.
export const CAPABILITY_REQUIRES: Partial<Record<Capability, Capability>> = {
  'edit.supplies': 'view.supplies',
  'edit.leases': 'view.leases',
  'edit.points': 'view.points',
}

// NOTE: there is deliberately no 'view.points' capability yet. The points
// tracker is gated by requireSignedIn() and scoped internally, and a stylist can
// see their own. A toggle here before anything enforced it would be a control
// that silently does nothing -- worse than not offering it at all.
export const ALL_CAPABILITIES: Capability[] = CAPABILITY_META.map(c => c.key)

/**
 * Role defaults. These MIRROR the guards that existed before this file. The two
 * that existed ONLY for these gates (requireMarketView, requireSalonView) are now
 * removed; the rest are still used for role-shaped checks:
 *   manage.access  = requireOwner          view.market     = requireMarketView
 *   edit.settings  = requireAdmin          view.salondata  = requireSalonView
 *   view.payroll   = requireOffice         view.company    = canSeeAllSalons()
 *   view.dayofweek = canSeeDayOfWeek()     view.dayreview  = canSeeDayReview()
 */
export const ROLE_DEFAULTS: Record<Role, Capability[]> = {
  owner: [...ALL_CAPABILITIES],
  admin: [
    'view.company', 'view.dayreview', 'view.dayofweek',
    'view.salondata', 'view.market', 'view.payroll', 'edit.settings',
    // v2: exactly what admins could already do -- requireAdmin on /api/leases
    // and /api/forms/access, and the owner/admin/office list in the newsletter
    // and supply routes.
    'view.supplies', 'edit.supplies', 'view.leases', 'edit.leases',
    'edit.newsletter', 'manage.forms',
    // v3: requireAdmin on the points writers, the submission delete and the
    // data jobs; the points screen was isAdminRole() || isAMRole().
    'view.points', 'edit.points', 'delete.submissions', 'run.dataops',
  ],
  viewer: [
    'view.company', 'view.dayreview', 'view.dayofweek',
    'view.salondata', 'view.market',
  ],
  // v3: an AM could always open the points screen (isAdminRole() || isAMRole())
  // and it is salon-scoped for them. Awarding points was admin-only and stays so.
  area_manager: ['view.dayofweek', 'view.salondata', 'view.points'],
  manager: ['view.salondata'],
  // v2: office already had the supply catalogue and the newsletter through the
  // hard-coded lists. Leases they did not, and still do not -- a lease carries
  // rent, guarantees and landlord terms.
  office: ['view.salondata', 'view.market', 'view.payroll', 'view.supplies', 'edit.supplies', 'edit.newsletter'],
  stylist: [],
  maintenance: [],
}

/**
 * Guards that are deliberately NOT capabilities, listed so the panel can show
 * them. Three of them are fixed to a role; the rest are machine-only and have
 * no user access at all.
 *
 * These are not toggles because nothing good comes of moving them: a health
 * probe and a full data wipe are not access levels, they are operations.
 */
export interface FixedGate { what: string; who: string; where: string }
export const FIXED_GATES: FixedGate[] = [
  { what: 'Wipe all data',       who: 'Owner only',  where: 'POST /api/gs/clearAllData' },
  { what: 'Salon roster (raw)',  who: 'Admin & up',  where: 'GET /api/gs/getSalonRoster' },
  { what: 'Nightly health check', who: 'Admin & up', where: 'GET /api/health/daily-check' },
  { what: 'View As',             who: 'Owner only',  where: 'POST /api/admin/view-as — checks the REAL session, so it cannot be chained' },
  { what: 'Scrapers, crons and ingest', who: 'No user — a shared secret',
    where: '34 endpoints under /api/scrape, /api/cron, /api/market/ingest, checked against CRON_SECRET' },
  { what: 'Sign in',             who: 'Anyone with a roster email', where: '/api/auth/* — a magic link, then the role decides the rest' },
]

/**
 * Every role, in the order the access matrix shows them. Derived from
 * ROLE_DEFAULTS so the list of roles and the list of what roles get can never
 * disagree about which roles exist.
 */
export const ROLES = Object.keys(ROLE_DEFAULTS) as Role[]

export interface CapabilityOverride {
  /** An address, or `role:<role>` for a rule that applies to a whole role. */
  email: string
  capability: Capability
  allow: boolean
  note: string
}

/** The `email` value that carries a rule for a whole role. */
export const roleSubject = (role: string) => 'role:' + String(role).trim().toLowerCase()
export const isRoleSubject = (v: string) => String(v).startsWith('role:')

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
const isYes = (s: unknown) => ['yes', 'true', '1', 'y', 'allow', 'grant'].includes(norm(s))

/**
 * Per-person exceptions. Tolerant of a missing tab: no overrides simply means
 * everyone gets their role defaults, which is the pre-existing behaviour.
 */
export async function getCapabilityOverrides(opts?: { fresh?: boolean }): Promise<CapabilityOverride[]> {
  try {
    const rows = rowsToObjects((await readSheet(TAB_CAPABILITIES, undefined, opts)) || [])
    const out: CapabilityOverride[] = []
    for (const r of rows) {
      const email = norm(r.email)
      const capability = norm(r.capability) as Capability
      // A subject is an address or `role:<role>`; anything else is a typo, and
      // a typo must not silently become a rule that matches nobody and looks
      // like it matches somebody.
      if (!email.includes('@') && !isRoleSubject(email)) continue
      if (!ALL_CAPABILITIES.includes(capability)) continue
      out.push({ email, capability, allow: isYes(r.allow), note: String(r.note ?? '').trim() })
    }
    return out
  } catch {
    return []
  }
}

/**
 * The capabilities `access` actually has. `email` is the EFFECTIVE identity —
 * while an owner is viewing as someone, it is that person's email, so View As
 * shows their overrides too rather than the owner's.
 */
export function resolveCapabilities(
  access: Access,
  email: string,
  overrides: CapabilityOverride[],
): Set<Capability> {
  const caps = new Set<Capability>(ROLE_DEFAULTS[access.role] || [])

  // Three layers, narrowest last: what the role gets in code, then what has
  // been changed for the ROLE, then what has been changed for the PERSON. A
  // person's own row therefore survives a later change to their role, which is
  // the behaviour you want -- the exception was made for a reason.
  const forRole = overrides.filter(o => o.email === roleSubject(access.role))
  const forPerson = overrides.filter(o => o.email === norm(email))
  for (const o of [...forRole, ...forPerson]) {
    if (o.allow) caps.add(o.capability)
    else caps.delete(o.capability)
  }
  // Enforced HERE rather than in each route, so "may edit but may not see" is
  // not a state the system can be in at all -- however the override rows were
  // written, including by hand in the sheet.
  for (const [cap, needs] of Object.entries(CAPABILITY_REQUIRES)) {
    if (caps.has(cap as Capability) && !caps.has(needs)) caps.delete(cap as Capability)
  }

  // An owner ALWAYS keeps the access panel. /api/admin/users and
  // /api/admin/capabilities now check manage.access rather than the owner
  // role, which means a wrong click -- or a hand-typed sheet row -- could
  // otherwise take away the only screen that could put it back.
  if (access.role === 'owner') caps.add('manage.access')

  return caps
}

/** Convenience: read the overrides and resolve in one step. */
export async function capabilitiesFor(access: Access, email: string): Promise<Set<Capability>> {
  return resolveCapabilities(access, email, await getCapabilityOverrides())
}
