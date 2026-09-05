// app/api/office/payroll/reconcile/route.ts
//
// A week's payroll reconciliation as a CSV, laid out like the workbook the
// office keeps by hand: one column per salon, one row per component, and a
// notes column naming WHO caused each correction.
//
// The point is not another copy of the numbers — the preview screen already
// has those. It is the audit trail: when the file differs from SD3, this says
// by how much, at which salon, and because of whom, in a form that can be
// filed, printed, or pasted beside the old workbook while the two are still
// being run side by side.
//
//   GET ?weekEnd=YYYY-MM-DD   the week to reconcile (default: last completed)
//       &punches=live|sheet   passed through to the build
//
// Owner/admin/office, like everything else under /api/office.

import { NextRequest, NextResponse } from 'next/server'
import {requireCapability} from '@/lib/require-role'
import { runPayrollBuild } from '@/lib/adp-run'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const N = (v: unknown) => {
  const x = parseFloat(String(v ?? '').replace(/[$,]/g, ''))
  return Number.isFinite(x) ? x : 0
}
const S = (v: unknown) => String(v ?? '').trim()
const money = (n: number) => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)

/** RFC4180: quote anything containing a comma, quote or newline. */
function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',')

export async function GET(req: NextRequest) {
  const gate = await requireCapability('view.payroll')
  if (!gate.ok) return gate.response

  try {
    const url = new URL(req.url)
    const weekEnd = S(url.searchParams.get('weekEnd')) || undefined
    const punches = S(url.searchParams.get('punches'))
    const r = await runPayrollBuild({
      weekEnd,
      punchSource: punches === 'live' ? 'live' : undefined,
    })

    const salons = (r.salonTotals || []).map(s => S(s.salonNum)).sort()
    const bySalon = new Map(salons.map(sn => [sn, (r.salonTotals || []).find(s => S(s.salonNum) === sn)!]))

    // SD3's own figures for the same week, so the export shows both sides.
    const pay = rowsToObjects((await readSheet('SD_PAYROLL')) || [])
      .filter(x => S(x.weekEnd) === r.weekEnd)
    const sd3Base: Record<string, number> = {}
    const vacation: Record<string, number> = {}
    for (const x of pay) {
      const sn = S(x.salonNum)
      sd3Base[sn] = (sd3Base[sn] || 0) +
        N(x.subTotalPay) + N(x.productivityIncentive) + N(x.productIncentive) + N(x.newReturnIncentive)
      // SD3 reports vacation HOURS and pays nothing for them; the office pays
      // them at base wage. Shown here because the workbook carries the row.
      vacation[sn] = (vacation[sn] || 0) + N(x.vacationHours) * N(x.baseWage)
    }

    // Hand-keyed lines, so a missing one is visible rather than inferred from a
    // total that does not tie.
    let manual: Record<string, number> = {}
    let manualRows: any[] = []
    try {
      manualRows = rowsToObjects((await readSheet('ADP_MANUAL')) || [])
        .filter(x => S(x.weekEnd) === r.weekEnd)
      for (const x of manualRows) {
        const sn = S(x.salonNum)
        manual[sn] = (manual[sn] || 0) + N(x.amount)
      }
    } catch { /* tab may not exist yet */ }

    // 6-day correction per salon, from the build's own attribution.
    const sixBySalon: Record<string, number> = {}
    for (const d of (r.sixDay || [])) {
      for (const [sn, v] of Object.entries(d.deltaBySalon || {})) {
        sixBySalon[S(sn)] = (sixBySalon[S(sn)] || 0) + N(v)
      }
    }

    const line = (label: string, get: (sn: string) => number, note = '') => {
      const vals = salons.map(get)
      const total = vals.reduce((s, v) => s + v, 0)
      return csvRow([label, ...vals.map(money), money(total), note])
    }

    const out: string[] = []
    out.push(csvRow(['Longitude payroll reconciliation']))
    out.push(csvRow(['Week', r.weekStart + ' to ' + r.weekEnd, 'Pay date', r.payDate]))
    out.push(csvRow(['Generated', new Date().toISOString(), 'Punches', r.meta.punchSource,
                     '6-day source', r.meta.sixDaySource]))
    out.push('')

    out.push(csvRow(['Line', ...salons, 'Total', 'Notes']))
    out.push(line('SD3 base pay', sn => sd3Base[sn] || 0, 'subtotal + productivity + product + new/return'))
    out.push(line('Tips', sn => N(bySalon.get(sn)?.tips)))
    out.push(line('Vacation hours pay', sn => vacation[sn] || 0, 'SD3 reports the hours and pays $0; paid here at base wage'))
    out.push(line('6-day correction', sn => sixBySalon[sn] || 0, 'difference from what SD3 paid — see WHO below'))
    out.push(line('Overtime (this file)', sn => N(bySalon.get(sn)?.overtimePay), 'cross-salon hours merged — see WHO below'))
    out.push(line('Manual earnings', sn => manual[sn] || 0,
      manualRows.length ? '' : 'NONE KEYED for this week — anything hand-added to the old sheet is missing here'))
    out.push('')
    out.push(line('Gross pay (this file)', sn => N(bySalon.get(sn)?.grossPay)))
    out.push(line('Total pay (gross + tips)', sn => N(bySalon.get(sn)?.totalPay)))
    out.push('')

    // ── who each correction belongs to ──
    out.push(csvRow(['WHO THE CORRECTIONS BELONG TO']))
    out.push(csvRow(['Type', 'Employee', 'Salon', 'Amount', 'Why']))

    for (const d of (r.sixDay || [])) {
      if (Math.abs(N(d.delta)) < 0.005) continue
      const why = N(d.delta) < 0
        ? 'SD3 paid it, but ' + (S(d.reason) || 'does not qualify here')
        : (N(d.sd3Paid) === 0
            ? 'qualifies once salons are merged; SD3 paid nothing'
            : 'SD3 underpaid')
      const per = Object.entries(d.deltaBySalon || {})
      if (per.length) {
        for (const [sn, v] of per) {
          if (Math.abs(N(v)) < 0.005) continue
          out.push(csvRow(['6-day', S(d.employeeName), S(sn), money(N(v)), why]))
        }
      } else {
        out.push(csvRow(['6-day', S(d.employeeName), '', money(N(d.delta)), why]))
      }
    }

    for (const e of (r.employees || [])) {
      const delta = N((e as any).overtimeDelta)
      if (Math.abs(delta) < 0.005) continue
      const worked = Array.isArray((e as any).salons) ? (e as any).salons.join(' / ') : S((e as any).salonNum)
      const why = delta > 0
        ? 'hours merged across ' + worked + '; SD3 computes overtime per salon'
        : 'rate differs from SD3 for this week'
      out.push(csvRow(['Overtime', S((e as any).employeeName), worked, money(delta), why]))
    }

    for (const x of manualRows) {
      out.push(csvRow(['Manual', S(x.employeeName || x.name), S(x.salonNum), money(N(x.amount)), S(x.label)]))
    }

    out.push('')
    out.push(csvRow(['TOTALS AGAINST SD3']))
    out.push(csvRow(['Overtime, this file', money(N(r.totals.overtimePay))]))
    out.push(csvRow(['Overtime, SD3 paid', money(N(r.totals.overtimeSd3Paid))]))
    out.push(csvRow(['Overtime difference', money(N(r.totals.overtimeDelta))]))
    out.push(csvRow(['6-day, this file', money(N(r.totals.sixDayPay))]))
    out.push(csvRow(['6-day, SD3 paid', money(N(r.totals.sixDaySd3Paid))]))
    out.push(csvRow(['6-day difference', money(N(r.totals.sixDayDelta))]))
    out.push(csvRow(['Net difference from SD3',
      money(N(r.totals.overtimeDelta) + N(r.totals.sixDayDelta))]))

    const csv = '﻿' + out.join('\r\n') + '\r\n'   // BOM so Excel reads UTF-8
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="payroll-reconciliation-${r.weekEnd}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
