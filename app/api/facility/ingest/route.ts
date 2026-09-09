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
import { requireCapability } from '@/lib/require-role'
import { isMsg, readMsg } from '@/lib/msg-reader'
import { parseFacilityReview } from '@/lib/facility-parse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 12 * 1024 * 1024

export async function POST(req: Request) {
  const gate = await requireCapability('edit.facility')
  if (!gate.ok) return gate.response

  try {
    const type = req.headers.get('content-type') || ''

    if (type.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('file')
      if (!file || typeof file === 'string') {
        return NextResponse.json({ success: false, error: 'no file' }, { status: 400 })
      }
      const buf = Buffer.from(await (file as File).arrayBuffer())
      if (buf.length > MAX_BYTES) {
        return NextResponse.json({ success: false, error: 'file is too large' }, { status: 400 })
      }
      const name = String((file as File).name || '')

      if (isMsg(buf)) {
        const msg = readMsg(buf)
        const parsed = parseFacilityReview({ html: msg.html, text: msg.text, subject: msg.subject })
        return NextResponse.json({ success: true, parsed, source: name, subject: msg.subject })
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
      const parsed = parseFacilityReview({ html: raw, text: raw, subject })
      return NextResponse.json({ success: true, parsed, source: name, subject })
    }

    const body = await req.json().catch(() => null)
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
