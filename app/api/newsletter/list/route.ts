// app/api/newsletter/list/route.ts
//
// NEWSLETTER-LIST-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// What the hosted newsletter page loads first: which months are published
// (everyone signed-in), which have drafts (editors only), whether the caller
// may edit, and which month to open by default.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { capabilitiesFor } from '@/lib/capabilities'
import { listPublished, listDrafts } from '@/lib/newsletter-store'

export const runtime = 'nodejs'
// CAPABILITIES-v2. Was a hard-coded owner/admin/office list in each of these
// five files; now one capability, settable per person in Users & Access. The
// defaults grant it to exactly those three roles, so nobody's access changed.
const mayEditNewsletter = async (email: string, access: any): Promise<boolean> =>
  (await capabilitiesFor(access, email)).has('edit.newsletter')

function currentMonthET(): string {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}`
}

export async function GET() {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  const canEdit = await mayEditNewsletter(gate.effectiveEmail, gate.access)

  let published: string[] = []
  let drafts: string[] = []
  try { published = await listPublished() } catch {}
  if (canEdit) { try { drafts = await listDrafts() } catch {} }

  return NextResponse.json({
    success: true,
    canEdit,
    current: published[0] || currentMonthET(),
    published,
    drafts,
  })
}
