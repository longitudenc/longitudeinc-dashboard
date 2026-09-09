// app/api/facility/route.ts
//
// FACILITY-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET                                items + per-salon summary + comments
//   POST { kind:'items',   items[] }   add items (a parsed review, or one by hand)
//   POST { kind:'update',  itemId, … } change status, due date, assignee, cost
//   POST { kind:'comment', itemId, body }
//   DELETE ?itemId=…                   remove one
//
// Reading is view.facility, writing is edit.facility, and BOTH are scoped to
// the salons the caller can already see: an area manager gets their own
// buildings and nobody else's. The capability picks the screen; the scope picks
// the rows, which is the same split the rest of the app uses.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
import { canSeeSalon } from '@/lib/scope-filter'
import {
  listFacility, addItems, updateItem, removeItem, summarise,
  listComments, addComment, FACILITY_STATUSES,
} from '@/lib/facility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max)
const todayIso = () => new Date().toISOString().slice(0, 10)

export async function GET() {
  const gate = await requireCapability('view.facility')
  if (!gate.ok) return gate.response
  try {
    const all = await listFacility()
    const items = all.filter(i => canSeeSalon(gate.access, i.salonNum))
    const comments = await listComments(items.map(i => i.itemId))
    return NextResponse.json({
      success: true, items, comments,
      summary: summarise(items, todayIso()),
      statuses: [...FACILITY_STATUSES],
      today: todayIso(),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const gate = await requireCapability('edit.facility')
  if (!gate.ok) return gate.response

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }
  const kind = S(body?.kind, 20)

  try {
    if (kind === 'items') {
      const raw = Array.isArray(body?.items) ? body.items : []
      if (!raw.length) return NextResponse.json({ success: false, error: 'no items' }, { status: 400 })
      if (raw.length > 200) return NextResponse.json({ success: false, error: 'too many items' }, { status: 400 })
      // A salon you cannot see is a salon you cannot file work against.
      for (const it of raw) {
        if (!canSeeSalon(gate.access, S(it?.salonNum, 10))) {
          return NextResponse.json(
            { success: false, error: `salon ${S(it?.salonNum, 10) || '(blank)'} is outside your salons` },
            { status: 403 })
        }
      }
      const res = await addItems(raw, gate.email)
      return NextResponse.json({ success: true, added: res.added.length, skipped: res.skipped, items: res.added })
    }

    if (kind === 'update') {
      const itemId = S(body?.itemId, 60)
      if (!itemId) return NextResponse.json({ success: false, error: 'itemId is required' }, { status: 400 })
      const existing = (await listFacility()).find(i => i.itemId === itemId)
      if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
      if (!canSeeSalon(gate.access, existing.salonNum)) {
        return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
      }
      const patch: any = {}
      for (const k of ['status', 'dueDate', 'assignee', 'cost', 'note', 'detail', 'category', 'component']) {
        if (body[k] !== undefined) patch[k] = body[k]
      }
      const next = await updateItem(itemId, patch, gate.email)
      return NextResponse.json({ success: true, item: next })
    }

    if (kind === 'comment') {
      const itemId = S(body?.itemId, 60), text = S(body?.body, 4000)
      if (!itemId || !text) {
        return NextResponse.json({ success: false, error: 'itemId and body are required' }, { status: 400 })
      }
      const existing = (await listFacility()).find(i => i.itemId === itemId)
      if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
      if (!canSeeSalon(gate.access, existing.salonNum)) {
        return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
      }
      const c = await addComment({
        itemId, body: text,
        author: gate.email,
        authorRole: String((gate.access as any)?.role || ''),
      })
      return NextResponse.json({ success: true, comment: c })
    }

    return NextResponse.json({ success: false, error: 'unknown kind' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const gate = await requireCapability('edit.facility')
  if (!gate.ok) return gate.response
  try {
    const itemId = S(new URL(req.url).searchParams.get('itemId'), 60)
    if (!itemId) return NextResponse.json({ success: false, error: 'itemId is required' }, { status: 400 })
    const existing = (await listFacility()).find(i => i.itemId === itemId)
    if (existing && !canSeeSalon(gate.access, existing.salonNum)) {
      return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
    }
    return NextResponse.json({ success: true, removed: await removeItem(itemId) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
