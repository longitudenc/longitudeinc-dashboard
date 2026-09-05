// lib/forms.ts
//
// FORMS ENGINE — shared schema + read/scope helpers.
//
// Forms are DEFINED IN THE SPREADSHEET, not in code. Two tabs describe them:
//
//   FormDefs   — one row per form   (formId, title, audience, ...)
//   FormFields — one row per field  (formId, fieldKey, label, type, ...)
//
// Adding a form or changing a field is a spreadsheet edit — no code change,
// no deploy. Submissions land in FormSubmissions, one row each, with the
// answers stored as JSON plus a human-readable `summary` column so the tab is
// still legible to someone reading it directly in Sheets.
//
// Everything here runs SERVER-side only.

import { readSheet, rowsToObjects } from './sheets'
import type { Access, Role } from './auth-roles'

// ── Tab names + column order ──────────────────────────────────
// The COLUMNS arrays are the write-order contract. Anything appending to a tab
// must build its row with the matching COLUMNS list so cells land correctly.

export const TAB_DEFS = 'FormDefs'
export const TAB_FIELDS = 'FormFields'
export const TAB_SUBS = 'FormSubmissions'
export const TAB_COMMENTS = 'FormComments'

export const DEFS_COLUMNS = [
  'formId', 'title', 'description', 'icon', 'audience', 'status', 'sortOrder',
  'notify', 'responseView', 'workflow',
  // WORKFLOW-WORDS-v1 -- what this form calls each outcome. See formWords().
  'actionLabels',
] as const

export const FIELDS_COLUMNS = [
  'formId', 'fieldKey', 'label', 'type', 'required', 'options', 'placeholder', 'help', 'sortOrder',
] as const

export const SUBS_COLUMNS = [
  'submissionId', 'formId', 'formTitle',
  'submittedByEmail', 'submittedByGid', 'submittedByName',
  'salonNum', 'status', 'summary', 'dataJson',
  'submittedAt', 'updatedAt', 'reviewedBy', 'reviewNote',
] as const

// FORM-COMMENTS-v1 — the conversation thread on a submission. Append-only.
export const COMMENT_COLUMNS = [
  'id', 'submissionId', 'author', 'authorRole', 'body', 'createdAt',
] as const

// Field types the client renderer knows how to draw. `employee` and `salon`
// are roster-backed pickers — they store the real globalId / salonNum rather
// than a typed name, which is the whole point of moving off Google Forms.
// `multiselect` is a tick-all-that-apply group and stores an ARRAY; it is what a
// Google Forms checkbox question migrates to. `checkbox` stays a single yes/no.
export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox',
  'multiselect', 'employee', 'salon', 'photo', 'section', // PHOTO-FIELD-v1
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const SUBMISSION_STATUSES = [
  'submitted', 'in_review', 'approved', 'denied', 'closed',
] as const
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]

export interface FormField {
  fieldKey: string
  label: string
  type: FieldType
  required: boolean
  options: string[]
  placeholder: string
  help: string
  sortOrder: number
}

export interface FormDef {
  formId: string
  title: string
  description: string
  icon: string
  audience: string[]        // roles, or ['all']
  status: string            // 'active' | anything else = hidden
  sortOrder: number
  notify: string[]          // RESPONSE-CONFIG-v1 — emails / 'am' who get emailed on activity
  responseView: string[]    // RESPONSE-CONFIG-v2 tags: am / office / maintenance / owner (owner-lock)
  workflow: string          // WORKFLOW-v1: 'ticket' | 'approval' | 'record' | '' (legacy = all actions)
  actionLabels: Record<string, string>   // WORKFLOW-WORDS-v1 overrides, by status
  labels: Record<string, string>         // resolved: what each status is CALLED
  actions: FormAction[]                  // resolved: the buttons, in order
  fields: FormField[]
}

export interface FormAction { status: string; label: string; primary: boolean }

const norm = (s: unknown) => String(s ?? '').trim()
const lower = (s: unknown) => norm(s).toLowerCase()
const num = (s: unknown) => { const n = Number(norm(s)); return Number.isFinite(n) ? n : 0 }

// Sheets has no boolean cell type that survives a round trip cleanly, so treat
// the usual human spellings as true. Blank = false.
export function truthy(v: unknown): boolean {
  const s = lower(v)
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'x'
}

// Split a comma/semicolon/pipe-separated cell into trimmed parts.
function splitList(v: unknown): string[] {
  return norm(v).split(/[|;,]/).map(s => s.trim()).filter(Boolean)
}

// ── Audience gating ───────────────────────────────────────────
// An `audience` cell is a comma-separated role list, or 'all' / blank for
// everyone. Used by forms, announcements, dates and links alike.
export function audienceAllows(audience: unknown, role: Role | string): boolean {
  const list = splitList(audience).map(s => s.toLowerCase())
  if (list.length === 0 || list.includes('all') || list.includes('*')) return true
  const r = String(role || '').toLowerCase()
  if (list.includes(r)) return true
  // Convenience aliases so the spreadsheet can say the natural thing.
  if (list.includes('am') && r === 'area_manager') return true
  if (list.includes('admins') && (r === 'owner' || r === 'admin')) return true
  return false
}

// ── Reads ─────────────────────────────────────────────────────

// Load every form definition, with its fields attached and sorted.
// Tolerates missing tabs (returns []) so a fresh install never 500s.
// == Wording =================================================================
// WORKFLOW-WORDS-v1
//
// The workflow decides WHICH buttons exist. What they are CALLED is per form.
//
// "Approve / Deny" is right for a time-off request and wrong for a supply
// order, which is not approved but ordered -- and a manager reading "Denied"
// against a box of bin bags has to translate before they understand it. One
// vocabulary for fifteen different forms was always going to read as
// bureaucracy on most of them.
//
// The STORED status values never change: submitted / in_review / approved /
// denied / closed. Only the display does. So renaming what a form calls its
// outcome cannot invalidate a single row of history, and a form whose wording
// is edited twice still reports on the submissions filed under the first.

export const STATUS_KEYS = ['submitted', 'in_review', 'approved', 'denied', 'closed'] as const
export type StatusKey = typeof STATUS_KEYS[number]

// The default vocabulary per workflow -- the state a submission is IN.
const WF_STATE: Record<string, Record<string, string>> = {
  ticket:   { submitted: 'New',       in_review: 'In progress', approved: 'Complete', denied: 'Cancelled', closed: 'Complete' },
  approval: { submitted: 'Pending',   in_review: 'Reviewing',   approved: 'Approved', denied: 'Denied',    closed: 'Closed' },
  record:   { submitted: 'New',       in_review: 'Reviewing',   approved: 'Reviewed', denied: 'Filed',     closed: 'Reviewed' },
  '':       { submitted: 'Submitted', in_review: 'In review',   approved: 'Approved', denied: 'Denied',    closed: 'Closed' },
}

// Which buttons the workflow offers, in order, with the default imperative.
const WF_ACTIONS: Record<string, { status: StatusKey; verb: string; primary?: boolean }[]> = {
  ticket:   [{ status: 'in_review', verb: 'Mark in progress' }, { status: 'closed',   verb: 'Complete', primary: true }, { status: 'denied', verb: 'Cancel' }],
  approval: [{ status: 'in_review', verb: 'Mark in review' },   { status: 'approved', verb: 'Approve',  primary: true }, { status: 'denied', verb: 'Deny' }],
  record:   [{ status: 'closed',    verb: 'Mark reviewed', primary: true }],
  '':       [{ status: 'in_review', verb: 'Mark in review' },   { status: 'approved', verb: 'Approve',  primary: true }, { status: 'denied', verb: 'Deny' }, { status: 'closed', verb: 'Close' }],
}

/** `in_review=Ordering|approved=Ordered` -> { in_review: 'Ordering', ... } */
export function parseActionLabels(cell: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of norm(cell).split('|')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim().toLowerCase()
    const v = part.slice(i + 1).trim()
    if ((STATUS_KEYS as readonly string[]).includes(k) && v) out[k] = v
  }
  return out
}

export function serializeActionLabels(labels: Record<string, string>): string {
  return STATUS_KEYS
    .filter(k => norm(labels[k]))
    // '=' and '|' are the separators; a label containing one would parse back
    // as a different pair, so they are stripped rather than escaped.
    .map(k => k + '=' + norm(labels[k]).replace(/[=|]/g, ' ').trim())
    .filter(pair => pair.split('=')[1])
    .join('|')
}

/**
 * What one form actually shows: the word for each status, and its buttons.
 *
 * An overridden word wins on the BUTTON as well as the chip. A form whose
 * outcome is called "Ordered" must not have a button that says "Approve" --
 * that is the exact mismatch this exists to remove.
 */
export function formWords(
  workflow: string, overrides: Record<string, string> = {},
): { labels: Record<string, string>; actions: FormAction[] } {
  const key = lower(workflow)
  const labels: Record<string, string> = { ...(WF_STATE[key] || WF_STATE['']) }
  for (const k of STATUS_KEYS) if (norm(overrides[k])) labels[k] = norm(overrides[k])
  const actions: FormAction[] = (WF_ACTIONS[key] || WF_ACTIONS['']).map(a => ({
    status: a.status,
    label: norm(overrides[a.status]) || a.verb,
    primary: !!a.primary,
  }))
  return { labels, actions }
}

export async function getFormDefs(): Promise<FormDef[]> {
  const [defRows, fieldRows] = await Promise.all([
    rowsToObjects(await readSheet(TAB_DEFS)),
    rowsToObjects(await readSheet(TAB_FIELDS)),
  ])

  const byForm = new Map<string, FormField[]>()
  for (const r of fieldRows) {
    const formId = norm(r.formId)
    const fieldKey = norm(r.fieldKey)
    if (!formId || !fieldKey) continue
    const type = lower(r.type) as FieldType
    const field: FormField = {
      fieldKey,
      label: norm(r.label) || fieldKey,
      type: (FIELD_TYPES as readonly string[]).includes(type) ? type : 'text',
      required: truthy(r.required),
      options: splitList(r.options),
      placeholder: norm(r.placeholder),
      help: norm(r.help),
      sortOrder: num(r.sortOrder),
    }
    const arr = byForm.get(formId)
    if (arr) arr.push(field)
    else byForm.set(formId, [field])
  }
  for (const arr of byForm.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder)

  return defRows
    .map(r => {
      const formId = norm(r.formId)
      if (!formId) return null
      const actionLabels = parseActionLabels(r.actionLabels)
      return {
        formId,
        title: norm(r.title) || formId,
        description: norm(r.description),
        icon: norm(r.icon) || '📝',
        audience: splitList(r.audience),
        status: lower(r.status) || 'active',
        sortOrder: num(r.sortOrder),
        notify: splitList(r.notify),
        responseView: splitList(r.responseView),
        workflow: lower(r.workflow),
        actionLabels,
        ...formWords(lower(r.workflow), actionLabels),
        fields: byForm.get(formId) || [],
      } as FormDef
    })
    .filter((f): f is FormDef => f !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

// Forms a given role may actually open: active, has fields, audience matches.
export async function getFormDefsForRole(role: Role | string): Promise<FormDef[]> {
  const all = await getFormDefs()
  return all.filter(f =>
    f.status === 'active' &&
    f.fields.length > 0 &&
    audienceAllows(f.audience, role)
  )
}

export interface Submission {
  submissionId: string
  formId: string
  formTitle: string
  submittedByEmail: string
  submittedByGid: string
  submittedByName: string
  salonNum: string
  status: string
  summary: string
  data: Record<string, any>
  submittedAt: string
  updatedAt: string
  reviewedBy: string
  reviewNote: string
}

export interface Comment {
  id: string
  submissionId: string
  author: string
  authorRole: string
  body: string
  createdAt: string
}

// All comments across all submissions. The caller groups by submissionId and
// attaches only threads the viewer is already allowed to see, so this never
// leaks. FormComments is small and append-only.
export async function getComments(): Promise<Comment[]> {
  const rows = rowsToObjects(await readSheet(TAB_COMMENTS))
  return rows
    .map(r => ({
      id: norm(r.id),
      submissionId: norm(r.submissionId),
      author: norm(r.author),
      authorRole: norm(r.authorRole),
      body: norm(r.body),
      createdAt: norm(r.createdAt),
    }))
    .filter(c => c.id && c.submissionId)
}

export async function getSubmissions(): Promise<Submission[]> {
  const rows = rowsToObjects(await readSheet(TAB_SUBS))
  return rows
    .map(r => {
      let data: Record<string, any> = {}
      try { data = JSON.parse(norm(r.dataJson) || '{}') } catch { data = {} }
      return {
        submissionId: norm(r.submissionId),
        formId: norm(r.formId),
        formTitle: norm(r.formTitle),
        submittedByEmail: norm(r.submittedByEmail),
        submittedByGid: norm(r.submittedByGid),
        submittedByName: norm(r.submittedByName),
        salonNum: norm(r.salonNum),
        status: lower(r.status) || 'submitted',
        summary: norm(r.summary),
        data,
        submittedAt: norm(r.submittedAt),
        updatedAt: norm(r.updatedAt),
        reviewedBy: norm(r.reviewedBy),
        reviewNote: norm(r.reviewNote),
      }
    })
    .filter(s => s.submissionId && s.formId)
}

// ── Scoping ───────────────────────────────────────────────────
//
// Who may SEE a submission:
//   owner / admin / viewer  → everything
//   area_manager            → their salons, plus anything they submitted
//   manager                 → their salon, plus anything they submitted
//   stylist                 → only their own
//
// A submission with no salonNum is visible only to its author and to
// owner/admin/viewer — it can't be attributed to a salon scope, so it must not
// leak sideways to an AM who happens to be looking.
// RESPONSE-CONFIG-v3 — who may SEE or ACT on a submission, from the form's
// responseView tags. Owner and admin always see everything. Tags ADD groups
// for the scoped roles only: 'am' (the salon's area manager), 'office'
// (Laura/Brandy), 'maintenance' (the handyman). Blank defaults to 'am'.
// Legacy 'standard' is read as 'am'.
function roleSeesTags(
  role: string, responseView: string[], salonInScope: boolean, forAction = false,
): boolean {
  const t = (responseView || []).map(x => {
    const v = String(x).toLowerCase().trim()
    return v === 'standard' ? 'am' : v
  })
  const amDefault = t.length === 0 || t.includes('am')

  if (role === 'owner' || role === 'admin') return true  // both see everything
  if (role === 'viewer') return false                    // viewers never see responses
  if (role === 'area_manager') return amDefault && salonInScope
  // A MANAGER READS, BUT DOES NOT ACT. They see their salon's responses on the
  // same terms an area manager does -- useful for "has anyone reported this
  // already?" -- but every status button belongs to the AM above them, so
  // forAction is where they stop. Note this DOES mean a manager sees anything
  // filed about their salon on a form whose responseView is blank, since blank
  // means 'am': check the audience of anything sensitive before enabling them.
  if (role === 'manager') return !forAction && amDefault && salonInScope
  if (role === 'office') return t.includes('office')
  if (role === 'maintenance') return t.includes('maintenance')
  return false
}

export function canViewSubmission(sub: Submission, access: Access, email: string, responseView: string[] = []): boolean {
  // The person who submitted always sees their own request — even confidential.
  const mine =
    (!!access.globalId && sub.submittedByGid === access.globalId) ||
    (!!email && sub.submittedByEmail.toLowerCase() === email.toLowerCase())
  if (mine) return true
  const scope = (access.salons || []).map(s => String(s).trim())
  const salonInScope = !!sub.salonNum && scope.includes(sub.salonNum)
  return roleSeesTags(access.role, responseView, salonInScope)
}

// Who may CHANGE a submission's status. Deliberately narrower than viewing:
// authors can see their own request but must not approve it themselves.
export function canReviewSubmission(
  sub: Submission, access: Access, responseView: string[] = [], email = '',
): boolean {
  // AN AUTHOR DOES NOT ACTION THEIR OWN REQUEST -- unless there is nobody above
  // them. forms/submit stamps a submission with the submitter's own salon, so
  // for an AM or manager salonInScope was ALWAYS true on their own request and
  // they could approve it themselves. That escalates now, which is the point.
  //
  // Owner and admin are exempt, because for them the rule has no escalation to
  // offer: they ARE the top of it. Blocking them made an owner-submitted
  // approval permanently unactionable, and -- because the client hides the
  // whole Requests tab when nothing is reviewable -- made it invisible too.
  const mine =
    (!!access.globalId && sub.submittedByGid === access.globalId) ||
    (!!email && sub.submittedByEmail.toLowerCase() === email.toLowerCase())
  const terminal = access.role === 'owner' || access.role === 'admin'
  if (mine && !terminal) return false

  const scope = (access.salons || []).map(s => String(s).trim())
  const salonInScope = !!sub.salonNum && scope.includes(sub.salonNum)
  return roleSeesTags(access.role, responseView, salonInScope, true)
}

export function filterSubmissions(subs: Submission[], access: Access, email: string, defs: FormDef[] = []): Submission[] {
  const rv = new Map(defs.map(d => [d.formId, d.responseView || []]))
  return subs.filter(s => canViewSubmission(s, access, email, rv.get(s.formId) || []))
}

// ── Write helpers ─────────────────────────────────────────────

export function newSubmissionId(): string {
  return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// Build the "Label: value" digest stored alongside the JSON so the Sheets tab
// stays readable without anyone having to parse a JSON blob by eye.
export function buildSummary(def: FormDef, data: Record<string, any>): string {
  const parts: string[] = []
  for (const f of def.fields) {
    if (f.type === 'section') continue
    const raw = data[f.fieldKey]
    if (raw === undefined || raw === null || raw === '') continue
    if (f.type === 'photo') {
      const n = Array.isArray(raw) ? raw.length : (raw ? 1 : 0)
      if (n === 0) continue
      parts.push(`${f.label}: ${n} photo${n === 1 ? '' : 's'}`)
      continue
    }
    const val = Array.isArray(raw) ? raw.join(', ') : String(raw)
    parts.push(`${f.label}: ${val}`)
  }
  return parts.join(' | ').slice(0, 4000)
}

// Validate a submission against its definition. Returns a list of problems;
// empty means valid. Server-side because the client check is only a courtesy.
export function validateSubmission(def: FormDef, data: Record<string, any>): string[] {
  const errors: string[] = []
  for (const f of def.fields) {
    if (f.type === 'section') continue
    const raw = data[f.fieldKey]
    const empty =
      raw === undefined || raw === null || raw === '' ||
      (Array.isArray(raw) && raw.length === 0)

    if (f.required && empty) {
      errors.push(`${f.label} is required`)
      continue
    }
    if (empty) continue

    if (f.type === 'number' && !Number.isFinite(Number(raw))) {
      errors.push(`${f.label} must be a number`)
    }
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
      errors.push(`${f.label} must be a date (YYYY-MM-DD)`)
    }
    if ((f.type === 'select' || f.type === 'radio') && f.options.length > 0) {
      if (!f.options.includes(String(raw))) {
        errors.push(`${f.label} must be one of: ${f.options.join(', ')}`)
      }
    }
    if (f.type === 'multiselect' && f.options.length > 0) {
      const chosen = Array.isArray(raw) ? raw : [raw]
      const unknown = chosen.map(String).filter(v => !f.options.includes(v))
      if (unknown.length) {
        errors.push(`${f.label} has invalid option(s): ${unknown.join(', ')}`)
      }
    }
    if (f.type === 'photo') {
      // Values must look like pathnames the upload route produced — this stops
      // a hand-crafted POST stuffing arbitrary strings or URLs into the sheet.
      const arr = Array.isArray(raw) ? raw : [raw]
      const bad = arr.map(String).filter(v => !/^forms\/[a-z0-9_-]+\/[\w.\-]+$/i.test(v))
      if (bad.length) errors.push(`${f.label} has invalid photo reference(s)`)
    }
  }
  return errors
}

// Strip anything the definition doesn't declare, so a hand-crafted POST can't
// stuff arbitrary keys into the sheet.
export function pickDeclaredFields(def: FormDef, data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const f of def.fields) {
    if (f.type === 'section') continue
    const v = data[f.fieldKey]
    if (v === undefined) continue
    if (Array.isArray(v)) out[f.fieldKey] = v.map(x => String(x).slice(0, 500))
    else out[f.fieldKey] = String(v).slice(0, 5000)
  }
  return out
}
