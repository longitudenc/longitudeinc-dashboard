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
  listReviews, listPhotos, saveReview, savePhotos, assignPhoto, removeReview,
} from '@/lib/facility'
import { del } from '@vercel/blob'
import { readSheet, rowsToObjects } from '@/lib/sheets'

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
    const reviews = (await listReviews()).filter(r => canSeeSalon(gate.access, r.salonNum))
    const photos = (await listPhotos()).filter(p => canSeeSalon(gate.access, p.salonNum))

    // SALON-RAISED REQUESTS, read where they already live. The maintenance form
    // keeps its own status (submitted → in review → complete) in the forms
    // engine, and copying them into this tracker would give every request two
    // statuses that drift apart. So they are READ here and managed there: the
    // tracker counts them and lists them, and clicking one opens the request.
    let requests: any[] = []
    try {
      const subs = rowsToObjects((await readSheet('FormSubmissions')) || [])
      requests = subs
        .filter(x => S(x.formId, 60) === 'maintenance' && canSeeSalon(gate.access, S(x.salonNum, 10)))
        .map(x => {
          let data: any = {}
          try { data = JSON.parse(String(x.dataJson || '{}')) } catch { data = {} }
          return {
            submissionId: S(x.submissionId, 60),
            salonNum: S(x.salonNum, 10),
            status: S(x.status, 20) || 'submitted',
            submittedAt: S(x.submittedAt, 40),
            submittedBy: S(x.submittedByName, 120),
            issueType: S(data.issueType, 80),
            urgency: S(data.urgency, 80),
            description: S(data.description, 600) || S(x.summary, 600),
          }
        })
    } catch { /* no forms tab: no salon requests, not an error */ }

    return NextResponse.json({
      success: true, items, comments, reviews, photos, requests,
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

      // The review record and its photos, so the archive holds the source and
      // not only the reading of it.
      let review = null as any
      if (body?.review && S(body.review.salonNum, 10)) {
        if (!canSeeSalon(gate.access, S(body.review.salonNum, 10))) {
          return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
        }
        // COUNT WHAT IS ON THE TRACKER, not what this import happened to add.
        // Loading the same email twice adds nothing — every component is
        // already there — and recording that as "0 items" made the archive
        // claim a review had produced nothing when it had produced seven.
        const sn = S(body.review.salonNum, 10), rd = S(body.review.reviewDate, 10)
        const onTracker = (await listFacility(true))
          .filter(i => i.salonNum === sn && i.reviewDate === rd)
        review = await saveReview({
          salonNum: sn, salonName: S(body.review.salonName, 120),
          reviewDate: rd, subject: S(body.review.subject, 300),
          sourceFile: S(body.review.sourceFile, 300), msgPathname: S(body.review.msgPathname, 300),
          items: onTracker.length,
          critical: onTracker.filter(i => i.category === 'critical').length,
          photos: Array.isArray(body?.photos) ? body.photos.length : 0,
        }, gate.email)
      }
      let photos: any[] = []
      if (Array.isArray(body?.photos) && body.photos.length && review) {
        const incoming = body.photos.slice(0, 100)
        photos = await savePhotos(incoming.map((p: any) => ({
          reviewId: review.reviewId, salonNum: review.salonNum, itemId: '',
          fileName: S(p?.fileName, 200), pathname: S(p?.pathname, 300),
          contentType: S(p?.contentType, 60), size: Number(p?.size) || 0,
        })), gate.email)
        // Re-importing the same email re-uploads its photos; the rows are
        // de-duplicated, so the second copy of the bytes has nothing pointing
        // at it. Delete it rather than leave it paid-for and invisible.
        const keptPaths = new Set(photos.map((p: any) => p.pathname))
        for (const p of incoming) {
          const path = S(p?.pathname, 300)
          if (path && !keptPaths.has(path)) { try { await del(path) } catch { /* orphan */ } }
        }
        // The archive line counts every photo held for the visit, not only the
        // ones this particular drop added.
        const held = (await listPhotos(true)).filter(p => p.reviewId === review.reviewId).length
        if (held !== review.photos) review = await saveReview({ ...review, photos: held }, gate.email)
      }
      return NextResponse.json({
        success: true, added: res.added.length, skipped: res.skipped, items: res.added,
        review, photos: photos.length,
      })
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

    if (kind === 'photo') {
      const photoId = S(body?.photoId, 60)
      if (!photoId) return NextResponse.json({ success: false, error: 'photoId is required' }, { status: 400 })
      const ph = (await listPhotos()).find(p => p.photoId === photoId)
      if (!ph) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
      if (!canSeeSalon(gate.access, ph.salonNum)) {
        return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
      }
      // A blank itemId puts it back on the review, which is how a mis-assigned
      // photo is undone.
      await assignPhoto(photoId, S(body?.itemId, 60))
      return NextResponse.json({ success: true })
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
    const q = new URL(req.url).searchParams
    const reviewId = S(q.get('reviewId'), 60)
    if (reviewId) {
      const r = (await listReviews()).find(x => x.reviewId === reviewId)
      if (!r) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
      if (!canSeeSalon(gate.access, r.salonNum)) {
        return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
      }
      const out = await removeReview(reviewId)
      // The stored bytes go with the rows that referenced them; a failure here
      // leaves an orphan object, not a broken record, so it must not fail the
      // request.
      for (const path of out.pathnames) {
        try { await del(path) } catch { /* orphan, not an error */ }
      }
      return NextResponse.json({ success: true, ...out })
    }

    const itemId = S(q.get('itemId'), 60)
    if (!itemId) return NextResponse.json({ success: false, error: 'itemId or reviewId is required' }, { status: 400 })
    const existing = (await listFacility()).find(i => i.itemId === itemId)
    if (existing && !canSeeSalon(gate.access, existing.salonNum)) {
      return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
    }
    return NextResponse.json({ success: true, removed: await removeItem(itemId) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
