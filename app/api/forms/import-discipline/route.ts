// app/api/forms/import-discipline/route.ts
//
// FORMS-DISCIPLINE-IMPORT-v1  (Ctrl+F this string to confirm the file saved)
//
// Adds the disciplinary-points "Documentation Form" (formId 'discipline') and
// RETIRES the old simple 'documentation' form so you're not left with two.
// Owner/admin only. Re-runnable: it rewrites the discipline form's fields each
// time and re-retires documentation.
//
// Run once from the browser console after deploying:
//   fetch('/api/forms/import-discipline', {method:'POST'}).then(r=>r.json()).then(console.log)
//
// The `violation` options carry their point value as "(N pts)". On submit,
// lib/disc-points.ts parses that number and writes an event to the DiscPoints
// tracker — see app/api/forms/submit/route.ts.

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { readSheet, rowsToObjects, writeSheet, ensureTab } from '@/lib/sheets'
import { TAB_DEFS, TAB_FIELDS, DEFS_COLUMNS, FIELDS_COLUMNS } from '@/lib/forms'

const FORM_ID = 'discipline'

const VIOLATIONS = [
  'No Call/No Show — scheduled shift (8 pts)',
  'No Call/No Show — scheduled salon meeting (2 pts)',
  'Not attending a training class (2 pts)',
  'Tardy with a call (1 pts)',
  'Tardy without a call (2 pts)',
  'Calling out without covering shift (2 pts)',
  'Dress code violation (2 pts)',
  'More than one break per 4 hours with customers waiting (2 pts)',
  'Smoking/Vaping in the salon (2 pts)',
  'Leaving station unclean (2 pts)',
  'Clocking out with 2+ customers waiting without approval (2 pts)',
  'Not completing duties (2 pts)',
  'Gossip about a coworker their family or owner (2 pts)',
  'Two or more redos in a month (2 pts)',
  'Two or more customer complaints in a month (2 pts)',
  'Clocking out and leaving a stylist alone (4 pts)',
  'Turning a customer away before posted closing time (4 pts)',
  'Performing unapproved services (4 pts)',
  'Unprofessional behavior/conversation in front of a customer or management (4 pts)',
  'Giving unauthorized discounts or coupons (6 pts)',
  'Falsification of work / personnel / company records (6 pts)',
  'Soliciting customers at any time for a competitive business (8 pts)',
].join('|')


const DEF: Record<string, string> = {
  formId: FORM_ID,
  title: 'Documentation Form',
  description: 'Document a policy violation and its points. Feeds the disciplinary points tracker.',
  icon: '📋',
  audience: 'owner,admin,area_manager',
  status: 'active',
  sortOrder: '125',
  notify: 'am, office',
  responseView: 'am, office',
  workflow: 'record',
}

const FIELDS: Array<Record<string, string>> = [
  { fieldKey: 'employee', label: 'Documented Employee', type: 'employee', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
  { fieldKey: 'salon', label: 'Salon', type: 'salon', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '20' },
  { fieldKey: 'violationDate', label: 'Date of Violation', type: 'date', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '30' },
  { fieldKey: 'violation', label: 'Violation', type: 'select', required: 'yes', options: VIOLATIONS, placeholder: '', help: 'Points are assigned automatically from the violation.', sortOrder: '40' },
  { fieldKey: 'employeeResponse', label: "Employee's Response", type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '60' },
  { fieldKey: 'comments', label: 'Additional Comments', type: 'textarea', required: '', options: '', placeholder: '', help: '', sortOrder: '70' },
]

export async function POST() {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    await ensureTab(TAB_DEFS)
    await ensureTab(TAB_FIELDS)

    // ── FormDefs: upsert 'discipline', retire 'documentation' ──
    const defs = rowsToObjects(await readSheet(TAB_DEFS))
    let hadDiscipline = false
    let retiredDocumentation = false
    const nextDefs = defs.map(r => {
      const id = String(r.formId || '').trim()
      if (id === FORM_ID) { hadDiscipline = true; return { ...r, ...DEF } }
      if (id === 'documentation' && String(r.status || '').trim().toLowerCase() !== 'retired') {
        retiredDocumentation = true
        return { ...r, status: 'retired' }
      }
      return r
    })
    if (!hadDiscipline) nextDefs.push({ ...DEF })

    await writeSheet(TAB_DEFS, [
      [...DEFS_COLUMNS],
      ...nextDefs.map(r => DEFS_COLUMNS.map(c => String((r as any)[c] ?? ''))),
    ])

    // ── FormFields: drop discipline's old rows, re-add fresh ──
    const fields = rowsToObjects(await readSheet(TAB_FIELDS))
    const kept = fields.filter(r => String(r.formId || '').trim() !== FORM_ID)
    const newFieldRows = FIELDS.map(f =>
      FIELDS_COLUMNS.map(c => (c === 'formId' ? FORM_ID : String((f as any)[c] ?? '')))
    )
    await writeSheet(TAB_FIELDS, [
      [...FIELDS_COLUMNS],
      ...kept.map(r => FIELDS_COLUMNS.map(c => String((r as any)[c] ?? ''))),
      ...newFieldRows,
    ])

    return NextResponse.json({
      success: true,
      form: FORM_ID,
      addedForm: !hadDiscipline,
      updatedForm: hadDiscipline,
      retiredDocumentation,
      fieldCount: FIELDS.length,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
