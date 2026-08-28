// app/api/admin/capabilities/route.ts
//
//   GET               -> capability metadata + role defaults + current overrides
//   POST { email, caps } -> set one person's capabilities
//
// Owner only, same as the Users & Access panel this serves.
//
// The tab stores DEVIATIONS ONLY. A save diffs the requested list against that
// person's role defaults and writes a row only where they differ, so the sheet
// reads as "the exceptions" rather than a wall of redundant yes/no for everyone.
// It also means changing a role default in code takes effect for everybody who
// has not been explicitly excepted, which is the behaviour you want.

import { NextRequest, NextResponse } from 'next/server'
import { requireOwner } from '@/lib/require-role'
import { readSheet, writeSheet } from '@/lib/sheets'
import { resolveAccess } from '@/lib/auth-roles'
import {
  TAB_CAPABILITIES,
  CAPABILITY_META,
  ALL_CAPABILITIES,
  ROLE_DEFAULTS,
  getCapabilityOverrides,
  type Capability,
} from '@/lib/capabilities'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COLUMNS = ['email', 'capability', 'allow', 'note', 'updatedAt'] as const
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

export async function GET() {
  const gate = await requireOwner()
  if (!gate.ok) return gate.response
  try {
    return NextResponse.json({
      success: true,
      meta: CAPABILITY_META,
      roleDefaults: ROLE_DEFAULTS,
      overrides: await getCapabilityOverrides({ fresh: true }),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const email = norm(body?.email)
    if (!email || !email.includes('@')) {
      return NextResponse.json({ success: false, error: 'an email is required' }, { status: 400 })
    }

    const wanted = new Set<Capability>(
      (Array.isArray(body?.caps) ? body.caps : [])
        .map((c: unknown) => norm(c) as Capability)
        .filter((c: Capability) => ALL_CAPABILITIES.includes(c)),
    )

    // Whose defaults are we diffing against? Resolve their real role.
    const access = await resolveAccess(email)
    if (!access) {
      return NextResponse.json(
        { success: false, error: `${email} has no access at all, so there is nothing to grant. Give them a role first.` },
        { status: 400 },
      )
    }

    // Guard the guard: an owner must not be able to revoke their own ability to
    // reach this panel, which would be unrecoverable from inside the app.
    if (email === norm(gate.email) && !wanted.has('manage.access')) {
      return NextResponse.json(
        { success: false, error: 'Refused: that would remove your own "Manage access", and only that capability opens this panel.' },
        { status: 400 },
      )
    }

    const defaults = new Set<Capability>(ROLE_DEFAULTS[access.role] || [])
    const stamp = new Date().toISOString().slice(0, 10)

    // Read-modify-write: keep everyone else's rows, replace this person's.
    // MUST be fresh — a cached read here could rewrite the tab from a stale copy.
    const existing = (await readSheet(TAB_CAPABILITIES, undefined, { fresh: true })) as any[][]
    const header = (existing?.[0] || []).map((h: any) => String(h ?? '').trim())
    const emailIdx = header.findIndex(h => norm(h) === 'email')

    const kept: any[][] = []
    if (emailIdx >= 0) {
      for (const row of (existing || []).slice(1)) {
        if (norm(row?.[emailIdx]) !== email) kept.push(row)
      }
    }

    // Only deviations from the role defaults get a row.
    const added: any[][] = []
    for (const cap of ALL_CAPABILITIES) {
      const want = wanted.has(cap)
      if (want === defaults.has(cap)) continue
      added.push([
        email,
        cap,
        want ? 'yes' : 'no',
        want ? `granted (not default for ${access.role})` : `revoked (default for ${access.role})`,
        stamp,
      ])
    }

    const finalHeader = header.length ? header : [...COLUMNS]
    await writeSheet(TAB_CAPABILITIES, [finalHeader, ...kept, ...added])

    return NextResponse.json({
      success: true,
      email,
      role: access.role,
      overrides: added.length,
      caps: [...wanted],
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
