// app/api/gs/saveThresholds/route.ts
//
// Save the 4/3/2/1 metric bands edited in Admin > Metric Thresholds.
//
// A save writes ONE dated set: every metric gets a row stamped with the same
// effectiveFrom. Rows carrying other dates are preserved untouched, so the tab
// accumulates a history and grading a past week still resolves the bands that
// were in force then. Re-saving the same date replaces that set rather than
// duplicating it, which makes the Save button idempotent.
//
// GET returns the rows as stored, for the editor's history table.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { writeSheet } from '@/lib/sheets'
import {
  TAB_THRESHOLDS, THRESHOLD_COLUMNS, METRIC_META,
  getThresholdRows, normEffective, type ThresholdRow,
} from '@/lib/thresholds'

const KNOWN = new Set(METRIC_META.map(m => m.metric))

// '' for a blank cell rather than 0 — a missing bound must stay missing, since
// gradeMetric treats null as "this rung doesn't exist" and 0 as a real bound.
const cell = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : ''
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    return NextResponse.json({ success: true, rows: await getThresholdRows() })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  // Bands drive scorecards, bonuses and raise reviews — owner/admin only.
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const body = await req.json()
    const effectiveFrom = normEffective(body?.effectiveFrom)
    const incoming: any[] = Array.isArray(body?.rows) ? body.rows : []

    if (!effectiveFrom) {
      return NextResponse.json(
        { success: false, error: 'An effective-from date is required, so past periods keep their original bands.' },
        { status: 400 },
      )
    }
    const clean = incoming.filter(r => KNOWN.has(String(r?.metric || '').trim().toLowerCase()))
    if (!clean.length) {
      return NextResponse.json({ success: false, error: 'No recognised metrics in the request.' }, { status: 400 })
    }

    // Keep every other dated set; replace only the one being saved.
    const existing: ThresholdRow[] = await getThresholdRows()
    const kept = existing.filter(r => r.effectiveFrom !== effectiveFrom)

    const rows = [...kept, ...clean.map(r => {
      const metric = String(r.metric).trim().toLowerCase()
      const meta = METRIC_META.find(m => m.metric === metric)
      return {
        metric,
        direction: String(r.direction || meta?.direction || 'higher').trim().toLowerCase(),
        v4: r.v4, v3: r.v3, v2: r.v2, v4hi: r.v4hi, v3hi: r.v3hi, v2hi: r.v2hi,
        effectiveFrom,
        notes: String(r.notes || '').trim(),
      }
    })]

    // Oldest first, then by metric — the tab stays readable if opened directly.
    rows.sort((a, b) =>
      String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)) ||
      String(a.metric).localeCompare(String(b.metric)))

    const values: string[][] = [[...THRESHOLD_COLUMNS]]
    for (const r of rows) {
      values.push([
        String(r.metric), String(r.direction),
        cell(r.v4), cell(r.v3), cell(r.v2),
        cell(r.v4hi), cell(r.v3hi), cell(r.v2hi),
        String(r.effectiveFrom || ''), String(r.notes || ''),
      ])
    }
    await writeSheet(TAB_THRESHOLDS, values)

    return NextResponse.json({ success: true, effectiveFrom, saved: clean.length, total: rows.length })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}

// Remove one dated set entirely (the editor's "Remove" on a history row).
export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const effectiveFrom = normEffective(new URL(req.url).searchParams.get('effectiveFrom'))
    if (!effectiveFrom) {
      return NextResponse.json({ success: false, error: 'effectiveFrom is required' }, { status: 400 })
    }
    const rows = (await getThresholdRows()).filter(r => r.effectiveFrom !== effectiveFrom)
    const values: string[][] = [[...THRESHOLD_COLUMNS]]
    for (const r of rows) {
      values.push([
        String(r.metric), String(r.direction),
        cell(r.v4), cell(r.v3), cell(r.v2),
        cell(r.v4hi), cell(r.v3hi), cell(r.v2hi),
        String(r.effectiveFrom || ''), String(r.notes || ''),
      ])
    }
    await writeSheet(TAB_THRESHOLDS, values)
    return NextResponse.json({ success: true, remaining: rows.length })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
