// app/api/facility/greenflag/route.ts
//
// FACILITY-GREENFLAG-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   POST { requestId: 'gf_…', salonNum, itemIds[], photoIds[], note? }
//     -> { success, sentTo, cc, items, photos }
//
// Ask Great Clips for a green flag: one email to the address every facility
// review names — "Email a photo of the fixed items with a short message
// including your salon number to: GF@greatclips.com" — with the fixed items
// listed and the photos attached, copied to the owner and to whoever sent it.
//
// The photos are uploaded first (/api/facility/photo, one per request, each
// shrunk in the browser), then named here by id. Only the ids the sender still
// had in the dialog are attached, so a photo removed before sending is not sent.
//
// ITEMS ONLY MOVE WHEN THE EMAIL WENT. Statuses change to "green flag
// requested" after Resend accepts the message, never before — a failed send
// must not leave the tracker claiming a request that Great Clips never got.
//
// Sent from the dashboard's own address with Reply-To set to the sender, so
// Great Clips' answer reaches a person rather than a no-reply mailbox.

import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { get } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'
import { canSeeSalon } from '@/lib/scope-filter'
import { getUsers } from '@/lib/sheets'
import {
  listFacility, listPhotos, updateItem, addComment, saveGreenFlag, OPEN_STATUSES,
} from '@/lib/facility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FROM = 'Longitude Dashboard <noreply@mail.longitudenc.com>'
/** Where the review emails themselves say green-flag photos go. */
const GREEN_FLAG_TO = 'GF@greatclips.com'
/** Well inside what a mail server accepts once the attachments are encoded. */
const MAX_ATTACH_BYTES = 25 * 1024 * 1024

const S = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max)
const lower = (v: unknown) => S(v, 300).toLowerCase()
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, c =>
  (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]))
function pick(row: any, ...names: string[]) {
  for (const n of names) for (const k of Object.keys(row || {})) {
    if (k.trim().toLowerCase() === n.toLowerCase()) return row[k]
  }
  return ''
}
function usDate(iso: string) {
  const m = S(iso, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : S(iso, 10)
}

export async function POST(req: Request) {
  const gate = await requireCapability('edit.facility')
  if (!gate.ok) return gate.response

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }
  const requestId = S(body?.requestId, 60)
  const salonNum = S(body?.salonNum, 10)
  const note = S(body?.note, 2000)
  const wantItems = new Set((Array.isArray(body?.itemIds) ? body.itemIds : []).map((x: unknown) => S(x, 60)).filter(Boolean))
  const wantPhotos = new Set((Array.isArray(body?.photoIds) ? body.photoIds : []).map((x: unknown) => S(x, 60)).filter(Boolean))

  if (!/^gf_[a-z0-9]{8,40}$/.test(requestId)) {
    return NextResponse.json({ success: false, error: 'bad request id' }, { status: 400 })
  }
  if (!canSeeSalon(gate.access, salonNum)) {
    return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ success: false, error: 'Email is not set up on this site (RESEND_API_KEY).' }, { status: 500 })
  }

  try {
    const items = (await listFacility(true)).filter(i =>
      i.salonNum === salonNum && wantItems.has(i.itemId) && OPEN_STATUSES.has(i.status))
    if (!items.length) {
      return NextResponse.json({ success: false, error: 'None of the ticked items are still open at this salon.' }, { status: 400 })
    }
    const photos = (await listPhotos(true)).filter(p =>
      p.reviewId === requestId && p.salonNum === salonNum && wantPhotos.has(p.photoId))
    if (!photos.length) {
      return NextResponse.json({ success: false, error: 'Add at least one photo of the fixes.' }, { status: 400 })
    }

    // ── the photos, as attachments ──
    const attachments: { filename: string; content: Buffer }[] = []
    let total = 0
    for (let n = 0; n < photos.length; n++) {
      const p = photos[n]
      const got = await get(p.pathname, { access: 'private' })
      if (!got || !got.stream) continue
      const buf = Buffer.from(await new Response(got.stream as any).arrayBuffer())
      total += buf.length
      if (total > MAX_ATTACH_BYTES) {
        return NextResponse.json({ success: false, error:
          'Those photos add up to more than an email can carry. Send fewer at a time.' }, { status: 400 })
      }
      const ext = /\.(jpe?g|png|webp)$/i.test(p.fileName) ? '' : '.jpg'
      attachments.push({
        filename: `${salonNum}-photo-${n + 1}-${p.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}${ext}`,
        content: buf,
      })
    }

    // ── who is copied: the owner, and whoever pressed send ──
    const owners = (await getUsers())
      .filter(u => lower(pick(u, 'role', 'access', 'tier')) === 'owner')
      .map(u => lower(pick(u, 'email', 'e-mail', 'emailaddress', 'email address')))
      .filter(e => e.includes('@'))
    const sender = lower(gate.email)
    const cc = [...new Set([...owners, sender])].filter(e => e && e !== GREEN_FLAG_TO.toLowerCase())

    // ── the message ──
    const salonName = items.find(i => i.salonName)?.salonName || ''
    const reviewDates = [...new Set(items.map(i => i.reviewDate).filter(Boolean))].sort()
    const crit = items.filter(i => i.category === 'critical')
    const act = items.filter(i => i.category !== 'critical')
    const lines = (d: string) => S(d, 4000).split('\n').map(l => l.trim()).filter(Boolean)
    const htmlList = (list: typeof items) => '<ul style="margin:6px 0 14px;padding-left:20px;">'
      + list.map(i => `<li style="margin:6px 0;"><b>${esc(i.component)}</b>`
        + (lines(i.detail).length > 1
            ? '<ul style="margin:3px 0 0;padding-left:18px;">' + lines(i.detail).map(l => `<li>${esc(l)}</li>`).join('') + '</ul>'
            : ` &mdash; ${esc(lines(i.detail)[0] || '')}`)
        + '</li>').join('') + '</ul>'
    const subject = `Green Flag Request - Salon ${salonNum}${salonName ? ' - ' + salonName : ''}`
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5;">`
      + `<p>Hello,</p>`
      + `<p>Salon <b>${esc(salonNum)}${salonName ? ' &ndash; ' + esc(salonName) : ''}</b> is requesting a green flag. `
      + `The items below${reviewDates.length ? ' from the facility review of ' + reviewDates.map(usDate).join(', ') : ''} `
      + `have been corrected, and ${attachments.length} photo${attachments.length === 1 ? ' is' : 's are'} attached.</p>`
      + (crit.length ? `<p style="margin:14px 0 0;"><b>Critical Brand Elements</b></p>${htmlList(crit)}` : '')
      + (act.length ? `<p style="margin:14px 0 0;"><b>Salon Component Items</b></p>${htmlList(act)}` : '')
      + (note ? `<p style="margin:14px 0;padding:10px 12px;background:#f5f7f6;border-left:3px solid #048667;">${esc(note).replace(/\n/g, '<br>')}</p>` : '')
      + `<p>Thank you,<br>${esc(gate.email)}<br>Longitude Inc &mdash; Great Clips salon ${esc(salonNum)}</p>`
      + `</div>`
    const text = `Hello,\n\nSalon ${salonNum}${salonName ? ' - ' + salonName : ''} is requesting a green flag. `
      + `The items below${reviewDates.length ? ' from the facility review of ' + reviewDates.map(usDate).join(', ') : ''} `
      + `have been corrected; ${attachments.length} photo(s) attached.\n\n`
      + (crit.length ? 'Critical Brand Elements\n' + crit.map(i => `- ${i.component}: ${lines(i.detail).join('; ')}`).join('\n') + '\n\n' : '')
      + (act.length ? 'Salon Component Items\n' + act.map(i => `- ${i.component}: ${lines(i.detail).join('; ')}`).join('\n') + '\n\n' : '')
      + (note ? note + '\n\n' : '')
      + `Thank you,\n${gate.email}\nLongitude Inc - Great Clips salon ${salonNum}\n`

    const resend = new Resend(process.env.RESEND_API_KEY)
    const sent: any = await resend.emails.send({
      from: FROM,
      to: [GREEN_FLAG_TO],
      cc,
      replyTo: sender || undefined,
      subject,
      html,
      text,
      attachments,
    })
    if (sent?.error) {
      return NextResponse.json({ success: false, error:
        'The email was not sent: ' + S(sent.error.message || sent.error, 300) }, { status: 502 })
    }

    // ── only now: move the items, and say so on each ──
    const when = new Date().toISOString()
    for (const it of items) {
      try { await updateItem(it.itemId, { status: 'greenflag_requested' }, gate.email) } catch { /* shown on reload */ }
      try {
        await addComment({
          itemId: it.itemId, author: gate.email,
          authorRole: String((gate.access as any)?.role || ''),
          body: `Green flag requested — emailed to ${GREEN_FLAG_TO} with ${attachments.length} photo`
            + `${attachments.length === 1 ? '' : 's'}${note ? `. Note: ${note}` : ''}`,
        })
      } catch { /* the request stands without the comment */ }
    }
    try {
      await saveGreenFlag({
        requestId, salonNum, itemIds: items.map(i => i.itemId), photoIds: photos.map(p => p.photoId),
        sentTo: GREEN_FLAG_TO, cc: cc.join(', '), note, sentAt: when, sentBy: gate.email,
      })
    } catch { /* the email went; a missing log row is a smaller problem than a failed request */ }

    return NextResponse.json({
      success: true, sentTo: GREEN_FLAG_TO, cc, items: items.length, photos: attachments.length,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
