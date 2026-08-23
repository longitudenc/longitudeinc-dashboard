// app/api/forms/import/route.ts
//
// FORMS-IMPORT-v1  (Ctrl+F this string to confirm the file saved)
//
// Loads your real Google Forms into the dashboard in one shot. Works exactly
// like the seed route: the forms are baked in below, and re-running is safe —
// a form whose formId already exists is SKIPPED, so nothing you've edited is
// touched. To add more forms later I extend the list and you re-run.
//
// Owner/admin only. After deploying, run once from the browser console:
//   fetch('/api/forms/import', {method:'POST'}).then(r=>r.json()).then(console.log)
//
// Field-type choices applied while translating each Google Form:
//   • the salon dropdown  -> the roster "salon" picker (so it scopes correctly)
//   • an employee's name   -> the roster "employee" picker (ties to a real person)
//   • checkboxes           -> multiselect ;  multiple-choice -> radio
//   • paragraphs           -> textarea    ;  dates -> date
//   • the "Your email" / "Submitted by" / "Form completed by" boxes are DROPPED,
//     because the dashboard already records who submitted.

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { readSheet, rowsToObjects, appendSheet, ensureTab } from '@/lib/sheets'
import { TAB_DEFS, TAB_FIELDS, DEFS_COLUMNS, FIELDS_COLUMNS } from '@/lib/forms'

const AM_AUDIENCE = 'owner,admin,area_manager'
const ADMIN_ONLY = 'owner,admin' // for confidential forms (C.A.R.E. Fund)
const POSITIONS = 'Receptionist|Stylist|Assistant Manager|Manager'

const IMPORT_FORMS: Array<{
  def: Record<string, string>
  fields: Array<Record<string, string>>
}> = [
  // ── Kudos ──────────────────────────────────────────────────────────────
  {
    def: { formId: 'kudos', title: 'Kudos Form', description: 'Recognize an employee for great work.', icon: '🌟', audience: AM_AUDIENCE, status: 'active', sortOrder: '110' },
    fields: [
      { fieldKey: 'employee', label: 'Employee', type: 'employee', required: 'yes', options: '', placeholder: '', help: "The person you're recognizing.", sortOrder: '10' },
      { fieldKey: 'salon', label: 'Salon', type: 'salon', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'position', label: 'Position', type: 'radio', required: 'yes', options: POSITIONS, placeholder: '', help: '', sortOrder: '30' },
      { fieldKey: 'situation', label: 'Description of the Situation', type: 'textarea', required: 'yes', options: '', placeholder: 'What did they do?', help: '', sortOrder: '40' },
      { fieldKey: 'notes', label: 'Further Notes', type: 'textarea', required: '', options: '', placeholder: '', help: '', sortOrder: '50' },
    ],
  },
  // ── Documentation Form ─────────────────────────────────────────────────
  {
    def: { formId: 'documentation', title: 'Documentation Form', description: 'Formally document an incident or performance concern for an employee.', icon: '🗂️', audience: AM_AUDIENCE, status: 'active', sortOrder: '120' },
    fields: [
      { fieldKey: 'employee', label: 'Documented Employee', type: 'employee', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
      { fieldKey: 'salon', label: 'Salon', type: 'salon', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'incidentDate', label: 'Date of Incident', type: 'date', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '30' },
      { fieldKey: 'situation', label: 'Description of the Situation', type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '40' },
      { fieldKey: 'employeeResponse', label: "Employee's Response", type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '50' },
      { fieldKey: 'actionTaken', label: 'Action to be Taken', type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '60' },
      { fieldKey: 'followUpDate', label: 'Follow-Up Date', type: 'date', required: '', options: '', placeholder: '', help: 'If applicable.', sortOrder: '70' },
    ],
  },
  // ── Conversation Documentation Form ────────────────────────────────────
  {
    def: { formId: 'conversation', title: 'Conversation Documentation Form', description: 'Document a coaching conversation, stay interview, or verbal counseling.', icon: '💬', audience: AM_AUDIENCE, status: 'active', sortOrder: '130' },
    fields: [
      { fieldKey: 'employee', label: 'Employee', type: 'employee', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
      { fieldKey: 'position', label: 'Position', type: 'radio', required: 'yes', options: POSITIONS, placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'salon', label: 'Salon', type: 'salon', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '30' },
      { fieldKey: 'reason', label: 'Reason for the Conversation', type: 'multiselect', required: 'yes', options: 'Stay Interview|Documentation of Verbal Counseling|Other', placeholder: '', help: '', sortOrder: '40' },
      { fieldKey: 'conversationDate', label: 'Date of Conversation', type: 'date', required: '', options: '', placeholder: '', help: '', sortOrder: '50' },
      { fieldKey: 'description', label: 'Description of the Conversation', type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '60' },
      { fieldKey: 'employeeResponse', label: "Employee's Response", type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '70' },
      { fieldKey: 'actionTaken', label: 'Action to be Taken', type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '80' },
      { fieldKey: 'followUpDate', label: 'Follow-Up Date', type: 'date', required: '', options: '', placeholder: '', help: 'If applicable.', sortOrder: '90' },
    ],
  },
  // ── C.A.R.E. Fund Request (CONFIDENTIAL — owner/admin only) ─────────────
  {
    def: { formId: 'carefund', title: 'C.A.R.E. Fund Request', description: 'Confidential request for emergency financial assistance for a team member. All requests are confidential.', icon: '❤️', audience: ADMIN_ONLY, status: 'active', sortOrder: '140' },
    fields: [
      { fieldKey: 'requestFor', label: 'Who is this request for?', type: 'text', required: 'yes', options: '', placeholder: 'The person in need (or yourself)', help: '', sortOrder: '10' },
      // NOTE: plain select, NOT the scoping "salon" picker, so these confidential
      // requests are never exposed to an area manager via salon scoping.
      { fieldKey: 'location', label: 'Salon / Location', type: 'select', required: 'yes', options: '1304 Hilltop Plaza|2554 Carmel Commons|3015 Food Lion Plaza|3025 Landing Station|3027 Franklin Square|3043 Roosevelt|3045 Park Selwyn|3053 Plantation Market|3058 Crown Pointe|3062 Mint Hill|3071 Sun Valley|3545 Meridian Plaza|3685 Marvin Gardens|4138 Northwoods|7728 Springfield|9478 Carolina Commons|9489 Arboretum|9689 Cureton|Other', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'employeeEmail', label: 'Email of the employee in need', type: 'text', required: '', options: '', placeholder: '', help: 'If you know it — so they can receive a copy of any decision.', sortOrder: '30' },
      { fieldKey: 'situation', label: 'Please explain the situation', type: 'textarea', required: 'yes', options: '', placeholder: 'The difficult situation that puts you (or your teammate) in need.', help: '', sortOrder: '40' },
      { fieldKey: 'amount', label: 'Dollar amount needed', type: 'number', required: 'yes', options: '', placeholder: '', help: 'Maximum $1,000 per year in gifts.', sortOrder: '50' },
    ],
  },
  // ── Notice of Separation ───────────────────────────────────────────────
  {
    def: { formId: 'separation', title: 'Notice of Separation', description: 'Record an employee separation, the exit checklist, and rehire eligibility.', icon: '📄', audience: AM_AUDIENCE, status: 'active', sortOrder: '150' },
    fields: [
      { fieldKey: 'employee', label: 'Employee', type: 'employee', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
      { fieldKey: 'salon', label: 'Salon', type: 'salon', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'separationDate', label: 'Date of Separation', type: 'date', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '30' },
      { fieldKey: 'separationType', label: 'Separation Type', type: 'radio', required: 'yes', options: 'Voluntary|Involuntary', placeholder: '', help: 'Voluntary = the employee chose to leave (quit, no-show, moved). Involuntary = no longer needed, no fault of their own.', sortOrder: '40' },
      { fieldKey: 'reason', label: 'Reason for Separation', type: 'textarea', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '50' },
      { fieldKey: 'checklist', label: 'Separation Checklist', type: 'multiselect', required: '', options: 'Money owed paid back|Company property / manuals returned|Insurance information completed|Salon key returned|Outstanding expenses paid|Removed access to GCU|Exit interview completed', placeholder: '', help: '', sortOrder: '60' },
      { fieldKey: 'rehireable', label: 'Is this person rehireable?', type: 'radio', required: 'yes', options: 'Yes|No', placeholder: '', help: '', sortOrder: '70' },
      { fieldKey: 'notRehireableReason', label: 'If not rehireable, why?', type: 'textarea', required: '', options: '', placeholder: '', help: '', sortOrder: '80' },
      { fieldKey: 'xmasFund', label: 'Xmas Fund to be paid out?', type: 'radio', required: 'yes', options: 'Yes|No|Unsure', placeholder: '', help: '', sortOrder: '90' },
      { fieldKey: 'comments', label: 'Comments', type: 'textarea', required: '', options: '', placeholder: 'Outstanding loans, missing keys, referral bonus ending, etc.', help: '', sortOrder: '100' },
    ],
  },
  // ── Supply Order Form ──────────────────────────────────────────────────
  {
    def: { formId: 'supplyorder', title: 'Supply Order Form', description: 'Order cleaning, paper, office, and printer supplies for a salon.', icon: '📦', audience: AM_AUDIENCE, status: 'active', sortOrder: '160' },
    fields: [
      { fieldKey: 'salon', label: 'Salon', type: 'salon', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
      { fieldKey: 'cleaning', label: 'Cleaning Supplies', type: 'multiselect', required: '', options: 'Lysol Disinfectant Spray|Lysol All Purpose Cleaner|Clorox Clean Up Spray|Laundry Detergent (Liquid)|Laundry Detergent (Powder)|Hand Soap|Hand Sanitizer|Windex|Dryer Sheets|Toilet Paper|Jumbo Toilet Paper|Alcohol|Swiffer Wet Jet: Pads|Swiffer Wet Jet: Liquid|Swiffer Power Mop: Pads|Swiffer Power Mop: Liquid', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'paper', label: 'Paper Products', type: 'multiselect', required: '', options: 'Multi-Fold|Standard Paper Towels|Towels', placeholder: '', help: '', sortOrder: '30' },
      { fieldKey: 'office', label: 'Office Supplies', type: 'multiselect', required: '', options: 'Pens|Paper Clips|Dry Erase Markers|Highlighters|Scotch Tape|White Out|Deposit Slips|Post-Its|Receipt Paper|Dum Dums|Lightning Charger (Old iPads)|USB-C Charger (Newer iPads)', placeholder: '', help: '', sortOrder: '40' },
      { fieldKey: 'trashBags', label: 'Trash Bags', type: 'multiselect', required: '', options: '13 Gallon|33 Gallon', placeholder: '', help: '', sortOrder: '50' },
      { fieldKey: 'printer', label: 'Printer Supplies', type: 'multiselect', required: '', options: 'Paper|Front Report Printer Ink|Back Room Printer 2860 Ink|Back Room Printer 2960 Ink|222 Ink', placeholder: '', help: '', sortOrder: '60' },
      { fieldKey: 'notes', label: 'Anything else / notes', type: 'textarea', required: '', options: '', placeholder: '', help: 'Model numbers, quantities, or items not listed above.', sortOrder: '70' },
    ],
  },
  // ── Employee Status Change ─────────────────────────────────────────────
  {
    def: { formId: 'statuschange', title: 'Employee Status Change', description: 'Update contact info, availability, or personal details. Only fill in what changed.', icon: '✏️', audience: AM_AUDIENCE, status: 'active', sortOrder: '170' },
    fields: [
      { fieldKey: 'employee', label: 'Employee', type: 'employee', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
      { fieldKey: 'salon', label: 'Salon', type: 'salon', required: 'yes', options: '', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'legalName', label: 'Legal Name Change', type: 'text', required: '', options: '', placeholder: '', help: 'Must be legally changed.', sortOrder: '30' },
      { fieldKey: 'phone', label: 'Phone Number', type: 'text', required: '', options: '', placeholder: '', help: '', sortOrder: '40' },
      { fieldKey: 'email', label: 'Email', type: 'text', required: '', options: '', placeholder: '', help: '', sortOrder: '50' },
      { fieldKey: 'address', label: 'Address', type: 'textarea', required: '', options: '', placeholder: '', help: '', sortOrder: '60' },
      { fieldKey: 'emergencyContact', label: 'Emergency Contact', type: 'text', required: '', options: '', placeholder: 'Name and phone number', help: '', sortOrder: '70' },
      { fieldKey: 'maritalStatus', label: 'Marital Status', type: 'select', required: '', options: 'Single|Married|Divorced|Widowed', placeholder: '', help: '', sortOrder: '80' },
    ],
  },
]

export async function POST() {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    await ensureTab(TAB_DEFS)
    await ensureTab(TAB_FIELDS)

    const existing = rowsToObjects(await readSheet(TAB_DEFS))
    const have = new Set(existing.map(r => String(r.formId || '').trim()).filter(Boolean))

    const created: string[] = []
    const skipped: string[] = []
    const defRows: string[][] = []
    const fieldRows: string[][] = []

    for (const f of IMPORT_FORMS) {
      if (have.has(f.def.formId)) { skipped.push(f.def.formId); continue }
      defRows.push(DEFS_COLUMNS.map(c => f.def[c] ?? ''))
      for (const fld of f.fields) {
        fieldRows.push(FIELDS_COLUMNS.map(c => (c === 'formId' ? f.def.formId : (fld[c] ?? ''))))
      }
      created.push(f.def.formId)
    }

    if (defRows.length) await appendSheet(TAB_DEFS, defRows)
    if (fieldRows.length) await appendSheet(TAB_FIELDS, fieldRows)

    return NextResponse.json({ success: true, created, skipped })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
