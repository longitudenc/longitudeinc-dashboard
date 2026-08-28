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
import { sendAlert } from '@/lib/alert'

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
    if (!r.sent) {
      await sendAlert(
        '[Longitude] Payroll pace did NOT send',
        `<p>sendPayrollPace returned sent=false (salons=${r.count}). Check that PAYROLL_PACE_EMAIL is set and that there is week-to-date data.</p>`
      )
      // Report FAILURE, not success. This used to answer ok:true, so a run in
      // which nobody was emailed still went green -- and sendAlert above is no
      // help when it is ALERT_EMAIL that is missing. The nightly workflow keys
      // on "ok":false, so this now turns the run red.
      return NextResponse.json({
        ...r,
        ok: false,
        error: r.count === 0
          ? 'No week-to-date salon data to report on.'
          : 'Built the report but sent nothing — PAYROLL_PACE_EMAIL (or RESEND_API_KEY) is not set in Vercel.',
      })
    }
    return NextResponse.json({ ok: true, ...r })
  } catch (e: any) {
    await sendAlert('[Longitude] Payroll pace FAILED', `<p>${String(e?.message || e)}</p>`)
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
