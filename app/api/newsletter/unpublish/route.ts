// app/api/newsletter/unpublish/route.ts
//
// NEWSLETTER-UNPUBLISH-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Take a month back down (editors only): delete its published copy so it leaves
// the reader. The draft is untouched, so you can revise and re-publish.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { capabilitiesFor } from '@/lib/capabilities'
import { unpublishMonth } from '@/lib/newsletter-store'

export const runtime = 'nodejs'
// CAPABILITIES-v2. Was a hard-coded owner/admin/office list in each of these
// five files; now one capability, settable per person in Users & Access. The
// defaults grant it to exactly those three roles, so nobody's access changed.
const mayEditNewsletter = async (email: string, access: any): Promise<boolean> =>
  (await capabilitiesFor(access, email)).has('edit.newsletter')
const MONTH = /^\d{4}-\d{2}$/

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  if (!await mayEditNewsletter(gate.effectiveEmail, gate.access)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'bad json' }, { status: 400 }) }
  const month = String(body?.month || '').trim()
  if (!MONTH.test(month)) return NextResponse.json({ success: false, error: 'bad month' }, { status: 400 })
  try {
    await unpublishMonth(month)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'unpublish failed' }, { status: 400 })
  }
}
