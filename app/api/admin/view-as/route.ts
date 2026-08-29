// app/api/admin/view-as/route.ts
//
//   POST   { email }  -> start viewing the app as that person   (owner only)
//   DELETE            -> stop                                   (anyone)
//
// Exiting is deliberately open to any signed-in session: clearing the cookie
// only ever REDUCES what you can see, and the one thing worse than not having
// this feature is not being able to get out of it.
//
// The read-only rule is enforced in middleware.ts, not here.

import { NextRequest, NextResponse } from 'next/server'
import { getSessionEmail } from '@/lib/session'
import { resolveAccess } from '@/lib/auth-roles'
import { setViewAs, clearViewAs, getViewAsEmail } from '@/lib/view-as'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

export async function POST(req: NextRequest) {
  const email = await getSessionEmail()
  if (!email) {
    return NextResponse.json({ success: false, error: 'not signed in' }, { status: 401 })
  }

  // The REAL session decides, never the current (possibly impersonated) view —
  // otherwise an owner could view as an admin and then hop onward from there.
  const real = await resolveAccess(email)
  if (!real || real.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'owner only' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const target = norm(body?.email)
  if (!target || !target.includes('@')) {
    return NextResponse.json({ success: false, error: 'an email is required' }, { status: 400 })
  }
  if (target === norm(email)) {
    return NextResponse.json({ success: false, error: 'that is already you' }, { status: 400 })
  }

  // Refuse a target the app would not let in anyway, so "View As" can never
  // manufacture access that does not otherwise exist.
  const targetAccess = await resolveAccess(target)
  if (!targetAccess) {
    return NextResponse.json(
      { success: false, error: `${target} has no access, so there is nothing to view as. (Departed employees resolve to no access.)` },
      { status: 400 },
    )
  }

  await setViewAs(target)
  return NextResponse.json({ success: true, viewingAs: target, role: targetAccess.role })
}

export async function DELETE() {
  const email = await getSessionEmail()
  if (!email) {
    return NextResponse.json({ success: false, error: 'not signed in' }, { status: 401 })
  }
  await clearViewAs()
  return NextResponse.json({ success: true, viewingAs: null })
}

export async function GET() {
  const email = await getSessionEmail()
  if (!email) return NextResponse.json({ viewingAs: null })
  return NextResponse.json({ viewingAs: await getViewAsEmail() })
}
