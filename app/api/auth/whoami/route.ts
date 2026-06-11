// app/api/auth/whoami/route.ts
//
// TEST / DEBUG ROUTE for the auth mapping (Part 2). Lets you verify what role
// and scope an email resolves to, BEFORE magic-link login exists.
//
//   GET /api/auth/whoami?secret=CRON_SECRET&email=someone@example.com
//
// Secret-gated so it isn't a public role-lookup (it would otherwise reveal who
// is an admin). Once real login is wired, the same resolveAccess() runs from
// the session — this route stays only as a debugging aid.

import { NextResponse } from 'next/server'
import { resolveAccess } from '@/lib/auth-roles'

function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const url = new URL(request.url)
  const email = url.searchParams.get('email') || ''
  if (!email) {
    return NextResponse.json({ ok: false, error: 'email param required' }, { status: 400 })
  }
  const access = await resolveAccess(email)
  return NextResponse.json({
    ok: true,
    email: email.trim().toLowerCase(),
    access, // { role, globalId?, salons? } or null = no access
  })
}
