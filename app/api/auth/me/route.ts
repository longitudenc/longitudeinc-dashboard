// app/api/auth/me/route.ts
//
// Returns the current signed-in person's email + access (role/scope), or
// { access: null } if not signed in. Used by the client to know who it's
// talking to and what to show. Safe to call from the browser — it only ever
// returns the CALLER's own info, derived from their session cookie.

import { NextResponse } from 'next/server'
import { getSessionEmail } from '@/lib/session'
import { resolveAccess } from '@/lib/auth-roles'
import { getViewAsEmail } from '@/lib/view-as'
import { capabilitiesFor } from '@/lib/capabilities'

export async function GET() {
  const email = await getSessionEmail()
  if (!email) return NextResponse.json({ access: null })
  const access = await resolveAccess(email)
  if (!access) return NextResponse.json({ access: null })

  // While an owner is viewing as someone, report THAT person's access so the
  // client renders their dashboard, plus who is really signed in so the banner
  // can say so. Forgetting you are in View As is the failure mode.
  if (access.role === 'owner') {
    const target = await getViewAsEmail()
    if (target && target !== email.trim().toLowerCase()) {
      const targetAccess = await resolveAccess(target)
      if (targetAccess) {
        const caps = await capabilitiesFor(targetAccess, target)
        return NextResponse.json({ email: target, access: targetAccess, caps: [...caps], viewingAs: target, realEmail: email })
      }
    }
  }
  const caps = await capabilitiesFor(access, email)
  return NextResponse.json({ email, access, caps: [...caps] })
}
