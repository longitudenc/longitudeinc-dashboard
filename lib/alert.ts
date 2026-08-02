// lib/alert.ts
// Best-effort operational alerting. NOTHING here may throw into a caller — a
// failed alert must never break a scrape or a cron run. Both functions no-op
// silently if their env vars are unset, so the app runs fine before setup.

import { Resend } from 'resend'

const FROM = process.env.ALERT_FROM || 'Longitude Dashboard <noreply@mail.longitudenc.com>'

function recipients(): string[] {
  return (process.env.ALERT_EMAIL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/** Email an operational alert. No-op if RESEND_API_KEY or ALERT_EMAIL is unset. */
export async function sendAlert(subject: string, html: string): Promise<void> {
  try {
    const to = recipients()
    if (!process.env.RESEND_API_KEY || to.length === 0) {
      console.warn('[alert] skipped — RESEND_API_KEY or ALERT_EMAIL not set')
      return
    }
    const resend = new Resend(process.env.RESEND_API_KEY)
    await resend.emails.send({ from: FROM, to, subject, html })
    console.log(`[alert] sent: ${subject}`)
  } catch (e) {
    console.error('[alert] send failed:', e)
  }
}

/**
 * Dead-man's switch. Pings an external monitor (e.g. a free Healthchecks.io
 * check) so that a cron which NEVER RUNS is still detected — the one failure
 * mode in-app code can't catch, and exactly what happened on the missed
 * Saturday. On success pings the base URL; on failure pings <base>/fail so the
 * monitor can tell "ran but broke" from "never ran". No-op if unset.
 */
export async function heartbeat(ok: boolean): Promise<void> {
  try {
    const base = process.env.CRON_HEARTBEAT_URL
    if (!base) return
    const url = ok ? base : base.replace(/\/+$/, '') + '/fail'
    await fetch(url, { method: 'POST' })
  } catch (e) {
    console.error('[alert] heartbeat failed:', e)
  }
}
