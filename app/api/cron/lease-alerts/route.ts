// app/api/cron/lease-alerts/route.ts
//
// LEASE-ALERTS-CRON-v1  (Ctrl+F this string to confirm the file saved)
//
// The daily "something is coming" email for the Lease Manager.
//
// It reports three things, and nothing else:
//   • a rent step starting inside the next 35 days
//   • a renewal-option notice deadline inside the next 120 days, or one already
//     missed and still undecided
//   • a lease expiring inside the next 180 days
//
// It sends NOTHING when there is nothing to say. A daily email that is usually
// empty gets filtered into a folder within a fortnight, and then the one that
// matters is filtered too.
//
// The windows overlap deliberately. A rent increase 35 days out is a
// cash-planning item you want once; a notice deadline is the thing that costs
// real money to miss, so it is repeated daily for four months.
//
// Guarded by CRON_SECRET like every other scheduled route: ?secret= or a Bearer
// header. Runs from the nightly GitHub workflow — add one line to
// lib/scrape-plan.ts to schedule it, per the note at the top of that file.

import { NextRequest, NextResponse } from 'next/server'
import { sendAlert } from '@/lib/alert'
import { SALON_NAMES, salonDisplay } from '@/lib/config'
import { listLeases, listOptions, actionItems, todayISO } from '@/lib/lease-records'
import { listSteps, upcomingRentChanges } from '@/lib/lease-money'
import { leaseAlertRecipients, maskEmail } from '@/lib/lease-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const RENT_WINDOW_DAYS = 35
const NOTICE_WINDOW_DAYS = 120
const EXPIRY_WINDOW_DAYS = 180

const money = (n: number) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function fmtDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || ''
  const [y, m, d] = iso.split('-').map(Number)
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${MON[m - 1]} ${d}, ${y}`
}

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const url = new URL(req.url)
  if (url.searchParams.get('secret') === secret) return true
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  }

  try {
    const today = todayISO()
    const [leases, options, steps, who] = await Promise.all([
      listLeases(), listOptions(), listSteps(), leaseAlertRecipients(),
    ])
    const salonNums = Object.keys(SALON_NAMES)

    const rent = upcomingRentChanges(steps, salonNums, today, RENT_WINDOW_DAYS)

    // actionItems() already knows which options are still undecided and which
    // leases are live — reuse it rather than writing the rule twice.
    const acts = actionItems(leases, options, today, 12)
    const notices = acts.filter(a => a.kind === 'notice' && a.daysAway <= NOTICE_WINDOW_DAYS)
    const expiries = acts.filter(a => a.kind === 'expiry' && a.daysAway <= EXPIRY_WINDOW_DAYS)

    // ?dry=1 reports what WOULD be sent, and to whom, without sending.
    const dry = new URL(req.url).searchParams.get('dry') === '1'
    if (dry) {
      return NextResponse.json({
        ok: true, dryRun: true, today,
        recipients: who.recipients.map(maskEmail),
        recipientSource: who.source,
        resendKeySet: !!process.env.RESEND_API_KEY,
        counts: { rent: rent.length, notices: notices.length, expiries: expiries.length },
        rent, notices, expiries,
      })
    }

    if (!rent.length && !notices.length && !expiries.length) {
      return NextResponse.json({ ok: true, sent: false, reason: 'nothing due' })
    }

    const rows: string[] = []
    const section = (title: string) =>
      rows.push(`<tr><td colspan="2" style="padding:16px 0 6px;font:600 12px system-ui;
        text-transform:uppercase;letter-spacing:.06em;color:#6b6b6b;">${title}</td></tr>`)
    const item = (left: string, right: string, colour = '#1a1a1a') =>
      rows.push(`<tr>
        <td style="padding:7px 12px 7px 0;font:14px system-ui;color:${colour};">${left}</td>
        <td style="padding:7px 0;font:600 13px system-ui;white-space:nowrap;text-align:right;">${right}</td>
      </tr>`)

    if (rent.length) {
      section(`Rent changing within ${RENT_WINDOW_DAYS} days`)
      for (const r of rent) {
        item(
          `<b>${salonDisplay(r.salonNum)}</b> — ${money(r.from)} → ${money(r.to)} per month
           (${r.delta > 0 ? '+' : ''}${money(r.delta)}, ${r.delta > 0 ? '+' : ''}${r.pct}%)`,
          `${fmtDate(r.startDate)}<br><span style="font-weight:400;color:#6b6b6b;">in ${r.daysAway} days</span>`,
        )
      }
    }

    if (notices.length) {
      section('Renewal notice deadlines')
      for (const a of notices) {
        const past = a.daysAway < 0
        item(
          `<b>${salonDisplay(a.salonNum)}</b> — ${a.headline}. ${a.detail}`,
          `${fmtDate(a.date)}<br><span style="font-weight:400;color:${past ? '#b3261e' : '#6b6b6b'};">`
          + `${past ? Math.abs(a.daysAway) + ' days ago' : 'in ' + a.daysAway + ' days'}</span>`,
          past ? '#b3261e' : '#1a1a1a',
        )
      }
    }

    if (expiries.length) {
      section('Leases expiring')
      for (const a of expiries) {
        item(
          `<b>${salonDisplay(a.salonNum)}</b> — ${a.detail}`,
          `${fmtDate(a.date)}<br><span style="font-weight:400;color:#6b6b6b;">in ${a.daysAway} days</span>`,
        )
      }
    }

    const html = `
      <div style="max-width:640px;font-family:system-ui,-apple-system,sans-serif;color:#1a1a1a;">
        <h2 style="font-size:17px;color:#03654e;margin:0 0 2px;">Lease Manager — what is coming</h2>
        <div style="font-size:12.5px;color:#6b6b6b;margin-bottom:8px;">${fmtDate(today)}</div>
        <table style="width:100%;border-collapse:collapse;">${rows.join('')}</table>
        <p style="font-size:12px;color:#999;margin-top:20px;line-height:1.6;">
          Sent only when something is due, so an empty inbox means nothing is.
          Figures come from the recorded rent schedules and renewal options — a salon
          with no schedule recorded cannot appear here, and the Lease Manager's
          &ldquo;Missing information&rdquo; panel lists those.
        </p>
      </div>`

    const sent = await sendAlert('Lease Manager — what is coming', html, who.recipients)
    // Report WHO it went to (local part masked) and the sender. Asking
    // "where does this email go" should not mean reading env vars in a
    // dashboard — hitting this URL answers it.
    return NextResponse.json({
      ok: true,
      sent: sent.sent,
      reason: sent.reason,
      from: sent.from,
      to: sent.to,
      recipientSource: who.source,
      counts: { rent: rent.length, notices: notices.length, expiries: expiries.length },
    })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
