// app/api/forms/seed/route.ts
//
// ONE-TIME SETUP. Creates the six spreadsheet tabs the Forms + Home features
// read from, writes their header rows, and seeds three starter forms plus a
// small amount of example Home content.
//
// Idempotent: a form whose formId already exists is skipped, and headers are
// only written to an empty tab. Safe to re-run — re-running after you've
// customised a form will NOT overwrite your edits.
//
// Owner/admin only. Call it once from the browser after deploying:
//   fetch('/api/forms/seed', {method:'POST'}).then(r=>r.json()).then(console.log)

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { readSheet, rowsToObjects, appendSheet, ensureTab } from '@/lib/sheets'
import { TAB_DEFS, TAB_FIELDS, TAB_SUBS, DEFS_COLUMNS, FIELDS_COLUMNS, SUBS_COLUMNS } from '@/lib/forms'
import {
  TAB_ANNOUNCEMENTS, TAB_DATES, TAB_LINKS,
  ANNOUNCEMENT_COLUMNS, DATE_COLUMNS, LINK_COLUMNS,
  todayIsoET, newId,
} from '@/lib/home'

// Starter forms. `audience` is area_manager + owner/admin for now; widen the
// cell to include `manager` (or `all`) in the FormDefs tab when managers come
// online — no code change needed.
const AM_AUDIENCE = 'owner,admin,area_manager'

const SEED_FORMS: Array<{
  def: Record<string, string>
  fields: Array<Record<string, string>>
}> = [
  {
    def: {
      formId: 'timeoff',
      title: 'Time-Off / Availability Request',
      description: 'Request time off, a schedule swap, or a permanent availability change.',
      icon: '🗓️',
      audience: AM_AUDIENCE,
      status: 'active',
      sortOrder: '10',
    },
    fields: [
      { fieldKey: 'employee',    label: 'Employee',        type: 'employee', required: 'yes', options: '', placeholder: '', help: 'Pick from the roster so the request is tied to the right person.', sortOrder: '10' },
      { fieldKey: 'salon',       label: 'Salon',           type: 'salon',    required: 'yes', options: '', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'requestType', label: 'Request Type',    type: 'select',   required: 'yes', options: 'Time Off|Availability Change|Schedule Swap', placeholder: '', help: '', sortOrder: '30' },
      { fieldKey: 'startDate',   label: 'Start Date',      type: 'date',     required: 'yes', options: '', placeholder: '', help: '', sortOrder: '40' },
      { fieldKey: 'endDate',     label: 'End Date',        type: 'date',     required: '',    options: '', placeholder: '', help: 'Leave blank for a single day.', sortOrder: '50' },
      { fieldKey: 'reason',      label: 'Reason',          type: 'textarea', required: 'yes', options: '', placeholder: 'Brief reason for the request', help: '', sortOrder: '60' },
      { fieldKey: 'coverage',    label: 'Coverage Plan',   type: 'textarea', required: '',    options: '', placeholder: 'Who is covering these shifts?', help: '', sortOrder: '70' },
    ],
  },
  {
    def: {
      formId: 'incident',
      title: 'Incident / Injury Report',
      description: 'Document a customer or employee injury, property damage, or a serious complaint.',
      icon: '⚠️',
      audience: AM_AUDIENCE,
      status: 'active',
      sortOrder: '20',
    },
    fields: [
      { fieldKey: 'salon',         label: 'Salon',                 type: 'salon',    required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
      { fieldKey: 'incidentDate',  label: 'Date of Incident',      type: 'date',     required: 'yes', options: '', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'incidentTime',  label: 'Approximate Time',      type: 'text',     required: '',    options: '', placeholder: 'e.g. 2:30 PM', help: '', sortOrder: '30' },
      { fieldKey: 'incidentType',  label: 'Type',                  type: 'select',   required: 'yes', options: 'Customer Injury|Employee Injury|Property Damage|Customer Complaint|Other', placeholder: '', help: '', sortOrder: '40' },
      { fieldKey: 'peopleInvolved',label: 'People Involved',       type: 'textarea', required: 'yes', options: '', placeholder: 'Names and roles (employee, customer, witness)', help: '', sortOrder: '50' },
      { fieldKey: 'description',   label: 'What Happened',         type: 'textarea', required: 'yes', options: '', placeholder: 'Describe the incident in sequence', help: 'Stick to facts. Avoid opinions or blame.', sortOrder: '60' },
      { fieldKey: 'actionTaken',   label: 'Action Taken',          type: 'textarea', required: 'yes', options: '', placeholder: 'Immediate steps taken at the salon', help: '', sortOrder: '70' },
      { fieldKey: 'emergency',     label: 'Police or Medical Called?', type: 'radio', required: 'yes', options: 'Yes|No', placeholder: '', help: '', sortOrder: '80' },
      { fieldKey: 'followUp',      label: 'Follow-Up Needed',      type: 'textarea', required: '',    options: '', placeholder: '', help: '', sortOrder: '90' },
    ],
  },
  {
    def: {
      formId: 'maintenance',
      title: 'Maintenance / Repair Request',
      description: 'Report something broken or in need of repair at a salon.',
      icon: '🔧',
      audience: AM_AUDIENCE,
      status: 'active',
      sortOrder: '30',
    },
    fields: [
      { fieldKey: 'salon',       label: 'Salon',          type: 'salon',    required: 'yes', options: '', placeholder: '', help: '', sortOrder: '10' },
      { fieldKey: 'issueType',   label: 'Issue Type',     type: 'select',   required: 'yes', options: 'Plumbing|Electrical|HVAC|Equipment|Furniture & Fixtures|Signage|Flooring|Other', placeholder: '', help: '', sortOrder: '20' },
      { fieldKey: 'urgency',     label: 'Urgency',        type: 'radio',    required: 'yes', options: 'Emergency — salon cannot operate|High — affects service|Normal|Low — cosmetic', placeholder: '', help: '', sortOrder: '30' },
      { fieldKey: 'description', label: 'Description',    type: 'textarea', required: 'yes', options: '', placeholder: 'What is broken, and where in the salon?', help: '', sortOrder: '40' },
      { fieldKey: 'firstNoticed',label: 'First Noticed',  type: 'date',     required: '',    options: '', placeholder: '', help: '', sortOrder: '50' },
      { fieldKey: 'vendor',      label: 'Vendor Contacted', type: 'text',   required: '',    options: '', placeholder: 'If you already called someone', help: '', sortOrder: '60' },
    ],
  },
]

const SEED_LINKS: Array<Record<string, string>> = [
  { label: 'CLT Market Compare',        url: '/market.html',                        icon: '🗺️', category: 'Dashboards', sortOrder: '10', audience: 'owner,admin,viewer,area_manager' },
  { label: 'Flexibility & Reliability', url: '/flexibility_reliability_tool.html',  icon: '📊', category: 'Dashboards', sortOrder: '20', audience: 'owner,admin,viewer,area_manager' },
  { label: 'Careers Page',              url: '/jobs/index.html',                    icon: '💼', category: 'Hiring',     sortOrder: '30', audience: '' },
  { label: 'SalonData (SD3)',           url: 'https://reports.salondata.com',       icon: '📈', category: 'Systems',    sortOrder: '40', audience: 'owner,admin,viewer,area_manager' },
  { label: 'Great Clips MyReports',     url: 'https://myreports.greatclips.com',    icon: '✂️', category: 'Systems',    sortOrder: '50', audience: 'owner,admin,viewer,area_manager' },
]

// Write a header row only when the tab is completely empty, so re-running never
// stomps existing data.
async function ensureHeader(tab: string, columns: readonly string[]): Promise<boolean> {
  await ensureTab(tab)
  const rows = await readSheet(tab)
  if (rows.length === 0) {
    await appendSheet(tab, [[...columns]])
    return true
  }
  return false
}

export async function POST() {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const created: string[] = []
    const skipped: string[] = []

    // 1) Tabs + headers
    for (const [tab, cols] of [
      [TAB_DEFS, DEFS_COLUMNS],
      [TAB_FIELDS, FIELDS_COLUMNS],
      [TAB_SUBS, SUBS_COLUMNS],
      [TAB_ANNOUNCEMENTS, ANNOUNCEMENT_COLUMNS],
      [TAB_DATES, DATE_COLUMNS],
      [TAB_LINKS, LINK_COLUMNS],
    ] as Array<[string, readonly string[]]>) {
      if (await ensureHeader(tab, cols)) created.push(`tab:${tab}`)
      else skipped.push(`tab:${tab}`)
    }

    // 2) Starter forms — skip any formId already present.
    const existingDefs = rowsToObjects(await readSheet(TAB_DEFS))
    const haveForms = new Set(existingDefs.map(r => String(r.formId || '').trim()).filter(Boolean))

    const defRows: string[][] = []
    const fieldRows: string[][] = []
    for (const f of SEED_FORMS) {
      if (haveForms.has(f.def.formId)) { skipped.push(`form:${f.def.formId}`); continue }
      defRows.push(DEFS_COLUMNS.map(c => f.def[c] ?? ''))
      for (const fld of f.fields) {
        fieldRows.push(FIELDS_COLUMNS.map(c => (c === 'formId' ? f.def.formId : (fld[c] ?? ''))))
      }
      created.push(`form:${f.def.formId}`)
    }
    if (defRows.length) await appendSheet(TAB_DEFS, defRows)
    if (fieldRows.length) await appendSheet(TAB_FIELDS, fieldRows)

    // 3) Quick links — skip by label so re-running doesn't duplicate.
    const existingLinks = rowsToObjects(await readSheet(TAB_LINKS))
    const haveLinks = new Set(existingLinks.map(r => String(r.label || '').trim().toLowerCase()).filter(Boolean))
    const linkRows: string[][] = []
    for (const l of SEED_LINKS) {
      if (haveLinks.has(l.label.toLowerCase())) { skipped.push(`link:${l.label}`); continue }
      linkRows.push(LINK_COLUMNS.map(c => (c === 'id' ? newId('lnk') : (l[c] ?? ''))))
      created.push(`link:${l.label}`)
    }
    if (linkRows.length) await appendSheet(TAB_LINKS, linkRows)

    // 4) A single welcome announcement, only if there are none at all.
    const existingAnn = rowsToObjects(await readSheet(TAB_ANNOUNCEMENTS))
    if (existingAnn.length === 0) {
      const today = todayIsoET()
      await appendSheet(TAB_ANNOUNCEMENTS, [ANNOUNCEMENT_COLUMNS.map(c => ({
        id: newId('ann'),
        title: 'Welcome to the new Longitude home page',
        body: 'Announcements, important dates and quick links all live here now. Admins can post an announcement from the ✎ Edit button on this page — no spreadsheet required.',
        pinned: 'yes',
        startDate: today,
        endDate: '',
        audience: '',
        createdBy: gate.email,
        createdAt: new Date().toISOString(),
      } as Record<string, string>)[c] ?? '')])
      created.push('announcement:welcome')
    } else {
      skipped.push('announcement:welcome')
    }

    return NextResponse.json({ success: true, created, skipped })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
