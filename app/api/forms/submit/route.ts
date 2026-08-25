// app/api/forms/submit/route.ts
//
// Accept one form submission and append it to the FormSubmissions tab.
//
// Body: { formId, data: { fieldKey: value, ... } }
//
// The submitter's identity is derived SERVER-side from the session cookie —
// the client never sends who it is. Answers are validated against the form
// definition and stripped to declared fields, so a hand-crafted POST can't
// invent columns or bypass a required field.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { appendSheet, readSheet, getEmployeeProfiles } from '@/lib/sheets'
import { notifyNewSubmission } from '@/lib/notify'
import { recordDisciplinaryEvent, parseViolationPoints } from '@/lib/disc-points'
import {
  getFormDefs,
  audienceAllows,
  validateSubmission,
  pickDeclaredFields,
  buildSummary,
  newSubmissionId,
  TAB_SUBS,
  SUBS_COLUMNS,
} from '@/lib/forms'

// Make sure the tab exists AND carries a header row before the first append.
// appendSheet creates the tab but would otherwise write data into row 1, which
// rowsToObjects would then read as column names.
async function ensureHeader() {
  const rows = await readSheet(TAB_SUBS)
  if (rows.length === 0) {
    await appendSheet(TAB_SUBS, [[...SUBS_COLUMNS]])
  }
}

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const formId = String(body?.formId || '').trim()
    const data = (body?.data && typeof body.data === 'object') ? body.data : {}

    if (!formId) {
      return NextResponse.json({ success: false, error: 'formId is required' }, { status: 400 })
    }

    const defs = await getFormDefs()
    const def = defs.find(d => d.formId === formId)
    if (!def) {
      return NextResponse.json({ success: false, error: 'unknown form' }, { status: 404 })
    }
    if (def.status !== 'active') {
      return NextResponse.json({ success: false, error: 'this form is no longer accepting submissions' }, { status: 400 })
    }
    // Re-check audience here, not just in /defs — otherwise a role that can't
    // see a form could still submit to it by posting the id directly.
    if (!audienceAllows(def.audience, gate.access.role)) {
      return NextResponse.json({ success: false, error: 'not available for your role' }, { status: 403 })
    }

    const errors = validateSubmission(def, data)
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join('; '), errors }, { status: 400 })
    }

    const clean = pickDeclaredFields(def, data)

    // Identity + home salon from EmployeeProfile (server-side; email is PII and
    // is stored on the row but never returned to other users' browsers).
    const gid = String(gate.access.globalId || '').trim()
    let name = String(gate.access.name || '').trim()
    let homeSalon = ''
    if (gid) {
      const profiles = await getEmployeeProfiles()
      const p = profiles.find((r: any) => String(r.globalId || '').trim() === gid)
      if (p) {
        if (!name) name = String((p as any).name || '').trim()
        homeSalon = String((p as any).homeStoreNum || '').trim()
      }
    }

    // Salon attribution drives who can later see and review this row. Prefer an
    // explicit salon field on the form, then the submitter's home salon, then
    // their single scoped salon if they only have one.
    const salonField = def.fields.find(f => f.type === 'salon')
    const scope = gate.access.salons || []
    const salonNum =
      (salonField ? String(clean[salonField.fieldKey] || '').trim() : '') ||
      homeSalon ||
      (scope.length === 1 ? String(scope[0]).trim() : '')

    const now = new Date().toISOString()
    const row: Record<string, string> = {
      submissionId: newSubmissionId(),
      formId: def.formId,
      formTitle: def.title,
      submittedByEmail: gate.email,
      submittedByGid: gid,
      submittedByName: name || gate.email,
      salonNum,
      status: 'submitted',
      summary: buildSummary(def, clean),
      dataJson: JSON.stringify(clean),
      submittedAt: now,
      updatedAt: now,
      reviewedBy: '',
      reviewNote: '',
    }

    await ensureHeader()
    await appendSheet(TAB_SUBS, [SUBS_COLUMNS.map(c => row[c] ?? '')])

    // Best-effort notify — never fail the submission over an email.
    try {
      await notifyNewSubmission({
        submissionId: row.submissionId,
        notify: def.notify || [],
        salonNum: row.salonNum,
        formTitle: def.title,
        summary: row.summary,
        submitterName: row.submittedByName,
        submitterEmail: row.submittedByEmail,
      })
    } catch (e: any) { console.error('[submit] notify failed:', e?.message) }

    // Disciplinary form → also record a points event in the tracker (best-effort).
    if (def.formId === 'discipline') {
      try {
        const violation = String(clean.violation || '')
        const isOther = /^other\b/i.test(violation)
        const points = isOther ? (Number(clean.otherPoints) || 0) : parseViolationPoints(violation)
        const reason = isOther ? (String(clean.otherViolation || '').trim() || 'Other violation') : violation
        await recordDisciplinaryEvent({
          globalId: String(clean.employee || '').trim(),
          points, reason,
          date: String(clean.violationDate || '').trim(),
        })
      } catch (e: any) { console.error('[submit] disc event failed:', e?.message) }
    }

    return NextResponse.json({ success: true, submissionId: row.submissionId })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
