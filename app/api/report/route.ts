// app/api/report/payroll-pace/route.ts
//
// Manual trigger + preview for the weekly payroll-pace report. Auth via
// CRON_SECRET (same as the other internal routes). The scheduled send runs
// automatically from the daily cron on Wednesdays; this is for testing.
//
//   /api/report/payroll-pace?secret=…            → build + email
//   /api/report/payroll-pace?secret=…&preview=1  → build + return JSON (no email)
//   /api/report/payroll-pace?secret=…&asOf=YYYY-MM-DD  → pretend it's that date

import { NextResponse } from 'next/server'
import { buildPayrollPace, sendPayrollPace } from '@/lib/payroll-pace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (url.searchParams.get('secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const asOf = url.searchParams.get('asOf') || undefined
  try {
    if (url.searchParams.get('preview') === '1') {
      const data = await buildPayrollPace(asOf)
      return NextResponse.json({ ok: true, ...data })
    }
    const r = await sendPayrollPace(asOf)
    return NextResponse.json({ ok: true, ...r })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
