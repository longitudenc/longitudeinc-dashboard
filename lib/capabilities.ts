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
  | 'manage.forms'       // POST /api/forms/access -- audience, wording, who sees responses

export interface CapabilityMeta {
  key: Capability
  label: string
  description: string
  /** Section heading in the Users & Access panel. */
  group: string
}

/** Shown in the Users & Access panel, in this order, under these headings. */
export const CAPABILITY_META: CapabilityMeta[] = [
  { group: 'Reports',    key: 'view.company',    label: 'Company-wide views',  description: 'All-salon tables and totals, not just their own salons.' },
  { group: 'Reports',    key: 'view.dayreview',  label: 'Day Review',          description: 'The whole company on a single day.' },
  { group: 'Reports',    key: 'view.dayofweek',  label: 'Day of Week',         description: 'Weekday comparisons across a date window.' },
  { group: 'Reports',    key: 'view.salondata',  label: 'Ratings & CAQ',       description: 'Google ratings and address quality for our salons.' },
  { group: 'Reports',    key: 'view.market',     label: 'Market Compare',      description: 'Market-wide data, including salons we do not operate.' },

  { group: 'Office',     key: 'view.payroll',    label: 'Payroll tools',       description: 'The ADP upload builder and its settings.' },
  { group: 'Office',     key: 'view.supplies',   label: 'Supply catalogue',    description: 'See which product each supply order option buys.' },
  { group: 'Office',     key: 'edit.supplies',   label: 'Edit the catalogue',  description: 'Change the product a supply order option buys. Needs the line above.' },
  { group: 'Office',     key: 'edit.newsletter', label: 'Build the newsletter', description: 'Write, edit and publish the monthly issue. Everyone can read a published one.' },

  { group: 'Leases',     key: 'view.leases',     label: 'See leases',          description: 'Lease records and documents — rent, terms, landlords, guarantees.' },
  { group: 'Leases',     key: 'edit.leases',     label: 'Edit leases',         description: 'Upload, file, rename and delete lease documents. Needs the line above.' },

  { group: 'Administration', key: 'manage.forms',  label: 'Form settings',     description: 'Who can submit each form, who sees its responses, and its wording.' },
  { group: 'Administration', key: 'edit.settings', label: 'Edit settings',     description: 'Thresholds, assignments, waivers and other admin edits.' },
  { group: 'Administration', key: 'manage.access', label: 'Manage access',     description: 'This panel. Who can sign in and what they can see.' },
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
  ],
  viewer: [
    'view.company', 'view.dayreview', 'view.dayofweek',
    'view.salondata', 'view.market',
  ],
  area_manager: ['view.dayofweek', 'view.salondata'],
  manager: ['view.salondata'],
  // v2: office already had the supply catalogue and the newsletter through the
  // hard-coded lists. Leases they did not, and still do not -- a lease carries
  // rent, guarantees and landlord terms.
  office: ['view.salondata', 'view.market', 'view.payroll', 'view.supplies', 'edit.supplies', 'edit.newsletter'],
  stylist: [],
  maintenance: [],
}

export interface CapabilityOverride {
  email: string
  capability: Capability
  allow: boolean
  note: string
}

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
      if (!email || !ALL_CAPABILITIES.includes(capability)) continue
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
  const mine = overrides.filter(o => o.email === norm(email))
  for (const o of mine) {
    if (o.allow) caps.add(o.capability)
    else caps.delete(o.capability)
  }
  // Enforced HERE rather than in each route, so "may edit but may not see" is
  // not a state the system can be in at all -- however the override rows were
  // written, including by hand in the sheet.
  for (const [cap, needs] of Object.entries(CAPABILITY_REQUIRES)) {
    if (caps.has(cap as Capability) && !caps.has(needs)) caps.delete(cap as Capability)
  }
  return caps
}

/** Convenience: read the overrides and resolve in one step. */
export async function capabilitiesFor(access: Access, email: string): Promise<Set<Capability>> {
  return resolveCapabilities(access, email, await getCapabilityOverrides())
}
