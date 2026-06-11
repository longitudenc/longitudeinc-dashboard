// app/api/auth/verify/route.ts
//
// Step 2 of code login. Takes the email + the 6-digit code the person typed,
// verifies it, and on success sets their session cookie (logs them in).
//
// POST body: { email: string, code: string }
// Responses:
//   { ok: true }                          - logged in, cookie set
//   { ok: false, reason: 'invalid' }      - wrong code (or unknown)
//   { ok: false, reason: 'expired' }      - code too old
//   { ok: false, reason: 'locked' }       - too many wrong tries; request a new code
//   { ok: false, reason: 'used' }         - already used

import { NextResponse } from 'next/server'
import { verifyCode } from '@/lib/login-tokens'
import { resolveAccess } from '@/lib/auth-roles'
import { setSession } from '@/lib/session'

export async function POST(request: Request) {
  let email = '', code = ''
  try {
    const body = await request.json()
    email = String(body?.email || '').trim().toLowerCase()
    code = String(body?.code || '').trim()
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid' }, { status: 400 })
  }

  const result = await verifyCode(email, code)
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason })
  }

  // Defense-in-depth: re-confirm this email still maps to a real role before
  // granting a session (e.g. they were removed since the code was issued).
  const access = await resolveAccess(result.email)
  if (!access) {
    return NextResponse.json({ ok: false, reason: 'invalid' })
  }

  await setSession(result.email)
  return NextResponse.json({ ok: true, role: access.role })
}
