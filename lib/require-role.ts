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
import { resolveAccess, type Access, type Role } from './auth-roles'

type GateOk = { ok: true; access: Access; email: string }
type GateFail = { ok: false; response: NextResponse }

async function requireRoles(allowed: Role[]): Promise<GateOk | GateFail> {
  const email = await getSessionEmail()
  if (!email) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'not signed in' }, { status: 401 }) }
  }
  const access = await resolveAccess(email)
  if (!access) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'no access' }, { status: 403 }) }
  }
  if (!allowed.includes(access.role)) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'insufficient permissions' }, { status: 403 }) }
  }
  return { ok: true, access, email }
}

// Owner OR admin — for business edits (disc points, assignments, waivers, etc.)
export function requireAdmin() {
  return requireRoles(['owner', 'admin'])
}

// Owner only — for the most sensitive surface (the access/Users list).
export function requireOwner() {
  return requireRoles(['owner'])
}

// Any signed-in person with a real role — for reads that still need a session.
export function requireSignedIn() {
  return requireRoles(['owner', 'admin', 'viewer', 'area_manager', 'manager', 'stylist'])
}
