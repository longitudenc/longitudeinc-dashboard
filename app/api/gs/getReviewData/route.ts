// app/api/gs/getReviewData/route.ts
//
// One employee's performance reviews.
//
// SECURITY: this route was requireSignedIn with the filter
//
//     rows.filter(r => (!globalId || r.globalId === globalId) && ...)
//
// so a POST with an EMPTY BODY returned the entire ReviewData tab -- every
// review of every employee -- to anyone holding a login, stylists included.
// Passing someone else's globalId returned theirs. globalIds are not secret;
// /api/gs/getHomeEmployees hands out the whole list.
//
// A globalId is now REQUIRED and is checked against the caller's scope through
// seesEmployee(): your own reviews always, an area manager or manager may read
// people homed at a salon they run, owner/admin/viewer may read any, and nobody
// else reads anyone.

import { NextRequest, NextResponse } from 'next/server'
import { readSheet, rowsToObjects, getEmployeeProfiles } from '@/lib/sheets'
import { requireSignedIn } from '@/lib/require-role'
import { seesEmployee } from '@/lib/scope-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const str = (v: unknown) => String(v ?? '').trim()

export async function POST(req: NextRequest) {
  const gate = await requireSignedIn(); if (!gate.ok) return gate.response
  try {
    const body = await req.json().catch(() => ({}))
    const globalId = str(body?.globalId)
    const year = str(body?.year)

    // Required. Without it the old filter matched every row in the tab.
    if (!globalId) {
      return NextResponse.json(
        { success: false, error: 'globalId is required', reviews: [] },
        { status: 400 },
      )
    }

    // Home salon decides scope, so read it from the profile rather than
    // trusting anything in the request body.
    const profiles = await getEmployeeProfiles()
    const profile = profiles.find((p: any) => str(p.globalId) === globalId)
    const homeSalon = str((profile as any)?.homeStoreNum)

    if (!seesEmployee(gate.access, globalId, homeSalon)) {
      return NextResponse.json(
        { success: false, error: 'insufficient permissions', reviews: [] },
        { status: 403 },
      )
    }

    const rows = rowsToObjects(await readSheet('ReviewData'))
    const reviews = rows.filter((r: any) =>
      str(r.globalId) === globalId && (!year || str(r.year) === year))

    return NextResponse.json({ success: true, reviews })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message, reviews: [] })
  }
}
