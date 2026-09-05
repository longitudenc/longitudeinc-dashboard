// app/api/forms/access/route.ts
//
// FORMS-ACCESS-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Owner-only. Saves a form's responseView + notify tags — this is where the
// "Manage access" gear dialog writes. Same read-modify-write as the status
// route: only two cells on one FormDefs row change; every other column and
// row round-trips untouched.
//
// CAPABILITIES-v2: gated on manage.forms, which owner and admin have by
// default -- the same two roles requireAdmin let through before. It is now a
// per-person toggle in Users & Access rather than a role list here.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
import { readSheet, rowsToObjects, writeSheet } from '@/lib/sheets'
import { TAB_DEFS, DEFS_COLUMNS, STATUS_KEYS, serializeActionLabels } from '@/lib/forms'

// The only group tags the engine understands. Anything else is dropped, except
// that notify additionally accepts real email addresses.
const GROUP_TAGS = new Set(['am', 'office', 'maintenance', 'owner'])
const WORKFLOWS = new Set(['ticket', 'approval', 'record'])

// Roles that may be named in `audience` -- who can OPEN and submit a form.
// Deliberately not every Role: 'viewer' is read-only by definition and would
// be misleading here, and blank/'all' already covers everyone.
const AUDIENCE_ROLES = new Set([
  'owner', 'admin', 'area_manager', 'manager', 'stylist', 'office', 'maintenance',
])

function cleanAudience(list: any): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    const v = String(raw).trim().toLowerCase()
    if (!v) continue
    // 'all' is a whole answer on its own; anything beside it is noise.
    if (v === 'all') return ['all']
    if (AUDIENCE_ROLES.has(v) && !out.includes(v)) out.push(v)
  }
  // OWNER AND ADMIN ARE ALWAYS IN. audienceAllows() has no bypass for them, and
  // the "Manage access" dialog is drawn from /api/forms/defs, which is itself
  // audience-filtered -- so saving an audience without them would hide the form
  // from the only screen that could put them back. Nobody should be able to
  // lock themselves out of a form's settings by editing that form's settings.
  for (const r of ['owner', 'admin']) if (!out.includes(r)) out.unshift(r)
  return out
}
const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)

// WORKFLOW-WORDS-v1. What this form calls each outcome -- only the five known
// statuses, and short enough to fit on a button. A blank clears the override
// and the form falls back to its workflow's default wording.
function cleanActionLabels(obj: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of STATUS_KEYS) {
    const v = String(obj[k] ?? '').trim().slice(0, 24)
    if (v) out[k] = v
  }
  return out
}

function cleanList(list: any, allowEmail: boolean): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    const v = String(raw).trim()
    if (!v) continue
    const lv = v.toLowerCase()
    if (GROUP_TAGS.has(lv)) { if (!out.includes(lv)) out.push(lv) }
    else if (allowEmail && isEmail(v)) { if (!out.includes(v)) out.push(v) }
    // silently ignore anything else
  }
  return out
}

export async function POST(req: Request) {
  const gate = await requireCapability('manage.forms')
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const formId = String(body?.formId || '').trim()
    if (!formId) {
      return NextResponse.json({ success: false, error: 'formId is required' }, { status: 400 })
    }

    const responseView = cleanList(body?.responseView, false) // tags only
    const notify = cleanList(body?.notify, true)               // tags + emails
    const wfIn = String(body?.workflow || '').trim().toLowerCase()
    const workflow = WORKFLOWS.has(wfIn) ? wfIn : ''
    // Only touched when the caller actually sends it, so a client that does not
    // know about audience yet cannot blank it by omission.
    const audience = body?.audience !== undefined ? cleanAudience(body.audience) : undefined
    // Like audience: only written when the caller actually sends it, so an
    // older client cannot blank a form's wording by not knowing about it.
    const actionLabels = body?.actionLabels !== undefined
      ? serializeActionLabels(cleanActionLabels(body.actionLabels)) : undefined

    // Re-read raw rows so every untouched column round-trips exactly.
    const raw = rowsToObjects(await readSheet(TAB_DEFS))
    let found = false
    const rows = raw.map(r => {
      if (String(r.formId || '').trim() === formId) {
        found = true
        return {
          ...r,
          responseView: responseView.join(', '),
          notify: notify.join(', '),
          workflow,
          ...(audience !== undefined ? { audience: audience.join(', ') } : {}),
          ...(actionLabels !== undefined ? { actionLabels } : {}),
        }
      }
      return r
    })
    if (!found) {
      return NextResponse.json({ success: false, error: 'form not found' }, { status: 404 })
    }

    await writeSheet(TAB_DEFS, [
      [...DEFS_COLUMNS],
      ...rows.map(r => DEFS_COLUMNS.map(c => String((r as any)[c] ?? ''))),
    ])

    // Return the cleaned arrays so the dialog can update its local copy.
    return NextResponse.json({
      success: true, formId, responseView, notify, workflow,
      ...(audience !== undefined ? { audience } : {}),
      ...(actionLabels !== undefined ? { actionLabels } : {}),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
