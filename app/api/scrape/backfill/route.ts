// app/api/scrape/backfill/route.ts
//
// ONE-TIME historical backfill for salon weekly + employee + payroll.
//
// Loops every Sat→Fri fiscal week in [start, end] and runs the SAME tested
// runners the live cron uses (runWeeklyScrape / runEmployeeScrape /
// runPayrollScrape), one week at a time. Reusing those runners means the rows
// it writes are identical in shape to live data — no drift — and it's fully
// idempotent (re-run any range safely; existing rows update in place).
//
// RUN LOCALLY ONLY (`npm run dev`). A multi-year backfill takes 20+ minutes,
// which exceeds Vercel's serverless timeout — a local dev route has no cap.
// It writes straight to the same Google Sheet.
//
// Query params (all optional except secret):
//   ?secret=...                              required (or Bearer header)
//   ?start=YYYY-MM-DD                        default 2024-01-06
//   ?end=YYYY-MM-DD                          default today
//   ?type=all|salon|employee|payroll|both    default all
//                                            (all = salon+employee+payroll;
//                                             both = employee+payroll)
//   ?delay=<ms>                              pause between weeks (default 300)
//
// Note: salon weekly fills SD_WEEKLY (what getAllData reads for LY), so pulling
// a prior year here is what lets the following year show year-over-year.
// Scope: uses the salons currently in SD3's list (live runner behavior), so a
// sold salon's pre-sale history is not included — intentional.

import { NextResponse } from 'next/server'
import { runWeeklyScrape, runEmployeeScrape, runPayrollScrape } from '@/lib/scrape-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // honored locally; serverless will cap lower

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Enumerate Sat→Fri weeks. Snaps `start` back to its Saturday, then steps +7
// days until the week start passes `end`.
function fiscalWeeks(startISO: string, endISO: string): { start: string; end: string }[] {
  const d = new Date(startISO + 'T00:00:00Z')
  const daysBackToSat = (d.getUTCDay() - 6 + 7) % 7 // getUTCDay: Sun=0 … Sat=6
  d.setUTCDate(d.getUTCDate() - daysBackToSat)
  const endD = new Date(endISO + 'T00:00:00Z')

  const weeks: { start: string; end: string }[] = []
  while (d <= endD) {
    const wkStart = new Date(d)
    const wkEnd = new Date(d)
    wkEnd.setUTCDate(wkEnd.getUTCDate() + 6)
    weeks.push({ start: isoDate(wkStart), end: isoDate(wkEnd) })
    d.setUTCDate(d.getUTCDate() + 7)
  }
  return weeks
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const start = url.searchParams.get('start') || '2024-01-06'
  const end = url.searchParams.get('end') || isoDate(new Date())
  const type = (url.searchParams.get('type') || 'all').toLowerCase()
  const delayMs = Number(url.searchParams.get('delay') || '300')

  const doSalon = type === 'all' || type === 'salon'
  const doEmp = type === 'all' || type === 'both' || type === 'employee'
  const doPay = type === 'all' || type === 'both' || type === 'payroll'

  const weeks = fiscalWeeks(start, end)
  const startedAt = Date.now()
  const log: any[] = []
  let totalSalon = 0
  let totalEmp = 0
  let totalPay = 0
  let failures = 0

  console.log(`[backfill] ${weeks.length} weeks ${weeks[0]?.start}→${weeks[weeks.length - 1]?.end}, type=${type}`)

  for (const w of weeks) {
    const entry: any = { weekEnd: w.end }

    if (doSalon) {
      const r = await runWeeklyScrape(w.start, w.end)
      const ok = r.ok && (!r.errors || r.errors.length === 0)
      entry.salon = { ok: r.ok, rows: r.rowsUpserted, inserted: r.inserted, updated: r.updated, errors: r.errors }
      if (ok) totalSalon += r.rowsUpserted
      else failures++
    }

    if (doEmp) {
      const r = await runEmployeeScrape(w.start, w.end)
      entry.employee = { ok: r.ok, rows: r.rowsUpserted, inserted: r.inserted, updated: r.updated, skipped: r.skipped, error: r.error }
      if (r.ok) totalEmp += r.rowsUpserted
      else failures++
    }

    if (doPay) {
      const r = await runPayrollScrape(w.start, w.end)
      entry.payroll = { ok: r.ok, rows: r.rowsUpserted, inserted: r.inserted, updated: r.updated, skipped: r.skipped, error: r.error }
      if (r.ok) totalPay += r.rowsUpserted
      else failures++
    }

    log.push(entry)
    console.log(`[backfill] ${w.end} — salon:${entry.salon?.rows ?? '-'} emp:${entry.employee?.rows ?? '-'} pay:${entry.payroll?.rows ?? '-'}`)
    await sleep(delayMs)
  }

  return NextResponse.json({
    ok: failures === 0,
    type,
    weeksProcessed: weeks.length,
    range: { start: weeks[0]?.start, end: weeks[weeks.length - 1]?.end },
    totalSalonRows: totalSalon,
    totalEmployeeRows: totalEmp,
    totalPayrollRows: totalPay,
    failures,
    durationMs: Date.now() - startedAt,
    log,
  })
}
