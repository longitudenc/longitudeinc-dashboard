// app/api/office/payroll/preview/route.ts
//
// Build a week's ADP upload and return the whole result for review — summary
// totals, the exception report, per-employee detail (overtime, 6-day pay,
// short breaks, bonuses) and the upload rows themselves.
//
// This is the review step the office does before sending anything to ADP, so
// it NEVER writes and never has a side effect. The download lives at
// /api/office/payroll/export.
//
//   GET ?weekEnd=YYYY-MM-DD    week to build (default: last completed Sat→Fri)
//       &punches=live|sheet    punch source (default sheet, falls back to live)
//       &bonuses=1|0           force bonuses on/off (default: the 3rd-paycheck rule)
//       &bonusPeriod=Jul%2026  pay a specific bonus period
//       &rows=1                include the upload rows (omitted by default — large)

import { NextResponse } from 'next/server'
import { requireOffice } from '@/lib/require-role'
import { runPayrollBuild } from '@/lib/adp-run'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response

  const url = new URL(request.url)
  const weekEnd = url.searchParams.get('weekEnd') || undefined
  const punches = url.searchParams.get('punches')
  const bonuses = url.searchParams.get('bonuses')
  const wantRows = url.searchParams.get('rows') === '1'

  if (weekEnd && !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
    return NextResponse.json({ success: false, error: 'weekEnd must be YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const result = await runPayrollBuild({
      weekEnd,
      punchSource: punches === 'live' ? 'live' : 'sheet',
      includeBonuses: bonuses == null ? undefined : bonuses === '1',
      bonusPeriod: url.searchParams.get('bonusPeriod') || undefined,
    })

    const blocking = result.exceptions.filter(e => e.severity === 'blocking')

    return NextResponse.json({
      success: true,
      weekStart: result.weekStart,
      weekEnd: result.weekEnd,
      payDate: result.payDate,
      paycheckOfMonth: result.paycheckOfMonth,
      isBonusWeek: result.isBonusWeek,
      totals: result.totals,
      exceptions: result.exceptions,
      canExport: blocking.length === 0,
      employees: result.employees,
      sixDay: result.sixDay,
      breaks: result.breaks,
      fileName: result.upload.fileName,
      // Settings the review screen shows so the numbers are explainable.
      rules: result.settings.rules,
      codes: result.settings.codes,
      meta: result.meta,
      upload: wantRows ? { header: result.upload.header, rows: result.upload.rows } : undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[office/payroll/preview]', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
