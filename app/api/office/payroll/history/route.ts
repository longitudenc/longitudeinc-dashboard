// app/api/office/payroll/history/route.ts
//
// A record of every payroll file downloaded, so past weeks can be compared
// without rebuilding them (a rebuild means ~20 live SD3 calls, and SD3's
// numbers can settle days after the week closes, so a rebuilt figure is not
// necessarily the figure that was sent).
//
// TWO records per week, deliberately kept apart:
//   ADP_HISTORY   — a file was DOWNLOADED. A delivery receipt.
//   ADP_FINALIZED — the week was AGREED. A decision.
// A week can have either, both or neither: finalized but not yet sent, sent
// without being finalized (which is worth seeing), or downloaded twice. This
// merges them per week so the screen shows the week rather than the event.
//
//   GET ?limit=52   most recent weeks first

import { NextResponse } from 'next/server'
import {requireCapability} from '@/lib/require-role'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { ADP_HISTORY_TAB } from '@/lib/adp-history'

const FINALIZED_TAB = 'ADP_FINALIZED'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

export async function GET(request: Request) {
  const gate = await requireCapability('view.payroll')
  if (!gate.ok) return gate.response

  const limit = Math.min(200, Math.max(1, parseInt(
    new URL(request.url).searchParams.get('limit') || '52', 10) || 52))

  try {
    let rows: Record<string, any>[] = []
    try {
      rows = rowsToObjects(await readSheet(ADP_HISTORY_TAB))
    } catch {
      rows = [] // tab not created yet — nothing downloaded so far
    }

    // Most recent week first. A week downloaded more than once keeps only the
    // latest run, since that is the file that went to ADP.
    const byWeek = new Map<string, Record<string, any>>()
    for (const r of rows) {
      const weekEnd = String(r.weekEnd || '').trim()
      if (!weekEnd) continue
      const prev = byWeek.get(weekEnd)
      if (!prev || String(r.downloadedAt || '') > String(prev.downloadedAt || '')) {
        byWeek.set(weekEnd, r)
      }
    }

    const history = [...byWeek.values()]
      .sort((a, b) => String(b.weekEnd).localeCompare(String(a.weekEnd)))
      .slice(0, limit)
      .map(r => ({
        weekEnd: String(r.weekEnd || ''),
        weekStart: String(r.weekStart || ''),
        payDate: String(r.payDate || ''),
        fileName: String(r.fileName || ''),
        employees: num(r.employees),
        salons: num(r.salons),
        paidHours: num(r.paidHours),
        grossPay: num(r.grossPay),
        tips: num(r.tips),
        overtimePay: num(r.overtimePay),
        overtimeDelta: num(r.overtimeDelta),
        sixDayDelta: num(r.sixDayDelta),
        sixDaySd3Paid: num(r.sixDaySd3Paid),
        breakMinutes: num(r.breakMinutes),
        extraEarnings: num(r.extraEarnings),
        exceptions: num(r.exceptions),
        forced: String(r.forced || '') === 'true',
        // Present once the archive is working; older rows predate it.
        filePath: String(r.filePath || ''),
        downloadedAt: String(r.downloadedAt || ''),
        downloadedBy: String(r.downloadedBy || ''),
      }))

    // Finalized weeks, including ones never downloaded — which is exactly the
    // case that used to leave History empty after a week was signed off.
    let finalRows: Record<string, any>[] = []
    try { finalRows = rowsToObjects(await readSheet(FINALIZED_TAB)) } catch { finalRows = [] }
    const finalByWeek = new Map<string, Record<string, any>>()
    for (const r of finalRows) {
      const w = String(r.weekEnd || '').trim()
      if (w) finalByWeek.set(w, r)
    }

    const finalized = [...finalByWeek.values()].map(r => ({
      weekEnd: String(r.weekEnd || ''),
      weekStart: String(r.weekStart || ''),
      payDate: String(r.payDate || ''),
      employees: num(r.employees),
      grossPay: num(r.grossPay),
      tips: num(r.tips),
      totalPay: num(r.totalPay),
      overtimePay: num(r.overtimePay),
      overtimeDelta: num(r.overtimeDelta),
      sixDayDelta: num(r.sixDayDelta),
      manualLines: num(r.manualLines),
      manualTotal: num(r.manualTotal),
      exceptions: num(r.exceptions),
      finalizedAt: String(r.finalizedAt || ''),
      finalizedBy: String(r.finalizedBy || ''),
      note: String(r.note || ''),
    })).sort((a, b) => b.weekEnd.localeCompare(a.weekEnd))

    // One row per WEEK, whichever records it has.
    const weeks = [...new Set([
      ...history.map(h => h.weekEnd),
      ...finalized.map(f => f.weekEnd),
    ])].filter(Boolean).sort((a, b) => b.localeCompare(a)).slice(0, limit)
      .map(weekEnd => ({
        weekEnd,
        download: history.find(h => h.weekEnd === weekEnd) || null,
        finalized: finalized.find(f => f.weekEnd === weekEnd) || null,
      }))

    return NextResponse.json({ success: true, history, finalized, weeks })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
