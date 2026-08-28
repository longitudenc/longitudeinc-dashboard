// app/api/home/route.ts
//
// Homepage payload: live announcements, upcoming important dates, and quick
// links — each already filtered to what the signed-in role should see.
//
// Deliberately NOT part of getAllData: that payload is already heavy and
// cached for 3 minutes, while home content should reflect an edit immediately.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { getAnnouncements, getImportantDates, getHomeLinks, getCelebrations, homeSalonForGlobalId, todayIsoET } from '@/lib/home'

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

    // WHOSE celebrations. Owner/admin/viewer carry no salon list and see the
    // whole company. A stylist carries none either, which meant they saw the
    // whole company too -- scope them to their own salon instead.
    let celebScope = gate.access.salons
    if ((!celebScope || !celebScope.length) && role === 'stylist' && gate.access.globalId) {
      const home = await homeSalonForGlobalId(gate.access.globalId)
      if (home) celebScope = [home]   // unknown salon -> leave as before rather than blank the section
    }

    // HOW FAR OUT. 14 days suits 127 people company-wide (8 items today), but
    // a 4-salon AM sees 0-4 and EVERY single-salon manager sees 0 -- the window
    // is right for the company and far too short for a small scope. Scoped
    // viewers get a wider window and a smaller cap, so everyone gets roughly
    // "the next handful" rather than an empty section.
    //   measured: AMs 0/3/0/4 at 14d -> 3/8/7/10 at 60d.
    const scoped = !!(celebScope && celebScope.length)
    const celebOpts = scoped
      ? { horizon: 60, newHireDays: 60, cap: 8,  includePhone: PHONE_ROLES.has(role) }
      : { horizon: 14, newHireDays: 14, cap: 16, includePhone: PHONE_ROLES.has(role) }

    const [announcements, dates, links, celebrations] = await Promise.all([
      getAnnouncements(role),
      getImportantDates(role, horizon),
      getHomeLinks(role),
      getCelebrations(celebScope, celebOpts).catch(() => []),
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
