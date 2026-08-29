// app/api/newsletter/draft/route.ts
//
// NEWSLETTER-DRAFT-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Save the working draft for a month (editors only). Autosave and the Save
// button both PUT here. The draft is invisible to staff until it is published.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { saveDraft } from '@/lib/newsletter-store'

export const runtime = 'nodejs'
const EDIT_ROLES = new Set(['owner', 'admin', 'office'])
const MONTH = /^\d{4}-\d{2}$/
const MAX_BYTES = 8 * 1024 * 1024

export async function PUT(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  if (!EDIT_ROLES.has(gate.access.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'bad json' }, { status: 400 }) }
  const month = String(body?.month || '').trim()
  const html = String(body?.html || '')
  if (!MONTH.test(month)) return NextResponse.json({ success: false, error: 'bad month' }, { status: 400 })
  if (!html) return NextResponse.json({ success: false, error: 'empty' }, { status: 400 })
  if (html.length > MAX_BYTES) return NextResponse.json({ success: false, error: 'too large — trim photos' }, { status: 413 })

  try {
    const savedAt = await saveDraft(month, html)
    return NextResponse.json({ success: true, savedAt })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'save failed' }, { status: 500 })
  }
}
