// app/api/forms/status/route.ts
//
// Update a submission's review status.
//
// Body: { submissionId, status, reviewNote? }
//
// Permission is per-row, not per-role: owner/admin may review anything; an AM
// or manager may only review submissions attributed to a salon in their scope
// (lib/forms.ts → canReviewSubmission). Authors can SEE their own request but
// cannot approve it themselves.
//
// Rewrites the whole tab, matching the saveDiscPoints pattern. Submission
// volume here is low (hundreds), so a full rewrite is simpler and safer than
// a targeted range update that could drift out of alignment.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { readSheet, rowsToObjects, writeSheet } from '@/lib/sheets'
import { recordDisciplinaryEvent, parseViolationPoints, removeDisciplinaryEventsBySubmission } from '@/lib/disc-points'
import {
  getSubmissions,
  canReviewSubmission,
  getFormDefs,
  SUBMISSION_STATUSES,
  TAB_SUBS,
  SUBS_COLUMNS,
} from '@/lib/forms'

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const submissionId = String(body?.submissionId || '').trim()
    const status = String(body?.status || '').trim().toLowerCase()
    const reviewNote = String(body?.reviewNote || '').slice(0, 2000)

    if (!submissionId) {
      return NextResponse.json({ success: false, error: 'submissionId is required' }, { status: 400 })
    }
    if (!(SUBMISSION_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json(
        { success: false, error: `status must be one of: ${SUBMISSION_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }

    const subs = await getSubmissions()
    const target = subs.find(s => s.submissionId === submissionId)
    if (!target) {
      return NextResponse.json({ success: false, error: 'submission not found' }, { status: 404 })
    }
    const defs = await getFormDefs()
    const rv = defs.find(d => d.formId === target.formId)?.responseView || []
    // effectiveEmail, not email: under View As the person being impersonated is
    // who the rule must be applied to, or an owner viewing as a manager could
    // approve a request that manager raised.
    if (!canReviewSubmission(target, gate.access, rv, gate.effectiveEmail)) {
      return NextResponse.json({ success: false, error: 'insufficient permissions' }, { status: 403 })
    }

    // Re-read the raw rows so untouched columns round-trip exactly as stored.
    const raw = rowsToObjects(await readSheet(TAB_SUBS))
    const now = new Date().toISOString()
    let found = false

    const rows = raw.map(r => {
      if (String(r.submissionId || '').trim() === submissionId) {
        found = true
        return {
          ...r,
          status,
          reviewNote,
          reviewedBy: gate.access.name || gate.email,
          updatedAt: now,
        }
      }
      return r
    })

    if (!found) {
      return NextResponse.json({ success: false, error: 'submission not found' }, { status: 404 })
    }

    await writeSheet(TAB_SUBS, [
      [...SUBS_COLUMNS],
      ...rows.map(r => SUBS_COLUMNS.map(c => String((r as any)[c] ?? ''))),
    ])

    // APPROVAL-GATED DISCIPLINE. When a write-up needs approving, the points
    // follow the decision rather than the submission: recorded on approve,
    // taken back on anything else. Reversal matters as much as the write --
    // points gate a bonus at 4 and a raise at 6, so a write-up that was denied
    // and left its points behind is quietly costing someone money.
    //
    // Keyed on sourceSubmissionId, so approving twice cannot double-count.
    let discPoints: string | undefined
    if (target.formId === 'discipline') {
      const wf = String(defs.find(d => d.formId === 'discipline')?.workflow || '').toLowerCase()
      if (wf === 'approval') {
        try {
          await removeDisciplinaryEventsBySubmission(submissionId)
          if (status === 'approved') {
            const d: any = target.data || {}
            const violation = String(d.violation || '')
            const isOther = /^other/i.test(violation)
            const points = isOther ? (Number(d.otherPoints) || 0) : parseViolationPoints(violation)
            const reason = isOther ? (String(d.otherViolation || '').trim() || 'Other violation') : violation
            await recordDisciplinaryEvent({
              globalId: String(d.employee || '').trim(),
              points, reason,
              date: String(d.violationDate || '').trim(),
              sourceSubmissionId: submissionId,
            })
            discPoints = points ? `${points} point(s) recorded in the tracker.` : undefined
          } else {
            discPoints = 'Any points from this write-up have been removed from the tracker.'
          }
        } catch (e: any) { console.error('[status] disc points failed:', e?.message) }
      }
    }

    return NextResponse.json({ success: true, submissionId, status, discPoints })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
