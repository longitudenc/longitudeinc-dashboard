// app/api/office/payroll/export/route.ts
//
// Download the ADP upload as CSV, named the way the old macro named it
// (EPI<CoCode><WeekNum>.csv).
//
// A week with BLOCKING exceptions is refused. A missing earnings code or a
// duplicate Payroll ID means someone's pay is about to land in the wrong place,
// and a payroll file is not a thing to ship past a known defect. Fix it, or
// pass &force=1 to override deliberately.
//
//   GET ?weekEnd=YYYY-MM-DD&punches=live|sheet&bonuses=1|0&force=1

import { NextResponse } from 'next/server'
import { requireOffice } from '@/lib/require-role'
import { runPayrollBuild } from '@/lib/adp-run'
import { upsertSheet } from '@/lib/sheets'
import { ADP_HISTORY_TAB, HISTORY_COLUMNS } from '@/lib/adp-history'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response

  const url = new URL(request.url)
  const weekEnd = url.searchParams.get('weekEnd') || undefined
  const bonuses = url.searchParams.get('bonuses')
  const force = url.searchParams.get('force') === '1'

  if (weekEnd && !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
    return NextResponse.json({ success: false, error: 'weekEnd must be YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const result = await runPayrollBuild({
      weekEnd,
      punchSource: url.searchParams.get('punches') === 'live' ? 'live' : 'sheet',
      includeBonuses: bonuses == null ? undefined : bonuses === '1',
      bonusPeriod: url.searchParams.get('bonusPeriod') || undefined,
    })

    const blocking = result.exceptions.filter(e => e.severity === 'blocking')
    if (blocking.length > 0 && !force) {
      return NextResponse.json({
        success: false,
        error: `${blocking.length} blocking exception(s) — resolve them or re-run with force=1`,
        exceptions: blocking,
      }, { status: 409 })
    }

    console.log(
      `[office/payroll/export] ${gate.email} downloaded ${result.upload.fileName} ` +
      `(${result.upload.rows.length} rows, week ending ${result.weekEnd}` +
      `${force && blocking.length ? `, FORCED past ${blocking.length} blocking` : ''})`
    )

    // Log the week to the history tab. This is the moment it is processed, so
    // it is the figure worth keeping — SD3 can settle numbers days later, and a
    // rebuild would then no longer match what was actually sent. A logging
    // failure must never cost the office their file, so it only warns.
    try {
      const t = result.totals
      const row: Record<string, any> = {
        weekEnd: result.weekEnd, weekStart: result.weekStart, payDate: result.payDate,
        fileName: result.upload.fileName,
        employees: t.employees, salons: result.meta.salonsInReport.length,
        paidHours: t.paidHours, grossPay: t.grossPay, tips: t.tips,
        overtimePay: t.overtimePay, overtimeDelta: t.overtimeDelta,
        sixDayDelta: t.sixDayDelta, sixDaySd3Paid: t.sixDaySd3Paid,
        breakMinutes: t.breakMinutes, extraEarnings: t.extraEarnings,
        exceptions: result.exceptions.length,
        forced: force && blocking.length > 0 ? 'true' : 'false',
        downloadedAt: new Date().toISOString(), downloadedBy: gate.email,
      }
      // upsertSheet (not append) so a brand-new tab gets its header row; the
      // key is week + timestamp, so every download is its own entry.
      await upsertSheet(ADP_HISTORY_TAB, [...HISTORY_COLUMNS], ['weekEnd', 'downloadedAt'], [row])
    } catch (e) {
      console.warn('[office/payroll/export] history log failed:',
        e instanceof Error ? e.message : e)
    }

    // Excel opens a BOM-prefixed CSV as UTF-8 without mangling names.
    return new NextResponse('﻿' + result.upload.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${result.upload.fileName}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[office/payroll/export]', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
