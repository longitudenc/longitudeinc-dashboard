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

export interface CapabilityMeta {
  key: Capability
  label: string
  description: string
}

/** Shown in the Users & Access panel, in this order. */
export const CAPABILITY_META: CapabilityMeta[] = [
  { key: 'view.company',   label: 'Company-wide views',  description: 'All-salon tables and totals, not just their own salons.' },
  { key: 'view.dayreview', label: 'Day Review',          description: 'The whole company on a single day.' },
  { key: 'view.dayofweek', label: 'Day of Week',         description: 'Weekday comparisons across a date window.' },
  { key: 'view.salondata', label: 'Ratings & CAQ',       description: 'Google ratings and address quality for our salons.' },
  { key: 'view.market',    label: 'Market Compare',      description: 'Market-wide data, including salons we do not operate.' },
  { key: 'view.payroll',   label: 'Payroll tools',       description: 'The ADP upload builder and its settings.' },
  { key: 'edit.settings',  label: 'Edit settings',       description: 'Thresholds, assignments, waivers and other admin edits.' },
  { key: 'manage.access',  label: 'Manage access',       description: 'This panel. Who can sign in and what they can see.' },
]

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
  ],
  viewer: [
    'view.company', 'view.dayreview', 'view.dayofweek',
    'view.salondata', 'view.market',
  ],
  area_manager: ['view.dayofweek', 'view.salondata'],
  manager: ['view.salondata'],
  office: ['view.salondata', 'view.market', 'view.payroll'],
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
  return caps
}

/** Convenience: read the overrides and resolve in one step. */
export async function capabilitiesFor(access: Access, email: string): Promise<Set<Capability>> {
  return resolveCapabilities(access, email, await getCapabilityOverrides())
}
