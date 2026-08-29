// app/api/office/payroll/settings/route.ts
//
// Read and write the ADP upload configuration — earnings codes, the salon →
// Batch Id / Co Code table, and the thresholds behind 6-day pay, short breaks,
// overtime and the bonus paycheck.
//
// Writing is owner/admin only. The office runs payroll; changing which ADP
// earnings code money lands on is a different kind of decision, and one bad
// code silently misroutes everyone's pay.
//
//   GET                     current settings + which keys came from the sheet
//   POST { rules?, codes?, salons? }   partial update, merged over what's stored

import { NextResponse } from 'next/server'
import { requireOffice, requireAdmin } from '@/lib/require-role'
import { loadAdpSettings, defaultSettings, ADP_FIELDS } from '@/lib/adp-settings'
import { readSheet, rowsToObjects, writeSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ADP_SETTINGS_TAB = 'ADP_SETTINGS'
const ADP_SALONS_TAB = 'ADP_SALONS'

// Every key the settings tab may carry. Anything else posted is ignored, so a
// stray field can't quietly become configuration.
const RULE_KEYS = [
  'sixDayRate', 'sixDayMinDays', 'sixDayMinShiftHours', 'sixDayMinFloorHours',
  'breakMaxMinutes', 'breakMode', 'otThresholdHours', 'varianceAlertPct',
  'bonusPaycheckOfMonth', 'payDateOffsetDays',
] as const

const CODE_KEYS = [
  ...ADP_FIELDS.map(f => f.key),
  'sixDay', 'shortBreak', 'stylistBonus',
]

export async function GET() {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response

  try {
    const settings = await loadAdpSettings()
    return NextResponse.json({
      success: true,
      settings,
      defaults: defaultSettings(),
      // Labels so the settings screen can name each code without duplicating
      // the field list in the client.
      fields: ADP_FIELDS.map(f => ({ key: f.key, label: f.label, slot: f.slot, isHours: f.isHours })),
      canEdit: gate.access.role === 'owner' || gate.access.role === 'admin',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }

  try {
    // ── key/value tab: read what's there, merge, write back whole ──
    // Read FRESH — see the manual route: a cached read here would silently drop
    // a setting someone else saved in the last few seconds.
    let existing: Record<string, string> = {}
    try {
      for (const r of rowsToObjects(await readSheet(ADP_SETTINGS_TAB, undefined, { fresh: true }))) {
        const k = String(r.key ?? '').trim()
        if (k) existing[k] = String(r.value ?? '')
      }
    } catch {
      existing = {}
    }

    if (body.rules && typeof body.rules === 'object') {
      for (const k of RULE_KEYS) {
        if (body.rules[k] === undefined) continue
        existing[k] = String(body.rules[k]).trim()
      }
    }
    if (body.codes && typeof body.codes === 'object') {
      for (const k of CODE_KEYS) {
        if (body.codes[k] === undefined) continue
        // A blank is meaningful: "this code is still unassigned".
        existing[`code.${k}`] = String(body.codes[k]).trim()
      }
    }

    const rows: any[][] = [['key', 'value']]
    for (const k of Object.keys(existing).sort()) rows.push([k, existing[k]])
    await writeSheet(ADP_SETTINGS_TAB, rows)

    // ── salon table, when supplied ──
    if (body.salons && typeof body.salons === 'object') {
      const salonRows: any[][] = [['salonNum', 'coCode', 'batchId']]
      for (const salonNum of Object.keys(body.salons).sort()) {
        const s = body.salons[salonNum] || {}
        const coCode = String(s.coCode ?? '').trim()
        const batchId = String(s.batchId ?? '').trim()
        if (!coCode || !batchId) continue
        salonRows.push([String(salonNum).trim(), coCode, batchId])
      }
      if (salonRows.length > 1) await writeSheet(ADP_SALONS_TAB, salonRows)
    }

    console.log(`[office/payroll/settings] updated by ${gate.email}`)
    return NextResponse.json({ success: true, settings: await loadAdpSettings() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[office/payroll/settings]', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
