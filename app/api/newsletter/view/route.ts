// app/api/newsletter/view/route.ts
//
// NEWSLETTER-VIEW-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Return the stored HTML for one month. mode=published is readable by any
// signed-in person; mode=draft is editors-only. Missing month -> empty html.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { capabilitiesFor } from '@/lib/capabilities'
import { getPublished, getDraft } from '@/lib/newsletter-store'

export const runtime = 'nodejs'
// CAPABILITIES-v2. Was a hard-coded owner/admin/office list in each of these
// five files; now one capability, settable per person in Users & Access. The
// defaults grant it to exactly those three roles, so nobody's access changed.
const mayEditNewsletter = async (email: string, access: any): Promise<boolean> =>
  (await capabilitiesFor(access, email)).has('edit.newsletter')
const MONTH = /^\d{4}-\d{2}$/

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  const u = new URL(req.url)
  const month = (u.searchParams.get('month') || '').trim()
  const mode = (u.searchParams.get('mode') || 'published').trim()
  if (!MONTH.test(month)) return NextResponse.json({ success: false, error: 'bad month' }, { status: 400 })
  if (mode === 'draft' && !await mayEditNewsletter(gate.effectiveEmail, gate.access)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  let html: string | null = null
  try { html = mode === 'draft' ? await getDraft(month) : await getPublished(month) } catch { html = null }

  return NextResponse.json({ success: true, month, mode, exists: html != null, html: html || '' })
}
