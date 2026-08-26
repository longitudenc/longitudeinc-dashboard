// app/api/cron/weekly/route.ts
//
// The WEEKLY finalizer, split out of /api/cron/run so it gets its own clean 60s
// on Vercel Hobby and can never be starved by the daily scrapes. Runs the salon
// weekly summary FIRST (that's what feeds the scorecard + Company Avg CC), then
// the weekly-cadence entities.
//
// Triggered by a dedicated Saturday Vercel cron (see vercel.json), and also
// self-invoked by /api/cron/run as a catch-up if a Saturday run was ever missed.
// Callable manually: /api/cron/weekly?secret=…

import { NextResponse } from 'next/server'
import { sendAlert } from '@/lib/alert'
import {
  runWeeklyScrape,
  runRosterScrape,
  runEmployeeScrape,
  runEmployeeWeeklyConsolidatedScrape,
  runPayrollScrape,
} from '@/lib/scrape-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const bearer = request.headers.get('authorization') || ''
  if (bearer === `Bearer ${secret}`) return true // Vercel cron sends this header
  const url = new URL(request.url)
  return url.searchParams.get('secret') === secret // manual / self-invoke
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const results: { name: string; result: any }[] = []
  // Salon weekly FIRST — feeds the scorecard and Company Avg CC. With the whole
  // 60s to itself, this lands reliably; the slower weekly-cadence entities follow.
  results.push({ name: 'weekly', result: await runWeeklyScrape() })
  results.push({ name: 'roster', result: await runRosterScrape() })
  results.push({ name: 'employee', result: await runEmployeeScrape() })
  results.push({ name: 'employee-weekly-cons', result: await runEmployeeWeeklyConsolidatedScrape() })
  results.push({ name: 'payroll', result: await runPayrollScrape() })

  const allOk = results.every(r => r.result?.ok)
  console.log(`[cron/weekly] ${results.map(r => `${r.name}:${r.result?.ok ? 'ok' : 'FAIL'}`).join(' ')}`)
  if (!allOk) {
    const failed = results.filter(r => !r.result?.ok).map(r => `${r.name}: ${r.result?.error || 'failed'}`).join('<br>')
    await sendAlert('[Longitude] Weekly finalizer \u2717 — a scrape failed', `<p>The Saturday weekly run had failures:</p><p>${failed}</p>`)
  }
  return NextResponse.json({ ok: allOk, results })
}
