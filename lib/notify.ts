// lib/notify.ts
//
// FORMS-NOTIFY-v1
//
// Resolve a form's `notify` tags to real email addresses and send Resend
// notifications on new requests and new comments. Best-effort by design: a
// send failure must NEVER block a submission or a comment — callers wrap these
// in try/catch, and send() also swallows its own errors.

import { Resend } from 'resend'
import { getUsers, getSalonRoster, getAreaManagers, getEmployeeProfiles } from './sheets'

const FROM = 'Longitude Dashboard <noreply@mail.longitudenc.com>'
const DASH_URL = 'https://www.longitudenc.com'
const norm = (s: unknown) => String(s ?? '').trim()
const lower = (s: unknown) => norm(s).toLowerCase()

function pick(row: any, ...names: string[]) {
  for (const n of names) for (const k of Object.keys(row)) {
    if (k.trim().toLowerCase() === n.toLowerCase()) return row[k]
  }
  return ''
}
function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>]/g, c => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]))
}

// notify tags → emails. Tags understood: 'am' (the salon's area manager),
// 'office', 'maintenance', 'owner' (owner+admins), plus any literal email.
export async function resolveNotifyEmails(notify: string[], salonNum: string): Promise<string[]> {
  const tags = (notify || []).map(norm).filter(Boolean)
  if (!tags.length) return []
  const lc = tags.map(lower)
  const out = new Set<string>()

  for (const t of tags) if (t.includes('@')) out.add(lower(t))

  const wantOffice = lc.includes('office')
  const wantMaint = lc.includes('maintenance')
  const wantOwner = lc.includes('owner')
  if (wantOffice || wantMaint || wantOwner) {
    for (const u of await getUsers()) {
      const email = lower(pick(u, 'email', 'e-mail', 'emailaddress', 'email address'))
      const role = lower(pick(u, 'role', 'access', 'tier'))
      if (!email) continue
      if (wantOffice && role === 'office') out.add(email)
      if (wantMaint && role === 'maintenance') out.add(email)
      if (wantOwner && (role === 'owner' || role === 'admin')) out.add(email)
    }
  }

  // am → the salon's AM → their email (roster.am is the AreaManagers key; that
  // row's globalId maps to an EmployeeProfile email — same chain auth uses).
  if (lc.includes('am') && norm(salonNum)) {
    const [roster, ams, profiles] = await Promise.all([
      getSalonRoster(), getAreaManagers(), getEmployeeProfiles(),
    ])
    const rrow = roster.find((r: any) => norm(r.salonNum) === norm(salonNum))
    const amKey = rrow ? lower(rrow.am) : ''
    if (amKey) {
      const am = ams.find((a: any) => lower(a.amKey || a.key) === amKey || lower(a.name) === amKey)
      const gid = am ? norm(am.globalId) : ''
      if (gid) {
        const prof = profiles.find((p: any) => norm(p.globalId) === gid)
        const e = prof ? lower(prof.email) : ''
        if (e) out.add(e)
      }
    }
  }

  return [...out]
}

async function send(to: string[], subject: string, heading: string, lines: string[], link?: string) {
  const recipients = [...new Set(to.map(lower).filter(Boolean))]
  if (!recipients.length || !process.env.RESEND_API_KEY) return
  const body = lines.filter(Boolean).map(l => `<p style="margin:0 0 8px;font-size:14px;color:#222;">${l}</p>`).join('')
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;">
    <h2 style="font-size:16px;margin:0 0 12px;">${esc(heading)}</h2>
    ${body}
    <p style="margin:18px 0 0;"><a href="${link || DASH_URL}" style="background:#0a7;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px;display:inline-block;">Open this request</a></p>
  </div>`
  try {
    const resend = new Resend(process.env.RESEND_API_KEY)
    await resend.emails.send({ from: FROM, to: recipients, subject, html })
  } catch (e: any) {
    console.error('[notify] send failed:', e?.message)
  }
}

export async function notifyNewSubmission(o: {
  submissionId: string; notify: string[]; salonNum: string; formTitle: string; summary: string
  submitterName: string; submitterEmail: string
}) {
  const to = (await resolveNotifyEmails(o.notify, o.salonNum)).filter(e => e !== lower(o.submitterEmail))
  await send(
    to,
    `New ${o.formTitle}${o.salonNum ? ` — Salon ${o.salonNum}` : ''}`,
    `New ${o.formTitle}`,
    [
      o.salonNum ? `<strong>Salon:</strong> ${esc(o.salonNum)}` : '',
      `<strong>From:</strong> ${esc(o.submitterName || o.submitterEmail)}`,
      o.summary ? esc(o.summary) : '',
    ],
    `${DASH_URL}/?req=${encodeURIComponent(o.submissionId)}`
  )
}

// A new comment notifies the form's recipients AND the original submitter (so
// they hear about a reply), minus whoever wrote the comment.
export async function notifyNewComment(o: {
  submissionId: string; notify: string[]; salonNum: string; formTitle: string; body: string
  authorName: string; authorEmail: string; submitterEmail: string
}) {
  const base = await resolveNotifyEmails(o.notify, o.salonNum)
  const to = [...new Set([...base, lower(o.submitterEmail)])].filter(e => e && e !== lower(o.authorEmail))
  await send(
    to,
    `New comment on ${o.formTitle}${o.salonNum ? ` — Salon ${o.salonNum}` : ''}`,
    `${o.authorName || 'Someone'} commented`,
    [
      o.salonNum ? `<strong>Salon:</strong> ${esc(o.salonNum)}` : '',
      `<strong>${esc(o.authorName || o.authorEmail)}:</strong> ${esc(o.body)}`,
    ],
    `${DASH_URL}/?req=${encodeURIComponent(o.submissionId)}`
  )
}
