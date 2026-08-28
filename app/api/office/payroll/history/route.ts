// app/api/office/payroll/history/route.ts
//
// A record of every payroll file downloaded, so past weeks can be compared
// without rebuilding them (a rebuild means ~20 live SD3 calls, and SD3's
// numbers can settle days after the week closes, so a rebuilt figure is not
// necessarily the figure that was sent).
//
// Rows are written by the export route at the moment a file is downloaded —
// that is when a week is actually processed. Preview never writes.
//
//   GET ?limit=52   most recent weeks first

import { NextResponse } from 'next/server'
import { requireOffice } from '@/lib/require-role'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { ADP_HISTORY_TAB } from '@/lib/adp-history'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

export async function GET(request: Request) {
  const gate = await requireOffice()
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
        downloadedAt: String(r.downloadedAt || ''),
        downloadedBy: String(r.downloadedBy || ''),
      }))

    return NextResponse.json({ success: true, history })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
