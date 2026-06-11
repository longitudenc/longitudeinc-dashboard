// app/api/auth/me/route.ts
//
// Returns the current signed-in person's email + access (role/scope), or
// { access: null } if not signed in. Used by the client to know who it's
// talking to and what to show. Safe to call from the browser — it only ever
// returns the CALLER's own info, derived from their session cookie.

import { NextResponse } from 'next/server'
import { getSessionEmail } from '@/lib/session'
import { resolveAccess } from '@/lib/auth-roles'

export async function GET() {
  const email = await getSessionEmail()
  if (!email) return NextResponse.json({ access: null })
  const access = await resolveAccess(email)
  if (!access) return NextResponse.json({ access: null })
  return NextResponse.json({ email, access })
}
