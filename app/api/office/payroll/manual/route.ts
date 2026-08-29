// app/api/office/payroll/manual/route.ts
//
// Hand-keyed earnings for a week — the lines that have no source in SD3:
// referral and sign-on bonuses, guarantees, manager cell, tuition, retro pay.
//
// These are the two spare "Earnings 4" columns the macro workbook left blank
// for the office to fill in by hand. Here they're stored per week in ADP_MANUAL
// so a re-run of the upload keeps them, and so there's a record of what was
// added and by whom.
//
//   GET  ?weekEnd=YYYY-MM-DD          lines saved for that week
//   POST { weekEnd, lines: [...] }    replace that week's lines wholesale

import { NextResponse } from 'next/server'
import { requireOffice } from '@/lib/require-role'
import { readSheet, rowsToObjects, writeSheet } from '@/lib/sheets'
import { loadManualLines } from '@/lib/adp-run'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ADP_MANUAL_TAB = 'ADP_MANUAL'
// otEligible: does this line count toward the week's overtime rate? A referral
// bonus does (nondiscretionary pay for the week); a reimbursement or a
// guarantee does not. Stored per line so the decision is recorded, not guessed.
const COLUMNS = ['id', 'weekEnd', 'payId', 'salonNum', 'code', 'amount', 'label', 'otEligible', 'updatedAt', 'updatedBy']

const isWeekEnd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export async function GET(request: Request) {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response

  const weekEnd = new URL(request.url).searchParams.get('weekEnd') || ''
  if (!isWeekEnd(weekEnd)) {
    return NextResponse.json({ success: false, error: 'weekEnd must be YYYY-MM-DD' }, { status: 400 })
  }

  try {
    return NextResponse.json({ success: true, weekEnd, lines: await loadManualLines(weekEnd) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }

  const weekEnd = String(body.weekEnd || '').trim()
  if (!isWeekEnd(weekEnd)) {
    return NextResponse.json({ success: false, error: 'weekEnd must be YYYY-MM-DD' }, { status: 400 })
  }
  if (!Array.isArray(body.lines)) {
    return NextResponse.json({ success: false, error: 'lines must be an array' }, { status: 400 })
  }

  try {
    // Read every week, rewrite the tab with this week's lines replaced. The tab
    // is small (a handful of lines per week) so a whole-tab rewrite is simpler
    // and safer than a keyed upsert against rows the office may have deleted.
    // Read FRESH: this is a read-modify-write, and the 15s read cache would let
    // two people saving different weeks inside the same window clobber each other.
    let others: Record<string, any>[] = []
    try {
      others = rowsToObjects(await readSheet(ADP_MANUAL_TAB, undefined, { fresh: true }))
        .filter(r => String(r.weekEnd || '').trim() !== weekEnd)
    } catch {
      others = []
    }

    const now = new Date().toISOString()
    const kept = others.map(r => COLUMNS.map(c => r[c] ?? ''))
    const added = body.lines
      .map((l: any, i: number) => ({
        id: String(l.id || `${weekEnd}-${i}-${Math.random().toString(36).slice(2, 8)}`),
        weekEnd,
        payId: String(l.payId ?? '').trim(),
        salonNum: String(l.salonNum ?? '').trim(),
        code: String(l.code ?? '').trim(),
        amount: Number(l.amount) || 0,
        label: String(l.label ?? '').trim() || 'Manual earning',
        otEligible: l.otEligible ? 'true' : 'false',
        updatedAt: now,
        updatedBy: gate.email,
      }))
      .filter((l: any) => l.payId && l.amount !== 0)
      .map((l: any) => COLUMNS.map(c => l[c]))

    await writeSheet(ADP_MANUAL_TAB, [COLUMNS, ...kept, ...added])

    console.log(`[office/payroll/manual] ${gate.email} saved ${added.length} line(s) for ${weekEnd}`)
    return NextResponse.json({ success: true, weekEnd, saved: added.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[office/payroll/manual]', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
