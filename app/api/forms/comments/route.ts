// app/api/forms/comments/route.ts
//
// FORM-COMMENTS-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Add a comment to a submission's conversation. Anyone allowed to SEE the
// submission may comment — the submitter, admins, the salon's area manager, and
// office/maintenance per the form's responseView tags. Append-only.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { appendSheet } from '@/lib/sheets'
import { getSubmissions, getFormDefs, canViewSubmission, TAB_COMMENTS, COMMENT_COLUMNS } from '@/lib/forms'
import { notifyNewComment } from '@/lib/notify'

export const runtime = 'nodejs'

function newCommentId() {
  return 'cmt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const b = await req.json()
    const submissionId = String(b?.submissionId || '').trim()
    const body = String(b?.body || '').trim().slice(0, 4000)
    if (!submissionId || !body) {
      return NextResponse.json({ success: false, error: 'submissionId and body are required' }, { status: 400 })
    }

    // You must be allowed to SEE the ticket to comment on it.
    const sub = (await getSubmissions()).find(s => s.submissionId === submissionId)
    if (!sub) return NextResponse.json({ success: false, error: 'submission not found' }, { status: 404 })
    const def = (await getFormDefs()).find(d => d.formId === sub.formId)
    const rv = def?.responseView || []
    if (!canViewSubmission(sub, gate.access, gate.email, rv)) {
      return NextResponse.json({ success: false, error: 'not allowed' }, { status: 403 })
    }

    const comment = {
      id: newCommentId(),
      submissionId,
      author: gate.access.name || gate.email,
      authorRole: gate.access.role,
      body,
      createdAt: new Date().toISOString(),
    }
    await appendSheet(TAB_COMMENTS, [COMMENT_COLUMNS.map(c => String((comment as any)[c] ?? ''))])

    // Best-effort notify — never fail the comment over an email.
    try {
      await notifyNewComment({
        notify: def?.notify || [],
        salonNum: sub.salonNum,
        formTitle: sub.formTitle,
        body,
        authorName: gate.access.name || gate.email,
        authorEmail: gate.email,
        submitterEmail: sub.submittedByEmail,
      })
    } catch (e: any) { console.error('[comment] notify failed:', e?.message) }

    return NextResponse.json({ success: true, comment })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
