// app/api/forms/access/route.ts
//
// FORMS-ACCESS-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Owner-only. Saves a form's responseView + notify tags — this is where the
// "Manage access" gear dialog writes. Same read-modify-write as the status
// route: only two cells on one FormDefs row change; every other column and
// row round-trips untouched.
//
// Owner-ONLY on purpose: if an admin could edit this, they could un-lock an
// owner-locked form (e.g. C.A.R.E. Fund) and grant themselves access.

import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/require-role'
import { readSheet, rowsToObjects, writeSheet } from '@/lib/sheets'
import { TAB_DEFS, DEFS_COLUMNS } from '@/lib/forms'

// The only group tags the engine understands. Anything else is dropped, except
// that notify additionally accepts real email addresses.
const GROUP_TAGS = new Set(['am', 'office', 'maintenance', 'owner'])
const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)

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
  const gate = await requireOwner()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const formId = String(body?.formId || '').trim()
    if (!formId) {
      return NextResponse.json({ success: false, error: 'formId is required' }, { status: 400 })
    }

    const responseView = cleanList(body?.responseView, false) // tags only
    const notify = cleanList(body?.notify, true)               // tags + emails

    // Re-read raw rows so every untouched column round-trips exactly.
    const raw = rowsToObjects(await readSheet(TAB_DEFS))
    let found = false
    const rows = raw.map(r => {
      if (String(r.formId || '').trim() === formId) {
        found = true
        return { ...r, responseView: responseView.join(', '), notify: notify.join(', ') }
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
    return NextResponse.json({ success: true, formId, responseView, notify })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
