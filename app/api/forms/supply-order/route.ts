// app/api/forms/supply-order/route.ts
//
// SUPPLY-ORDER-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET  ?submissionId=f_xxx   -> the catalogue + this order's quantities
//   POST { submissionId, lines: [{item, qty}] }  -> save the quantities
//
// READ is for anyone who can see the submission; WRITE is for anyone who can
// review it. That split is the point of the whole feature: a manager may see
// what they asked for and what is going to be ordered, and only the office
// manager decides how many. It reuses canViewSubmission / canReviewSubmission
// rather than inventing a second rule, so the answer cannot drift from the one
// the rest of forms uses.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import {
  getSubmissions, getFormDefs, canViewSubmission, canReviewSubmission,
} from '@/lib/forms'
import { listSupplyItems, getOrderLines, saveOrderLines } from '@/lib/supply-order'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown) => String(v ?? '').trim()

async function locate(submissionId: string) {
  const subs = await getSubmissions()
  const sub = subs.find(s => s.submissionId === submissionId)
  if (!sub) return { sub: null, rv: [] as string[] }
  const defs = await getFormDefs()
  return { sub, rv: defs.find(d => d.formId === sub.formId)?.responseView || [] }
}

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  try {
    const submissionId = S(new URL(req.url).searchParams.get('submissionId'))
    if (!submissionId) {
      return NextResponse.json({ success: false, error: 'submissionId is required' }, { status: 400 })
    }
    const { sub, rv } = await locate(submissionId)
    if (!sub) return NextResponse.json({ success: false, error: 'submission not found' }, { status: 404 })
    if (!canViewSubmission(sub, gate.access, gate.effectiveEmail, rv)) {
      return NextResponse.json({ success: false, error: 'not allowed' }, { status: 403 })
    }
    const [items, lines] = await Promise.all([listSupplyItems(), getOrderLines(submissionId)])
    return NextResponse.json({
      success: true,
      items,
      lines,
      canEdit: canReviewSubmission(sub, gate.access, rv, gate.effectiveEmail),
    })
  } catch (e: any) {
    // The order panel is a convenience on top of a submission that is already
    // readable; a catalogue that will not load must not take the page with it.
    return NextResponse.json({ success: true, items: [], lines: {}, canEdit: false, warning: e?.message })
  }
}

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  try {
    const body = await req.json().catch(() => ({}))
    const submissionId = S(body?.submissionId)
    if (!submissionId) {
      return NextResponse.json({ success: false, error: 'submissionId is required' }, { status: 400 })
    }
    const { sub, rv } = await locate(submissionId)
    if (!sub) return NextResponse.json({ success: false, error: 'submission not found' }, { status: 404 })

    // Deciding quantities IS reviewing: the same people who may approve the
    // order may set what it contains, and nobody else -- including the person
    // who raised it.
    if (!canReviewSubmission(sub, gate.access, rv, gate.effectiveEmail)) {
      return NextResponse.json({ success: false, error: 'insufficient permissions' }, { status: 403 })
    }

    const lines = Array.isArray(body?.lines)
      ? body.lines.map((l: any) => ({ item: S(l?.item), qty: Number(l?.qty) || 0 }))
      : []
    const saved = await saveOrderLines(submissionId, lines, gate.effectiveEmail || gate.email)
    return NextResponse.json({ success: true, saved, lines: await getOrderLines(submissionId) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message }, { status: 500 })
  }
}
