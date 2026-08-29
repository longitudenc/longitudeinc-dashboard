// app/api/newsletter/list/route.ts
//
// NEWSLETTER-LIST-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// What the hosted newsletter page loads first: which months are published
// (everyone signed-in), which have drafts (editors only), whether the caller
// may edit, and which month to open by default.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { listPublished, listDrafts } from '@/lib/newsletter-store'

export const runtime = 'nodejs'
const EDIT_ROLES = new Set(['owner', 'admin', 'office'])

function currentMonthET(): string {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}`
}

export async function GET() {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  const canEdit = EDIT_ROLES.has(gate.access.role)

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
