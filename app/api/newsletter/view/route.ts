// app/api/newsletter/view/route.ts
//
// NEWSLETTER-VIEW-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Return the stored HTML for one month. mode=published is readable by any
// signed-in person; mode=draft is editors-only. Missing month -> empty html.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { getPublished, getDraft } from '@/lib/newsletter-store'

export const runtime = 'nodejs'
const EDIT_ROLES = new Set(['owner', 'admin', 'office'])
const MONTH = /^\d{4}-\d{2}$/

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  const u = new URL(req.url)
  const month = (u.searchParams.get('month') || '').trim()
  const mode = (u.searchParams.get('mode') || 'published').trim()
  if (!MONTH.test(month)) return NextResponse.json({ success: false, error: 'bad month' }, { status: 400 })
  if (mode === 'draft' && !EDIT_ROLES.has(gate.access.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  let html: string | null = null
  try { html = mode === 'draft' ? await getDraft(month) : await getPublished(month) } catch { html = null }

  return NextResponse.json({ success: true, month, mode, exists: html != null, html: html || '' })
}
