// app/api/forms/import-more/route.ts
//
// FORMS-IMPORT-MORE-v1  (Ctrl+F this string to confirm the file saved)
//
// Adds four forms: Leave of Absence, Performance Check-In, Customer Service
// (Redo), and Request for Donation. Owner/admin only. Re-runnable: each run
// upserts the form defs and rewrites their fields, so editing this file and
// re-POSTing updates the live forms.
//
// Run once from the console after deploying:
//   fetch('/api/forms/import-more', {method:'POST'}).then(r=>r.json()).then(console.log)
//
// NOTE: option labels never contain commas — the form engine splits options on
// commas as well as pipes, so we use " / " where a comma would read naturally.
// The Performance Check-In's `nextCheckIn` date is what the follow-up reminder
// job keys on.

import { NextResponse } from 'next/server'
import {requireCapability} from '@/lib/require-role'
import { readSheet, rowsToObjects, writeSheet, ensureTab } from '@/lib/sheets'
import { TAB_DEFS, TAB_FIELDS, DEFS_COLUMNS, FIELDS_COLUMNS } from '@/lib/forms'

type Def = Record<string, string>
type Field = Record<string, string>

function f(fieldKey: string, label: string, type: string, required: boolean, opts = '', help = '', sortOrder = 0): Field {
  return { fieldKey, label, type, required: required ? 'yes' : '', options: opts, placeholder: '', help, sortOrder: String(sortOrder) }
}

const FORMS: Array<{ def: Def; fields: Field[] }> = [
  // ── Leave of Absence ──
  {
    def: {
      formId: 'leave-of-absence', title: 'Leave of Absence Request',
      description: 'Request a leave of absence. Whenever possible, submit 30 days before the leave begins.',
      icon: '🌴', audience: 'owner,admin,area_manager', status: 'active', sortOrder: '130',
      notify: 'am, office', responseView: 'am, office', workflow: 'approval',
    },
    fields: [
      f('employee', 'Employee', 'employee', true, '', '', 10),
      f('salon', 'Salon', 'salon', true, '', '', 20),
      f('startDate', 'Anticipated Start of Leave', 'date', true, '', '', 30),
      f('returnDate', 'Anticipated Return to Work', 'date', true, '', '', 40),
      f('reason', 'Reason for Leave', 'multiselect', true,
        'Personal medical condition|Birth / adoption / foster placement of my child|Care for a child / spouse / parent with a serious health condition|Personal family matter (not FMLA-eligible)|Unable to perform my job due to a serious health condition|Other',
        'Check all that apply.', 50),
      f('reasonOther', 'If Other — describe', 'text', false, '', '', 55),
      f('vacationHours', 'Vacation hours to use during leave', 'number', false, '', '', 60),
      f('benefitCoverage', 'If benefits are deducted from your paycheck — how to cover them', 'multiselect', false,
        'Use vacation time (minimum needed)|Spread the cost over the first six paychecks after I return|Pay with personal funds at the Longitude office|Other',
        'Check all that apply.', 70),
      f('acknowledge', 'By submitting, you acknowledge the FMLA and return-to-work terms discussed with your manager', 'section', false, '', '', 80),
    ],
  },
  // ── Performance Check-In ──
  {
    def: {
      formId: 'performance-checkin', title: 'Performance Check-In',
      description: 'Document progress during a performance-improvement or training period.',
      icon: '📈', audience: 'owner,admin,area_manager', status: 'active', sortOrder: '135',
      notify: 'am, office', responseView: 'am, office', workflow: 'record',
    },
    fields: [
      f('employee', 'Employee', 'employee', true, '', '', 10),
      f('salon', 'Salon', 'salon', true, '', '', 20),
      f('checkInDate', 'Check-In Date', 'date', true, '', '', 30),
      f('checkInType', 'Type', 'select', true, 'Presentation of Plan|General Check-In|Final Check-In', '', 40),
      f('generalNotes', 'General Notes on Conversation', 'textarea', true, '', '', 50),
      f('measure1', 'Progress on Performance Measure #1', 'textarea', true, '', '', 60),
      f('measure2', 'Progress on Performance Measure #2', 'textarea', false, '', '', 70),
      f('measure3', 'Progress on Performance Measure #3', 'textarea', false, '', '', 80),
      f('overallProgress', 'Overall Progress', 'textarea', true, '', '', 90),
      f('nextSteps', 'Next Steps', 'select', true,
        'Continue on their plan with another check-in|Final — successfully completed the plan|Final — plan will be extended|Final — they will receive points', '', 100),
      f('finalNotes', 'Final Notes (points / extension details)', 'textarea', true, '', '', 110),
      f('nextCheckIn', 'Next Check-In / Follow-Up Date', 'date', false, '', 'Office, the area manager, and the manager get a reminder as this date approaches.', 120),
    ],
  },
  // ── Customer Service (Redo) ──
  {
    def: {
      formId: 'redo', title: 'Customer Service (Redo)',
      description: 'Log a customer complaint and how it was resolved.',
      icon: '💇', audience: 'owner,admin,area_manager', status: 'active', sortOrder: '140',
      notify: 'am, office', responseView: 'am, office', workflow: 'record',
    },
    fields: [
      f('salon', 'Salon', 'salon', true, '', '', 10),
      f('originalServiceDate', 'Date of Original Service', 'date', true, '', '', 20),
      f('correctionDate', 'Date of Correction', 'date', true, '', '', 30),
      f('complaintSource', 'Complaint Source', 'select', true, 'Salon|Direct Contact|Corporate|Other', '', 40),
      f('service', 'Service', 'text', true, '', '', 50),
      f('otherSalon', 'If the original stylist is at another salon — which one', 'text', false, '', '', 60),
      f('customerName', 'Customer Name', 'text', true, '', '', 70),
      f('customerPhone', 'Customer Phone', 'text', true, '', '', 80),
      f('customerAddress', 'Customer Address', 'text', false, '', '', 90),
      f('complaintDescription', 'Description of Complaint', 'textarea', true, '', '', 100),
      f('feedbackCategory', 'Feedback Category', 'select', true,
        'Online Check-in|ReadyNext texts|Products|Wait time|Physical salon|Hours|Gift Cards|Coupons / Sales|Payment|Hair Donation|Staffing|Database / Mailing list|Prices|Stylist Behavior|Hair service issue|Mask requirement|Children and masks|ADA|Racial discrimination|Autism|Children|Other', '', 110),
      f('resolutionDescription', 'Description of Resolution', 'textarea', true, '', '', 120),
      f('howHandled', 'How was the complaint handled', 'radio', true, 'Redo performed|Refund', '', 130),
      f('originalStylist', 'Stylist who provided the original service', 'text', true, '', '', 140),
      f('handlingStylist', 'Stylist who handled the complaint', 'text', true, '', '', 150),
    ],
  },
  // ── Request for Donation ──
  {
    def: {
      formId: 'donation', title: 'Request for Donation',
      description: 'Request approval for a donation. All donations require sign-off before they are given.',
      icon: '🎁', audience: 'owner,admin,area_manager', status: 'active', sortOrder: '145',
      notify: 'owner, office', responseView: 'owner, office', workflow: 'approval',
    },
    fields: [
      f('employee', 'Requested By', 'employee', true, '', '', 10),
      f('salon', 'Salon', 'salon', true, '', '', 20),
      f('companyName', 'Company / Organization Name', 'text', true, '', '', 30),
      f('donationType', 'Type of Donation', 'radio', true, 'Cash|Gift Card|Product|Other', '', 40),
      f('donationValue', 'Value of Donation', 'text', true, '', '', 50),
      f('donationPurpose', 'What will the donation go towards', 'textarea', true, '', '', 60),
    ],
  },
]

export async function POST() {
  const gate = await requireCapability('manage.forms')
  if (!gate.ok) return gate.response

  try {
    await ensureTab(TAB_DEFS)
    await ensureTab(TAB_FIELDS)
    const ids = new Set(FORMS.map(x => x.def.formId))

    // FormDefs — upsert each of our forms, leave the rest untouched.
    const defs = rowsToObjects(await readSheet(TAB_DEFS))
    const seen = new Set<string>()
    const nextDefs = defs.map(r => {
      const id = String(r.formId || '').trim()
      const match = FORMS.find(x => x.def.formId === id)
      if (match) { seen.add(id); return { ...r, ...match.def } }
      return r
    })
    for (const x of FORMS) if (!seen.has(x.def.formId)) nextDefs.push({ ...x.def })
    await writeSheet(TAB_DEFS, [
      [...DEFS_COLUMNS],
      ...nextDefs.map(r => DEFS_COLUMNS.map(c => String((r as any)[c] ?? ''))),
    ])

    // FormFields — drop our forms' rows, re-add fresh; keep everyone else's.
    const fields = rowsToObjects(await readSheet(TAB_FIELDS))
    const kept = fields.filter(r => !ids.has(String(r.formId || '').trim()))
    const newRows: string[][] = []
    for (const x of FORMS) {
      for (const fld of x.fields) {
        newRows.push(FIELDS_COLUMNS.map(c => (c === 'formId' ? x.def.formId : String((fld as any)[c] ?? ''))))
      }
    }
    await writeSheet(TAB_FIELDS, [
      [...FIELDS_COLUMNS],
      ...kept.map(r => FIELDS_COLUMNS.map(c => String((r as any)[c] ?? ''))),
      ...newRows,
    ])

    return NextResponse.json({
      success: true,
      forms: FORMS.map(x => x.def.formId),
      fieldCount: newRows.length,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
