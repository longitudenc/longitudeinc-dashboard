// app/api/admin/users/route.ts
//
// The Users & Access control panel.
//
//   GET  -> every login the app will accept, with WHERE each role comes from
//   POST -> rewrite the Users tab (the manual list) from the panel
//
// Owner only. requireCapability('manage.access') already describes itself as being for "the most
// sensitive surface (the access/Users list)" — this is that surface.
//
// The Users tab is the one place a role is ASSIGNED rather than derived, so it
// is the only thing POST may touch. Derived roles (AM / manager / stylist) are
// changed by changing the underlying assignment, not here.

import { NextRequest, NextResponse } from 'next/server'
import {requireCapability} from '@/lib/require-role'
import { readSheet, writeSheet } from '@/lib/sheets'
import { listAllAccess } from '@/lib/access-audit'
import {
  CAPABILITY_META, CAPABILITY_REQUIRES, ROLE_DEFAULTS, ROLES, FIXED_GATES,
  ALL_CAPABILITIES, getCapabilityOverrides, roleSubject,
  type Capability,
} from '@/lib/capabilities'
import type { Role } from '@/lib/auth-roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TAB = 'Users'

const VALID_ROLES: Role[] = [
  'owner', 'admin', 'viewer', 'area_manager', 'manager', 'stylist', 'office', 'maintenance',
]

// The columns the panel edits. Any OTHER column already on the tab is preserved
// as-is, so a note or a column someone added by hand does not get wiped by a save.
// globalId and amId are deliberately ABSENT. Neither is read anywhere:
// resolveAccess never returns amId, and USER_AM_ID is derived client-side from
// SESSION.globalId against the AMS constant. An editable field for a value
// nothing consumes just invites someone to set it and expect an effect.
// Existing cells (Kayla has amId=kayla) survive via the preserve-unknown-
// columns path below, which copies any column the panel does not know about.
const CANON = ['email', 'role', 'name', 'salons'] as const

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
const str = (s: unknown) => String(s ?? '').trim()

/** Which existing header cell corresponds to a canonical field, if any. */
function headerIndex(header: string[], field: string): number {
  const aliases: Record<string, string[]> = {
    email: ['email', 'e-mail', 'emailaddress', 'email address'],
    role: ['role', 'access', 'tier'],
    name: ['name', 'full name', 'fullname', 'display name', 'displayname'],
    salons: ['salons', 'salon', 'salonnums'],
  }
  const want = aliases[field] || [field]
  return header.findIndex(h => want.includes(norm(h)))
}

/**
 * What each ROLE actually has right now: its code defaults, plus any role rule
 * saved in the Capabilities tab. Deliberately NOT resolveCapabilities() -- that
 * answers for a PERSON and would fold in their individual exceptions, which is
 * the wrong question for a matrix whose columns are roles.
 */
async function effectiveRoleCaps(): Promise<Record<string, Capability[]>> {
  const rules = await getCapabilityOverrides({ fresh: true })
  const out: Record<string, Capability[]> = {}
  for (const role of ROLES) {
    const caps = new Set<Capability>(ROLE_DEFAULTS[role] || [])
    for (const r of rules.filter(x => x.email === roleSubject(role))) {
      if (r.allow) caps.add(r.capability)
      else caps.delete(r.capability)
    }
    if (role === 'owner') caps.add('manage.access')     // mirrors resolveCapabilities
    out[role] = ALL_CAPABILITIES.filter(c => caps.has(c))
  }
  return out
}

export async function GET() {
  const gate = await requireCapability('manage.access')
  if (!gate.ok) return gate.response
  try {
    const audit = await listAllAccess()
    return NextResponse.json({
      success: true, ...audit,
      validRoles: VALID_ROLES,
      capabilityMeta: CAPABILITY_META,
      roleDefaults: ROLE_DEFAULTS,
      // Which capabilities depend on which, so the panel cannot offer an edit
      // grant without the view it needs.
      capabilityRequires: CAPABILITY_REQUIRES,
      // CAPABILITIES-v3. Everything the "who can see what" matrix needs: the
      // roles, what each one EFFECTIVELY has (code defaults plus any role rule
      // saved against it), and the guards that are deliberately not toggles.
      roles: ROLES,
      roleCaps: await effectiveRoleCaps(),
      fixedGates: FIXED_GATES,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireCapability('manage.access')
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const incoming: any[] = Array.isArray(body?.rows) ? body.rows : []

    // ---- Validate before writing anything -----------------------------------
    const clean: Record<string, string>[] = []
    const seen = new Set<string>()
    for (const r of incoming) {
      const email = norm(r?.email)
      const role = norm(r?.role)
      if (!email && !role) continue                 // a blank row the panel left behind
      if (!email || !email.includes('@')) {
        return NextResponse.json({ success: false, error: `"${str(r?.email)}" is not a valid email address.` }, { status: 400 })
      }
      if (!VALID_ROLES.includes(role as Role)) {
        return NextResponse.json({ success: false, error: `"${str(r?.role)}" is not a role. Valid roles: ${VALID_ROLES.join(', ')}` }, { status: 400 })
      }
      if (seen.has(email)) {
        return NextResponse.json({ success: false, error: `${email} appears more than once. resolveAccess takes the first match, so a duplicate would silently win.` }, { status: 400 })
      }
      seen.add(email)
      clean.push({
        email,
        role,
        name: str(r?.name),
        salons: Array.isArray(r?.salons) ? r.salons.join(' ') : str(r?.salons),
      })
    }

    // ---- Lockout guards ------------------------------------------------------
    // The Users tab is the ONLY way an owner exists. Saving a list with no owner,
    // or one that drops the person doing the saving, locks everybody out of this
    // panel permanently — there is no other route back in.
    if (!clean.some(r => r.role === 'owner')) {
      return NextResponse.json(
        { success: false, error: 'Refused: that would leave no owner, and only an owner can open this panel.' },
        { status: 400 },
      )
    }
    const me = norm(gate.email)
    if (!clean.some(r => r.email === me && r.role === 'owner')) {
      return NextResponse.json(
        { success: false, error: `Refused: that would remove your own owner access (${gate.email}). Have another owner make this change if it is intended.` },
        { status: 400 },
      )
    }

    // ---- Write, preserving any columns the panel does not know about ---------
    // Read-modify-write, so it MUST read fresh: a cached read here could rewrite
    // the tab from a stale copy and silently drop a concurrent edit.
    const existing = (await readSheet(TAB, undefined, { fresh: true })) as any[][]
    const header: string[] = (existing?.[0] || []).map((h: any) => str(h))
    const finalHeader = header.length ? [...header] : [...CANON]

    // Add any canonical column the tab is missing rather than reordering it.
    for (const f of CANON) {
      if (headerIndex(finalHeader, f) < 0) finalHeader.push(f)
    }

    // Keep unknown columns by matching the old row on email.
    const oldByEmail = new Map<string, any[]>()
    const oldEmailIdx = headerIndex(header, 'email')
    if (oldEmailIdx >= 0) {
      for (const row of (existing || []).slice(1)) {
        const em = norm(row?.[oldEmailIdx])
        if (em) oldByEmail.set(em, row)
      }
    }

    const rows: any[][] = [finalHeader]
    for (const r of clean) {
      const prior = oldByEmail.get(r.email) || []
      const out: any[] = finalHeader.map((h, i) => {
        // Default to whatever that column held before (preserves unknown columns).
        const oldIdx = headerIndex(header, str(h)) >= 0 ? headerIndex(header, str(h)) : i
        return prior[oldIdx] ?? ''
      })
      for (const f of CANON) {
        const idx = headerIndex(finalHeader, f)
        if (idx >= 0) out[idx] = r[f] ?? ''
      }
      rows.push(out)
    }

    await writeSheet(TAB, rows)
    const audit = await listAllAccess()
    return NextResponse.json({
      success: true, saved: clean.length, ...audit,
      validRoles: VALID_ROLES,
      capabilityMeta: CAPABILITY_META,
      roleDefaults: ROLE_DEFAULTS,
      // Which capabilities depend on which, so the panel cannot offer an edit
      // grant without the view it needs.
      capabilityRequires: CAPABILITY_REQUIRES,
      // CAPABILITIES-v3. Everything the "who can see what" matrix needs: the
      // roles, what each one EFFECTIVELY has (code defaults plus any role rule
      // saved against it), and the guards that are deliberately not toggles.
      roles: ROLES,
      roleCaps: await effectiveRoleCaps(),
      fixedGates: FIXED_GATES,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
