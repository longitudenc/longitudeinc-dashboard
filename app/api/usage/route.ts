// app/api/usage/route.ts
//
// USAGE-v1
//   POST { events: [{ screen, detail?, at? }] }   any signed-in person
//     Records the screens they opened. Who, role and salon come from the
//     session, never from the body. Nothing is recorded while an owner is
//     viewing as someone else -- that would file the owner's clicking around
//     as the other person's use.
//   GET ?days=30                                 view.usage (owner, admin)
//     -> { since, today, rows: [{date,email,role,salon,screen,views}], people }

import { NextResponse } from 'next/server'
import { requireSignedIn, requireCapability } from '@/lib/require-role'
import { logEvents, usageRows, expectedPeople } from '@/lib/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  if (gate.viewingAs) return NextResponse.json({ success: true, logged: 0, skipped: 'view-as' })
  let body: any
  try { body = JSON.parse(await req.text()) } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }
  try {
    const logged = await logEvents({
      email: gate.email,
      role: String(gate.realAccess.role || ''),
      salon: (gate.realAccess.salons || []).join('/'),
    }, Array.isArray(body?.events) ? body.events : [])
    return NextResponse.json({ success: true, logged })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function GET(req: Request) {
  const gate = await requireCapability('view.usage')
  if (!gate.ok) return gate.response
  try {
    const days = Math.min(400, Math.max(1, parseInt(new URL(req.url).searchParams.get('days') || '30', 10) || 30))
    const [rep, people] = await Promise.all([usageRows(days), expectedPeople()])
    return NextResponse.json({ success: true, ...rep, people })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
