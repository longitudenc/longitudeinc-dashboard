// app/api/admin/capabilities/route.ts
//
//   GET                 -> capability metadata + role defaults + current rules
//   POST { email, caps } -> set one PERSON's capabilities
//   POST { role,  caps } -> set a whole ROLE's capabilities
//
// Owner only, same as the Users & Access panel this serves.
//
// The tab stores DEVIATIONS ONLY. A save diffs the requested list against that
// person's role defaults and writes a row only where they differ, so the sheet
// reads as "the exceptions" rather than a wall of redundant yes/no for everyone.
// It also means changing a role default in code takes effect for everybody who
// has not been explicitly excepted, which is the behaviour you want.

import { NextRequest, NextResponse } from 'next/server'
import {requireCapability} from '@/lib/require-role'
import { readSheet, writeSheet } from '@/lib/sheets'
import { resolveAccess } from '@/lib/auth-roles'
import {
  TAB_CAPABILITIES,
  CAPABILITY_META,
  ALL_CAPABILITIES,
  ROLE_DEFAULTS,
  CAPABILITY_REQUIRES,
  FIXED_GATES,
  getCapabilityOverrides,
  roleSubject,
  ROLES,
  type Capability,
} from '@/lib/capabilities'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COLUMNS = ['email', 'capability', 'allow', 'note', 'updatedAt'] as const
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

export async function GET() {
  const gate = await requireCapability('manage.access')
  if (!gate.ok) return gate.response
  try {
    return NextResponse.json({
      success: true,
      meta: CAPABILITY_META,
      roleDefaults: ROLE_DEFAULTS,
      capabilityRequires: CAPABILITY_REQUIRES,
      fixedGates: FIXED_GATES,
      roles: ROLES,
      overrides: await getCapabilityOverrides({ fresh: true }),
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
    const role = norm(body?.role)
    const isRole = !!role

    // One subject, one shape of row. A role rule uses `role:<role>` where a
    // person's uses their address, which keeps the diffing, the read-modify-
    // write and the tab itself identical for both.
    if (isRole && !(ROLES as readonly string[]).includes(role)) {
      return NextResponse.json({ success: false, error: `unknown role "${role}"` }, { status: 400 })
    }
    const email = isRole ? '' : norm(body?.email)
    if (!isRole && (!email || !email.includes('@'))) {
      return NextResponse.json({ success: false, error: 'an email or a role is required' }, { status: 400 })
    }
    const subject = isRole ? roleSubject(role) : email

    const wanted = new Set<Capability>(
      (Array.isArray(body?.caps) ? body.caps : [])
        .map((c: unknown) => norm(c) as Capability)
        .filter((c: Capability) => ALL_CAPABILITIES.includes(c)),
    )

    // Whose defaults are we diffing against? A role rule diffs against that
    // role's code defaults; a person's against their own role's.
    let subjectRole = role
    if (!isRole) {
      const access = await resolveAccess(email)
      if (!access) {
        return NextResponse.json(
          { success: false, error: `${email} has no access at all, so there is nothing to grant. Give them a role first.` },
          { status: 400 },
        )
      }
      subjectRole = access.role
    }

    // Guard the guard, both ways round. Only manage.access opens this panel, so
    // neither a person nor a role may be edited into a state where nobody can
    // get back in. (resolveCapabilities re-adds it for an owner regardless --
    // this is so the panel says why rather than silently ignoring the click.)
    if (!wanted.has('manage.access')) {
      if (!isRole && email === norm(gate.email)) {
        return NextResponse.json(
          { success: false, error: 'Refused: that would remove your own "Manage access", and only that capability opens this panel.' },
          { status: 400 },
        )
      }
      if (isRole && role === 'owner') {
        return NextResponse.json(
          { success: false, error: 'Refused: owners always keep "Manage access" — it is the only way back into this panel.' },
          { status: 400 },
        )
      }
    }

    const defaults = new Set<Capability>(ROLE_DEFAULTS[subjectRole as keyof typeof ROLE_DEFAULTS] || [])
    const stamp = new Date().toISOString().slice(0, 10)

    // Read-modify-write: keep everyone else's rows, replace this person's.
    // MUST be fresh — a cached read here could rewrite the tab from a stale copy.
    const existing = (await readSheet(TAB_CAPABILITIES, undefined, { fresh: true })) as any[][]
    const header = (existing?.[0] || []).map((h: any) => String(h ?? '').trim())
    const emailIdx = header.findIndex(h => norm(h) === 'email')

    const kept: any[][] = []
    if (emailIdx >= 0) {
      for (const row of (existing || []).slice(1)) {
        if (norm(row?.[emailIdx]) !== subject) kept.push(row)
      }
    }

    // Only deviations from the role defaults get a row.
    const added: any[][] = []
    for (const cap of ALL_CAPABILITIES) {
      const want = wanted.has(cap)
      if (want === defaults.has(cap)) continue
      added.push([
        subject,
        cap,
        want ? 'yes' : 'no',
        want ? `granted (not default for ${subjectRole})` : `revoked (default for ${subjectRole})`,
        stamp,
      ])
    }

    const finalHeader = header.length ? header : [...COLUMNS]
    await writeSheet(TAB_CAPABILITIES, [finalHeader, ...kept, ...added])

    return NextResponse.json({
      success: true,
      email: subject,
      role: subjectRole,
      overrides: added.length,
      caps: [...wanted],
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
