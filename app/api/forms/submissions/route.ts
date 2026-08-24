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
import { requireSignedIn } from '@/lib/require-role'
import { getSubmissions, filterSubmissions, canReviewSubmission, getFormDefs } from '@/lib/forms'

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
    let visible = filterSubmissions(all, gate.access, gate.email, defs)

    if (formId) visible = visible.filter(s => s.formId === formId)
    if (status) visible = visible.filter(s => s.status === status)

    const isAdmin = gate.access.role === 'owner' || gate.access.role === 'admin'
    const myGid = String(gate.access.globalId || '').trim()

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
        canReview: canReviewSubmission(s, gate.access, rvMap.get(s.formId) || []),
        isMine: !!myGid && s.submittedByGid === myGid,
      }))

    return NextResponse.json({ success: true, submissions, count: submissions.length })
  } catch (e: any) {
    return NextResponse.json({ success: true, submissions: [], count: 0, warning: e.message })
  }
}
