// app/api/scrape/nr-recon/route.ts
//
// DIAGNOSTIC (one-off, read-only — writes nothing).
//
// For each salon, runs a SINGLE grouped query over the WHOLE period and reports
// NR/RR from that period-level cohort. This is how SD3's Manager Bonus report
// computes per-salon NR/RR. Comparing these numbers against (a) the report and
// (b) the dashboard's weekly-cohort SUM tells us whether the dashboard should
// source NR/RR from a period cohort instead of summing weekly cohorts.
//
//   ?secret=...                 required (or Bearer header)
//   ?start=YYYY-MM-DD           default 2025-12-27 (week 1 start)
//   ?end=YYYY-MM-DD             default 2026-06-19 (week 25 end — matches report)
//
// RUN LOCALLY (`npm run dev`). ~18 sequential SD3 calls, a few seconds.

import { NextResponse } from 'next/server'
import { authenticate, fetchSalons, fetchGroupedSummary } from '@/lib/sd3'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isNaN(n) ? 0 : n
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const start = url.searchParams.get('start') || '2025-12-27'
  const end = url.searchParams.get('end') || '2026-06-19'

  const session = await authenticate()
  const salons = await fetchSalons(session)

  let CnR = 0, CnV = 0, CrR = 0, CrV = 0
  const rows: any[] = []

  for (const s of salons) {
    try {
      const g = await fetchGroupedSummary(session, s.storeId, start, end)
      if (!g) { rows.push({ salonNum: s.salonNum, error: 'no data' }); continue }
      const nrR = num(g.newCustomerReturnCount), nrV = num(g.newCustomerVisitCount)
      const rrR = num(g.repeatCustomerReturnCount), rrV = num(g.repeatCustomerVisitCount)
      CnR += nrR; CnV += nrV; CrR += rrR; CrV += rrV
      rows.push({
        salonNum: s.salonNum,
        nr: nrV ? +(nrR / nrV * 100).toFixed(1) : null, nrReturn: nrR, nrVisit: nrV,
        rr: rrV ? +(rrR / rrV * 100).toFixed(1) : null, rrReturn: rrR, rrVisit: rrV,
      })
    } catch (e: any) {
      rows.push({ salonNum: s.salonNum, error: e?.message || String(e) })
    }
  }

  rows.sort((a, b) => String(a.salonNum).localeCompare(String(b.salonNum)))

  return NextResponse.json({
    ok: true,
    range: { start, end },
    salons: rows.length,
    companyNR_periodCohort: CnV ? +(CnR / CnV * 100).toFixed(2) : null,
    companyRR_periodCohort: CrV ? +(CrR / CrV * 100).toFixed(2) : null,
    note: 'compare nr/rr here vs report per-salon and vs dashboard weekly-sum',
    rows,
  })
}
