// lib/view-as.ts
//
// "View as" — let an owner see the app exactly as another person sees it.
//
// The point is to find holes, so it is resolved SERVER-side: it swaps the
// Access that requireRoles() hands to every route, which means the APIs
// genuinely withhold data. A client-only version that flipped SESSION.role
// would have rendered a perfectly convincing stylist dashboard while
// /api/gs/getDailyRange was still returning every salon — it would have proved
// nothing about what the server actually enforces, which is the whole question.
//
// Two properties do the security work:
//
//   1. The cookie is only ever honoured when the REAL session resolves to
//      owner. Anyone else setting it by hand gets nothing — their real access
//      is computed first and the cookie is ignored.
//   2. It is READ-ONLY. middleware.ts refuses every non-GET /api request while
//      it is active, so nothing can be written under someone else's name. An
//      audit trail that says a person did something they did not do is worse
//      than no audit trail.
//
// The value is signed with the same HMAC as the session cookie. Forging it is
// already useless because of (1), but signing costs nothing and keeps the
// cookie honest if the owner check is ever moved.

import { cookies } from 'next/headers'
import { sessionValue, readSessionValue } from './session'
import { VIEW_AS_COOKIE } from './view-as-cookie'

export { VIEW_AS_COOKIE }

/** Who the owner is currently impersonating, or null. Signature-checked. */
export async function getViewAsEmail(): Promise<string | null> {
  const jar = await cookies()
  return readSessionValue(jar.get(VIEW_AS_COOKIE)?.value)
}

/** Begin viewing as `email`. Caller MUST have verified the real session is owner. */
export async function setViewAs(email: string): Promise<void> {
  const jar = await cookies()
  jar.set(VIEW_AS_COOKIE, sessionValue(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // Deliberately a SESSION cookie (no maxAge): closing the browser ends it.
    // The failure mode here is forgetting you are in it, so it should not
    // survive for 30 days the way the real session does.
  })
}

export async function clearViewAs(): Promise<void> {
  const jar = await cookies()
  jar.delete(VIEW_AS_COOKIE)
}
