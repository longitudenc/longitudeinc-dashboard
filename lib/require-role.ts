// lib/require-role.ts
//
// Server-side guards for protecting API routes. Each reads the session cookie,
// resolves the person's role, and returns their access or an error response.
//
// Usage in a route:
//   const gate = await requireAdmin()
//   if (!gate.ok) return gate.response
//   // ...gate.access has { role, globalId?, salons? }

import { NextResponse } from 'next/server'
import { getSessionEmail } from './session'
import { getViewAsEmail } from './view-as'
import { resolveAccess, type Access, type Role } from './auth-roles'
import { capabilitiesFor, type Capability } from './capabilities'

type GateOk = {
  ok: true
  /** The access to ENFORCE. While viewing as someone, this is THEIR access. */
  access: Access
  email: string
  /** The signed-in person's own access, unaffected by View As. */
  realAccess: Access
  /** Set only while an owner is viewing as someone else. */
  viewingAs?: string
  /** Whose capabilities apply: the impersonated person when viewing as. */
  effectiveEmail: string
}
type GateFail = { ok: false; response: NextResponse }

async function requireRoles(allowed: Role[]): Promise<GateOk | GateFail> {
  const email = await getSessionEmail()
  if (!email) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'not signed in' }, { status: 401 }) }
  }
  const realAccess = await resolveAccess(email)
  if (!realAccess) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'no access' }, { status: 403 }) }
  }

  // VIEW AS. Honoured ONLY when the real session is an owner, so a forged
  // cookie gains nothing. Swapping here rather than in the client is the
  // entire point: every route below now genuinely enforces the target's
  // scope, which is what makes this useful for finding holes.
  let access = realAccess
  let viewingAs: string | undefined
  if (realAccess.role === 'owner') {
    const target = await getViewAsEmail()
    if (target && target !== email.trim().toLowerCase()) {
      const targetAccess = await resolveAccess(target)
      // A target with no access falls back to the owner's own view rather
      // than locking them out of a session they cannot easily escape.
      if (targetAccess) { access = targetAccess; viewingAs = target }
    }
  }

  if (!allowed.includes(access.role)) {
    return {
      ok: false,
      response: NextResponse.json({
        success: false,
        error: viewingAs
          ? `insufficient permissions — you are viewing as ${viewingAs}, who cannot see this`
          : 'insufficient permissions',
        ...(viewingAs ? { viewAs: viewingAs } : {}),
      }, { status: 403 }),
    }
  }
  return { ok: true, access, email, realAccess, viewingAs, effectiveEmail: viewingAs || email.trim().toLowerCase() }
}

// Owner OR admin — for business edits (disc points, assignments, waivers, etc.)
export function requireAdmin() {
  return requireRoles(['owner', 'admin'])
}

// Owner only — for the most sensitive surface (the access/Users list).
export function requireOwner() {
  return requireRoles(['owner'])
}

// Owner, admin, or the back-office staff who actually run payroll. Gates
// everything under /api/office — the ADP upload builder and its settings.
export function requireOffice() {
  return requireRoles(['owner', 'admin', 'office'])
}

// Any signed-in person with a real role — for reads that still need a session.
export function requireSignedIn() {
  return requireRoles(['owner', 'admin', 'viewer', 'area_manager', 'manager', 'stylist', 'office', 'maintenance'])
}


// Gate on a named capability rather than a hard-coded role list. Role defaults
// live in lib/capabilities.ts and per-person overrides live in the Capabilities
// tab, so granting one person one screen no longer means editing code.
//
// Capabilities decide WHICH FEATURES. They do NOT widen data: lib/scope-filter.ts
// still trims rows to access.salons, so an AM granted a company screen sees that
// screen over their own salons only.
export async function requireCapability(cap: Capability) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate
  const caps = await capabilitiesFor(gate.access, gate.effectiveEmail)
  if (!caps.has(cap)) {
    return {
      ok: false as const,
      response: NextResponse.json({
        success: false,
        error: gate.viewingAs
          ? `insufficient permissions — you are viewing as ${gate.viewingAs}, who does not have "${cap}"`
          : `insufficient permissions (${cap})`,
      }, { status: 403 }),
    }
  }
  return gate
}
