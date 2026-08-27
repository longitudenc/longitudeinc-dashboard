// app/api/home/route.ts
//
// Homepage payload: live announcements, upcoming important dates, and quick
// links — each already filtered to what the signed-in role should see.
//
// Deliberately NOT part of getAllData: that payload is already heavy and
// cached for 3 minutes, while home content should reflect an edit immediately.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { getAnnouncements, getImportantDates, getHomeLinks, getCelebrations, todayIsoET } from '@/lib/home'

// Phone numbers on the Home celebration hover go to back-office roles only.
// Enforced here, server-side: for anyone else getCelebrations is called without
// includePhone, so the number is absent from the response rather than hidden by
// the client. An area manager sees their team's birthdays, but not their numbers.
const PHONE_ROLES = new Set(['owner', 'admin', 'office'])

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const url = new URL(req.url)
    const horizon = Number(url.searchParams.get('horizon') || '') || 31  // events out ~1 month

    const role = gate.access.role
    const [announcements, dates, links, celebrations] = await Promise.all([
      getAnnouncements(role),
      getImportantDates(role, horizon),
      getHomeLinks(role),
      getCelebrations(gate.access.salons, { includePhone: PHONE_ROLES.has(role) }).catch(() => []),
    ])
    // Auto celebrations sit alongside curated dates in "Coming up".
    const allDates = [...celebrations, ...dates].sort((a, b) => a.date.localeCompare(b.date))

    return NextResponse.json({
      success: true,
      today: todayIsoET(),
      role,
      name: gate.access.name || '',
      announcements,
      dates: allDates,
      links,
      canEdit: role === 'owner' || role === 'admin',
    })
  } catch (e: any) {
    // Before the first seed these tabs don't exist. An empty home page is a
    // much better failure than a broken one.
    return NextResponse.json({
      success: true,
      today: todayIsoET(),
      role: gate.access.role,
      announcements: [], dates: [], links: [],
      canEdit: gate.access.role === 'owner' || gate.access.role === 'admin',
      warning: e.message,
    })
  }
}
