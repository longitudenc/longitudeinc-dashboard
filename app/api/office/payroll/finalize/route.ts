// app/api/office/payroll/finalize/route.ts
//
// Lock a week in.
//
// Until now the only record a week existed was written as a SIDE EFFECT of
// clicking Download — so an accidental download logged a week, and a week
// checked and agreed but not yet downloaded logged nothing. Neither matches how
// the office actually works: you review, you decide it is right, and THEN it is
// the version of record.
//
// Finalizing writes that decision down: the totals as they stood, the
// corrections against SD3, the hand-keyed lines that were included, and who
// pressed it. Downloads still log themselves — that is the delivery receipt,
// which is a different fact from "this is the version we agreed".
//
//   GET  ?weekEnd=YYYY-MM-DD   is this week finalized, and by whom
//   POST { weekEnd }           finalize it (rebuilds server-side first)
//
// Owner/admin/office. Deliberately NOT irreversible — see DELETE — because a
// lock nobody can undo just gets worked around.

import { NextRequest, NextResponse } from 'next/server'
import {requireCapability} from '@/lib/require-role'
import { runPayrollBuild } from '@/lib/adp-run'
import { readSheet, rowsToObjects, upsertSheet, writeSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TAB = 'ADP_FINALIZED'

// FINALIZE-SALONS-v1.
//
// The weekly row answers "how much". This answers "where", which is the
// question every reconciliation actually asks: a week that differs from the
// office spreadsheet by $0.70 is a conversation until you can say which salon
// and which line, and then it is a lookup.
//
// The build already computes all of this -- runPayrollBuild returns
// salonTotals -- and finalize was discarding it, so answering "which salon"
// about a past week meant a rebuild. A rebuild is ~20 live SD3 calls AND can
// return different numbers, because SD3 settles for days after a week closes.
// A week you have agreed to should keep enough detail to defend itself.
const SALON_TAB = 'ADP_FINALIZED_SALONS'
const SALON_COLUMNS = [
  'weekEnd', 'salonNum', 'employees', 'hours',
  'grossPay', 'tips', 'totalPay',
  'overtimePay', 'otTrueUp', 'sixDayDelta', 'breakMinutes',
] as const
const COLUMNS = [
  'weekEnd', 'weekStart', 'payDate',
  'employees', 'grossPay', 'tips', 'totalPay',
  'overtimePay', 'overtimeDelta', 'sixDayDelta', 'manualLines', 'manualTotal',
  'exceptions', 'finalizedAt', 'finalizedBy', 'note',
] as const

const S = (v: unknown) => String(v ?? '').trim()
const N = (v: unknown) => { const x = parseFloat(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(x) ? x : 0 }

async function readAll(): Promise<Record<string, any>[]> {
  try { return rowsToObjects((await readSheet(TAB, undefined, { fresh: true })) || []) }
  catch { return [] }
}

export async function GET(req: NextRequest) {
  const gate = await requireCapability('view.payroll')
  if (!gate.ok) return gate.response
  const weekEnd = S(new URL(req.url).searchParams.get('weekEnd'))
  const rows = await readAll()
  const row = rows.find(r => S(r.weekEnd) === weekEnd) || null
  return NextResponse.json({ success: true, weekEnd, finalized: !!row, record: row })
}

export async function POST(req: NextRequest) {
  const gate = await requireCapability('view.payroll')
  if (!gate.ok) return gate.response

  try {
    const body = await req.json().catch(() => ({}))
    const weekEnd = S(body?.weekEnd)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
      return NextResponse.json({ success: false, error: 'weekEnd must be YYYY-MM-DD' }, { status: 400 })
    }

    const existing = (await readAll()).find(r => S(r.weekEnd) === weekEnd)
    if (existing && !body?.force) {
      return NextResponse.json({
        success: false, alreadyFinalized: true, record: existing,
        error: `Week ending ${weekEnd} was already finalized on ${S(existing.finalizedAt)} by ${S(existing.finalizedBy)}.`,
      }, { status: 409 })
    }

    // Rebuilt here rather than trusting numbers posted from the browser: the
    // record of what was agreed has to be the real figures, not whatever a
    // stale tab happened to be showing.
    const r = await runPayrollBuild({ weekEnd })
    const manualTotal = (r.meta.manualDetail || []).reduce((s, m) => s + N((m as any).amount), 0)

    const row: Record<string, string> = {
      weekEnd: r.weekEnd,
      weekStart: r.weekStart,
      payDate: r.payDate,
      employees: String(r.totals.employees),
      grossPay: N(r.totals.grossPay).toFixed(2),
      tips: N(r.totals.tips).toFixed(2),
      totalPay: N(r.totals.totalPay).toFixed(2),
      overtimePay: N(r.totals.overtimePay).toFixed(2),
      overtimeDelta: N(r.totals.overtimeDelta).toFixed(2),
      sixDayDelta: N(r.totals.sixDayDelta).toFixed(2),
      manualLines: String((r.meta.manualDetail || []).length),
      manualTotal: manualTotal.toFixed(2),
      exceptions: String((r.exceptions || []).filter(e => (e as any).severity === 'blocking').length),
      finalizedAt: new Date().toISOString(),
      finalizedBy: gate.email,
      note: S(body?.note),
    }

    await upsertSheet(TAB, [...COLUMNS], ['weekEnd'], [row])

    // Per salon, written whole for this week and leaving every other week
    // alone. Not upsertSheet: that keys on a single column and this is many
    // rows per week, so a re-finalize has to replace the set rather than merge
    // into it -- otherwise a salon that dropped out of the build would linger.
    try {
      const salonRows = (r.salonTotals || []).map(t => ({
        weekEnd: r.weekEnd,
        salonNum: t.salonNum,
        employees: String(t.employees),
        hours: N(t.hours).toFixed(2),
        grossPay: N(t.grossPay).toFixed(2),
        tips: N(t.tips).toFixed(2),
        totalPay: N(t.totalPay).toFixed(2),
        overtimePay: N(t.overtimePay).toFixed(2),
        otTrueUp: N(t.otTrueUp).toFixed(2),
        sixDayDelta: N(t.sixDayDelta).toFixed(2),
        breakMinutes: N(t.breakMinutes).toFixed(2),
      }))
      let kept: Record<string, any>[] = []
      try {
        kept = rowsToObjects((await readSheet(SALON_TAB, undefined, { fresh: true })) || [])
          .filter(x => S(x.weekEnd) !== r.weekEnd)
      } catch { kept = [] }
      await writeSheet(SALON_TAB, [
        [...SALON_COLUMNS],
        ...[...kept, ...salonRows].map((x: any) => SALON_COLUMNS.map(c => String(x[c] ?? ''))),
      ])
    } catch (e) {
      // The week IS finalized -- that write already succeeded. Losing the
      // per-salon detail is a worse report, not a worse record, so it must not
      // turn an agreed week into a failed request.
      console.error('[payroll/finalize] per-salon detail failed:', e)
    }
    return NextResponse.json({ success: true, record: row })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

/**
 * Unlock a week. A lock that cannot be undone is a lock people route around —
 * they finalize late, or not at all, and the record stops meaning anything.
 * Owner/admin/office, and the removal is visible because the row disappears
 * from the tab rather than being edited in place.
 */
export async function DELETE(req: NextRequest) {
  const gate = await requireCapability('view.payroll')
  if (!gate.ok) return gate.response
  try {
    const weekEnd = S(new URL(req.url).searchParams.get('weekEnd'))
    const rows = await readAll()
    const keep = rows.filter(r => S(r.weekEnd) !== weekEnd)
    if (keep.length === rows.length) {
      return NextResponse.json({ success: true, weekEnd, removed: false })
    }
    const { writeSheet } = await import('@/lib/sheets')
    await writeSheet(TAB, [[...COLUMNS], ...keep.map(r => COLUMNS.map(c => S((r as any)[c])))])
    return NextResponse.json({ success: true, weekEnd, removed: true })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
