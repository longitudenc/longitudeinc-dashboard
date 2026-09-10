// app/api/facility/upload-chunk/route.ts
//
// FACILITY-UPLOAD-CHUNK-v1  (Ctrl+F this string to confirm the file saved)
//
//   POST ?id=<uploadId>&n=<part>     body: raw bytes, at most ~3.5 MB
//
// One piece of a dropped email, parked in the private store until
// /api/facility/ingest is told to put the pieces back together.
//
// WHY PIECES. A serverless request body is capped at 4.5 MB by the platform,
// and the cap is enforced before any code here runs — an email over it comes
// back as a plain-text "Request Entity Too Large" that nothing on the page can
// read as JSON. A review email with a dozen phone photos is routinely past it.
// Sending it in pieces under the cap means the size of the email stops
// mattering at all, and it needs nothing configured: put() authenticates by
// OIDC on Vercel, exactly as the lease uploads do.
//
// The pieces live under facility/_incoming/<uploadId>/ and are deleted once
// they have been reassembled.

import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Under the 4.5 MB platform cap with room for the request itself. */
const MAX_PART = 4 * 1024 * 1024
/** 60 parts of ~3.5 MB is ~210 MB — far past any email, short of abuse. */
const MAX_PARTS = 60

export async function POST(req: Request) {
  const gate = await requireCapability('edit.facility')
  if (!gate.ok) return gate.response

  const q = new URL(req.url).searchParams
  const id = String(q.get('id') || '')
  const n = Number(q.get('n'))
  if (!/^[a-z0-9]{8,40}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'bad upload id' }, { status: 400 })
  }
  if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS) {
    return NextResponse.json({ success: false, error: 'bad part number' }, { status: 400 })
  }

  try {
    const buf = Buffer.from(await req.arrayBuffer())
    if (!buf.length) return NextResponse.json({ success: false, error: 'empty part' }, { status: 400 })
    if (buf.length > MAX_PART) {
      return NextResponse.json({ success: false, error: 'part is too large' }, { status: 400 })
    }
    await put(`facility/_incoming/${id}/${String(n).padStart(3, '0')}`, buf, {
      access: 'private',
      contentType: 'application/octet-stream',
      addRandomSuffix: false,
      // A retried piece replaces itself rather than failing the whole upload.
      allowOverwrite: true,
    })
    return NextResponse.json({ success: true, n, size: buf.length })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
