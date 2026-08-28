// middleware.ts
//
// Makes "View as" READ-ONLY, in one place.
//
// While an owner is impersonating someone, every non-GET request to /api is
// refused. This lives in middleware rather than in each write route on purpose:
// a check you have to remember to add to every new route is one that will
// eventually be forgotten, and the failure would be silent — a write landing
// under someone else's name, with an audit trail that says they did it.
//
// Two paths stay open so you can always get out:
//   /api/admin/view-as  — the exit button itself
//   /api/auth/*         — logout is a POST
//
// This only checks for the cookie's PRESENCE. Whether it is honoured at all is
// decided in requireRoles(), which ignores it unless the real session resolves
// to owner. So a non-owner who sets the cookie by hand gains nothing and merely
// makes their own session read-only.

import { NextResponse, type NextRequest } from 'next/server'
import { VIEW_AS_COOKIE } from './lib/view-as-cookie'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Paths that must keep working while impersonating, or you could not stop.
const ALWAYS_ALLOWED = ['/api/admin/view-as', '/api/auth/']

export function middleware(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return NextResponse.next()
  if (!req.cookies.get(VIEW_AS_COOKIE)) return NextResponse.next()

  const path = req.nextUrl.pathname
  if (ALWAYS_ALLOWED.some(p => path === p || path.startsWith(p))) return NextResponse.next()

  return NextResponse.json(
    {
      success: false,
      error: 'View As is read-only. Stop viewing as this person before making changes.',
      viewAs: true,
    },
    { status: 403 },
  )
}

export const config = {
  matcher: '/api/:path*',
}
