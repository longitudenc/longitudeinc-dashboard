// app/api/facility/ingest/route.ts
//
// FACILITY-INGEST-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   POST multipart  file=<the .msg or .eml dropped on the page>
//   POST { html } | { text }        a pasted email body
//     -> { success, parsed }
//
// Read a facility review and PROPOSE its items. Writes nothing: the parse is
// shown, checked and accepted on /api/facility, the same way a lease
// reconciliation is. A generated email is regular enough to parse reliably and
// not regular enough to trust with the estate's repair list unattended.
//
// The bytes come here rather than being read in the browser because a .msg is a
// compound file — a small filesystem — and following its allocation table is a
// server's job. They are small: this sample is 178 KB, well inside a request.

import { NextResponse } from 'next/server'
import { put, get, del } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'
import { isMsg, readMsg, type MsgAttachment } from '@/lib/msg-reader'
import { parseFacilityReview } from '@/lib/facility-parse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// A serverless request body is capped at 4.5 MB by the platform. A review email
// with a dozen photos runs 3–4 MB, so this sits under the cap to turn an opaque
// 413 from the edge into a sentence from us.
const MAX_BYTES = 4 * 1024 * 1024

const IMAGE = /^image\//i

/**
 * Keep the email and its photos, not just the reading of them.
 *
 * A review lands about every nine months. By the next one nobody remembers
 * whether the sail was replaced or argued about, and the green-flag request
 * needs the original to quote. The .msg goes in whole; each photo goes in
 * separately so it can be shown against an item.
 */
async function stash(salonNum: string, reviewDate: string, file: Buffer, name: string,
                     attachments: MsgAttachment[]) {
  const base = `facility/${salonNum || 'unfiled'}/${reviewDate || 'undated'}/${Date.now().toString(36)}`
  const safe = (s: string) => String(s || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)

  const saved: any = { msgPathname: '', photos: [] as any[], failed: 0 }
  try {
    const b = await put(`${base}/${safe(name || 'review.msg')}`, file, {
      access: 'private', contentType: 'application/vnd.ms-outlook', addRandomSuffix: false,
    })
    saved.msgPathname = b.pathname
  } catch { saved.failed++ }

  for (const a of attachments) {
    // Signature logos and other message furniture are not evidence. A real
    // repair photo off a phone is hundreds of KB; the Outlook logo in this
    // sample is 5 KB, which is the line.
    if (!IMAGE.test(a.mimeType || '') && !/\.(jpe?g|png|heic|webp)$/i.test(a.fileName)) continue
    if (a.size < 20000) continue
    try {
      const b = await put(`${base}/${safe(a.fileName)}`, a.data, {
        access: 'private', contentType: a.mimeType || 'image/jpeg', addRandomSuffix: false,
      })
      saved.photos.push({
        fileName: a.fileName, pathname: b.pathname,
        contentType: a.mimeType || 'image/jpeg', size: a.size,
      })
    } catch { saved.failed++ }
  }
  return saved
}

export async function POST(req: Request) {
  const gate = await requireCapability('edit.facility')
  if (!gate.ok) return gate.response

  try {
    const type = req.headers.get('content-type') || ''

    // One reading of a file, however it arrived — whole in a form post, or in
    // pieces reassembled from the store.
    const handleFile = async (buf: Buffer, name: string) => {
      if (isMsg(buf)) {
        const msg = readMsg(buf)
        const parsed = parseFacilityReview({ html: msg.html, text: msg.text, subject: msg.subject })
        // Only a review is worth keeping. An ordinary email dropped by mistake
        // used to be filed under facility/unfiled/ with nothing ever pointing
        // at it again; now it is read, refused, and not stored.
        const kept = parsed.ok
          ? await stash(parsed.salonNum, parsed.reviewDate, buf, name, msg.attachments)
          : { msgPathname: '', photos: [], failed: 0 }
        // Photos come back attached to the REVIEW, never guessed onto items:
        // in the sample they are ordinary attachments with camera-serial names
        // and the body carries one cid, for a signature logo. Nothing in the
        // message says which photo is the front desk.
        return {
          success: true, parsed, source: name, subject: msg.subject,
          msgPathname: kept.msgPathname, photos: kept.photos,
          attachmentsSeen: msg.attachments.length,
          storeFailed: kept.failed,
        }
      }
      // .eml, .html, .txt: the body is already text. An .eml may be
      // quoted-printable, which turns "=93" into a soft break mid-word, so the
      // encoding is undone before anything is matched against it.
      let raw = buf.toString('utf8')
      if (/content-transfer-encoding:\s*quoted-printable/i.test(raw)) {
        raw = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi,
          (_, h) => String.fromCharCode(parseInt(h, 16)))
      }
      const subject = (raw.match(/^Subject:\s*(.+)$/im) || [])[1] || name
      return { success: true, parsed: parseFacilityReview({ html: raw, text: raw, subject }), source: name, subject }
    }

    if (type.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('file')
      if (!file || typeof file === 'string') {
        return NextResponse.json({ success: false, error: 'no file' }, { status: 400 })
      }
      const buf = Buffer.from(await (file as File).arrayBuffer())
      if (buf.length > MAX_BYTES) {
        return NextResponse.json({ success: false, error:
          'That file is ' + (buf.length / 1048576).toFixed(1) + ' MB — too big to send in one piece. '
          + 'Reload the page: the tracker now uploads large emails in parts.' }, { status: 400 })
      }
      return NextResponse.json(await handleFile(buf, String((file as File).name || '')))
    }

    const body = await req.json().catch(() => null)

    // ── an email that arrived in pieces ──
    // The browser parked it under facility/_incoming/<id>/000, 001, … so no
    // single request came near the platform's 4.5 MB body cap. Put it back
    // together, read it exactly as if it had come whole, then clear the pieces.
    if (body?.uploadId) {
      const id = String(body.uploadId)
      const parts = Number(body.parts)
      if (!/^[a-z0-9]{8,40}$/.test(id) || !Number.isInteger(parts) || parts < 1 || parts > 60) {
        return NextResponse.json({ success: false, error: 'bad upload reference' }, { status: 400 })
      }
      const paths = Array.from({ length: parts }, (_, n) => `facility/_incoming/${id}/${String(n).padStart(3, '0')}`)
      try {
        const bufs: Buffer[] = []
        for (const path of paths) {
          const got = await get(path, { access: 'private' })
          if (!got || !got.stream) {
            return NextResponse.json({ success: false, error:
              'Part of that upload went missing before it could be read. Drop the email again.' }, { status: 400 })
          }
          bufs.push(Buffer.from(await new Response(got.stream as any).arrayBuffer()))
        }
        return NextResponse.json(await handleFile(Buffer.concat(bufs), String(body.name || '').slice(0, 200)))
      } finally {
        // The pieces were only ever a way to carry the file; the file itself is
        // stored by handleFile if it was a review. Failing to delete leaves an
        // orphan, not a broken record, so it must not fail the request.
        for (const path of paths) { try { await del(path) } catch { /* orphan */ } }
      }
    }

    const html = String(body?.html || '')
    const text = String(body?.text || '')
    if (!html && !text) {
      return NextResponse.json({ success: false, error: 'nothing to read' }, { status: 400 })
    }
    const parsed = parseFacilityReview({ html: html || text, text, subject: String(body?.subject || '') })
    return NextResponse.json({ success: true, parsed, source: 'pasted' })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
