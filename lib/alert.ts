// lib/alert.ts
// Best-effort operational alerting. NOTHING here may throw into a caller — a
// failed alert must never break a scrape or a cron run.
//
// It no longer fails MUTELY, though. sendAlert returns what happened, because a
// broken alerting path looks exactly like "nothing was wrong" and is therefore
// worse than having no alerts at all. Callers may ignore the result and behave
// exactly as before.

import { Resend } from 'resend'

const FROM = process.env.ALERT_FROM || 'Longitude Dashboard <noreply@mail.longitudenc.com>'

function recipients(): string[] {
  return (process.env.ALERT_EMAIL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export type AlertResult = { sent: boolean; reason?: string; recipients?: number; from?: string; to?: string[] }

/**
 * Local part masked, domain kept. Enough to spot a typo'd or wrong-domain
 * recipient from the health endpoint without printing anybody's address in
 * full. A malformed value reports its shape rather than its content.
 */
function maskEmail(e: string): string {
  const at = e.indexOf('@')
  if (at < 1) return '(malformed: ' + e.length + ' chars, no @)'
  return e.slice(0, Math.min(2, at)) + '***' + e.slice(at)
}

/** Email an operational alert. Never throws; reports why it did not send. */
export async function sendAlert(subject: string, html: string): Promise<AlertResult> {
  try {
    const to = recipients()
    if (!process.env.RESEND_API_KEY) {
      console.warn('[alert] skipped: RESEND_API_KEY not set')
      return { sent: false, reason: 'RESEND_API_KEY is not set' }
    }
    if (to.length === 0) {
      console.warn('[alert] skipped: ALERT_EMAIL not set')
      return { sent: false, reason: 'ALERT_EMAIL is not set, or not visible to this deployment' }
    }
    const resend = new Resend(process.env.RESEND_API_KEY)
    const res: any = await resend.emails.send({ from: FROM, to, subject, html })
    // Resend RESOLVES with { data, error } rather than rejecting, so an
    // unverified sender domain or a bad key would otherwise vanish here.
    if (res && res.error) {
      const reason = String(res.error.message || res.error.name || JSON.stringify(res.error))
      console.error('[alert] rejected by Resend:', reason)
      return { sent: false, reason, recipients: to.length, from: FROM, to: to.map(maskEmail) }
    }
    console.log(`[alert] sent: ${subject}`)
    return { sent: true, recipients: to.length, from: FROM, to: to.map(maskEmail) }
  } catch (e: any) {
    const reason = String(e?.message || e)
    console.error('[alert] send failed:', reason)
    return { sent: false, reason }
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
