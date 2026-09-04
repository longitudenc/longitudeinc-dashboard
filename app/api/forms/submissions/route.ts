// app/api/forms/submissions/route.ts
//
// Returns form submissions the signed-in person is allowed to see. Scoping
// rules live in lib/forms.ts (canViewSubmission):
//   owner/admin/viewer → all · AM/manager → their salons + own · stylist → own
//
// PII: submittedByEmail is stripped for everyone except owner/admin. The
// display name is enough for a review queue, and EmployeeProfile emails are an
// auth credential in this app — they must not travel to other users' browsers.

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects, writeSheet } from '@/lib/sheets'
import { requireSignedIn, requireAdmin } from '@/lib/require-role'
import {
  getSubmissions, filterSubmissions, canReviewSubmission, getFormDefs, getComments,
  TAB_SUBS, TAB_COMMENTS,
} from '@/lib/forms'

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const url = new URL(req.url)
    const formId = String(url.searchParams.get('formId') || '').trim()
    const status = String(url.searchParams.get('status') || '').trim().toLowerCase()

    const all = await getSubmissions()
    const defs = await getFormDefs()
    const rvMap = new Map(defs.map(d => [d.formId, d.responseView || []]))

    // Attach each ticket's conversation. Grouped once; only visible submissions
    // (filtered below) ever get their thread returned, so nothing leaks.
    const commentsBySub = new Map<string, any[]>()
    for (const c of await getComments()) {
      const arr = commentsBySub.get(c.submissionId)
      if (arr) arr.push(c); else commentsBySub.set(c.submissionId, [c])
    }
    // effectiveEmail so viewing and reviewing agree under View As -- with
    // gate.email an owner impersonating a manager was matched on their OWN
    // address, so "my submissions" showed the owner's, not the manager's.
    let visible = filterSubmissions(all, gate.access, gate.effectiveEmail, defs)

    if (formId) visible = visible.filter(s => s.formId === formId)
    if (status) visible = visible.filter(s => s.status === status)

    const isAdmin = gate.access.role === 'owner' || gate.access.role === 'admin'
    const myGid = String(gate.access.globalId || '').trim()
    // effectiveEmail, like the two checks above, so "mine" means the person
    // being viewed as rather than the owner doing the viewing.
    const myEmail = String(gate.effectiveEmail || '').trim().toLowerCase()

    const submissions = visible
      .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''))
      .map(s => ({
        submissionId: s.submissionId,
        formId: s.formId,
        formTitle: s.formTitle,
        submittedByName: s.submittedByName,
        submittedByGid: s.submittedByGid,
        submittedByEmail: isAdmin ? s.submittedByEmail : '',
        salonNum: s.salonNum,
        status: s.status,
        summary: s.summary,
        data: s.data,
        submittedAt: s.submittedAt,
        updatedAt: s.updatedAt,
        reviewedBy: s.reviewedBy,
        reviewNote: s.reviewNote,
        // Drives whether the client shows review controls. The server re-checks
        // this on write regardless — this is only to avoid dead buttons.
        canReview: canReviewSubmission(s, gate.access, rvMap.get(s.formId) || [], gate.effectiveEmail),
        // Match by ID OR email, so owner/admin accounts (no globalId) still see their own.
        isMine: (!!myGid && s.submittedByGid === myGid) || (!!myEmail && s.submittedByEmail.toLowerCase() === myEmail),
        comments: commentsBySub.get(s.submissionId) || [],
      }))

    return NextResponse.json({ success: true, submissions, count: submissions.length })
  } catch (e: any) {
    return NextResponse.json({ success: true, submissions: [], count: 0, warning: e.message })
  }
}

/**
 * Delete one submission, and the comment thread hanging off it.
 *
 *   DELETE ?submissionId=f_xxxx
 *
 * Owner/admin only, deliberately narrower than reviewing: an area manager may
 * decide a request is denied, but making it never have happened is a different
 * power. Mostly this exists to clear out test rows.
 *
 * NOT a status change. `denied` and `closed` already say "this was considered
 * and refused" and are the right answer nearly always; this is for rows that
 * should never have existed. It does not tombstone, because a test submission
 * nobody should see again is exactly what a tombstone would keep showing.
 *
 * A discipline submission ALSO wrote a row to DiscPoints, which this does not
 * touch -- that tab is the tracker's own record and is edited from the Points
 * screen. The response says so, so the caller is told rather than left to
 * discover a stray event later.
 */
export async function DELETE(req: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const submissionId = String(new URL(req.url).searchParams.get('submissionId') || '').trim()
    if (!submissionId) {
      return NextResponse.json({ success: false, error: 'submissionId is required' }, { status: 400 })
    }

    const all = await getSubmissions()
    const target = all.find(s => s.submissionId === submissionId)
    if (!target) {
      return NextResponse.json({ success: false, error: 'submission not found' }, { status: 404 })
    }

    // Read-modify-write over a shared tab, so read fresh.
    const rawSubs = rowsToObjects(await readSheet(TAB_SUBS, undefined, { fresh: true }))
    const headSubs = Object.keys(rawSubs[0] || {})
    const keptSubs = rawSubs.filter(r => String(r.submissionId || '').trim() !== submissionId)
    if (headSubs.length) {
      await writeSheet(TAB_SUBS, [headSubs, ...keptSubs.map(r => headSubs.map(h => String(r[h] ?? '')))])
    }

    // Comments too, or the thread outlives the thing it was about.
    let commentsRemoved = 0
    try {
      const rawC = rowsToObjects(await readSheet(TAB_COMMENTS, undefined, { fresh: true }))
      const headC = Object.keys(rawC[0] || {})
      const keptC = rawC.filter(r => String(r.submissionId || '').trim() !== submissionId)
      commentsRemoved = rawC.length - keptC.length
      if (headC.length && commentsRemoved) {
        await writeSheet(TAB_COMMENTS, [headC, ...keptC.map(r => headC.map(h => String(r[h] ?? '')))])
      }
    } catch { /* no comments tab yet */ }

    return NextResponse.json({
      success: true,
      submissionId,
      commentsRemoved,
      note: target.formId === 'discipline'
        ? 'This was a discipline submission. Its DiscPoints event was NOT removed - clear that from the Points screen if it was a test.'
        : undefined,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
