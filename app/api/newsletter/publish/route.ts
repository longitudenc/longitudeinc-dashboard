// app/api/newsletter/publish/route.ts
//
// NEWSLETTER-PUBLISH-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Publish a month (editors only): copy its draft over the published copy so
// signed-in staff can see it in the reader. The draft stays put for future edits.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { publishMonth } from '@/lib/newsletter-store'

export const runtime = 'nodejs'
const EDIT_ROLES = new Set(['owner', 'admin', 'office'])
const MONTH = /^\d{4}-\d{2}$/

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  if (!EDIT_ROLES.has(gate.access.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'bad json' }, { status: 400 }) }
  const month = String(body?.month || '').trim()
  if (!MONTH.test(month)) return NextResponse.json({ success: false, error: 'bad month' }, { status: 400 })

  try {
    const publishedAt = await publishMonth(month)
    return NextResponse.json({ success: true, publishedAt })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'publish failed' }, { status: 400 })
  }
}
