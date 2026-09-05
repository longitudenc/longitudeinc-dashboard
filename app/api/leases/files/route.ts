// app/api/leases/files/route.ts
//
// LEASE-FILES-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// The uploaded lease documents: list them, confirm one after upload, edit how
// one is filed, or remove one.
//
//   GET                          every file, newest first
//   POST { pathname, ... }       record/refile one (idempotent on pathname)
//   DELETE ?fileId=…             forget one, and delete the blob behind it
//
// Owner/admin throughout, matching /api/leases/upload. Nothing here is scoped
// per salon: a lease is a company record.

import { NextResponse } from 'next/server'
import { del } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'
import { listFiles, upsertFile, removeFile, DOC_TYPES } from '@/lib/leases'
import { SALON_NAMES } from '@/lib/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max)

export async function GET() {
  const gate = await requireCapability('view.leases')
  if (!gate.ok) return gate.response
  try {
    // Fresh: a file uploaded seconds ago must appear, or the upload reads as
    // having failed.
    const files = await listFiles({ fresh: true })
    // The salon list travels with the listing so the upload picker has one
    // source of truth — lib/config — rather than a copy that drifts.
    const salons = Object.keys(SALON_NAMES).sort()
      .map(num => ({ num, name: SALON_NAMES[num] }))
    return NextResponse.json({ success: true, files, docTypes: [...DOC_TYPES], salons })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response
  try {
    const body = await req.json()
    const pathname = S(body?.pathname, 400)
    if (!pathname) {
      return NextResponse.json({ success: false, error: 'pathname is required' }, { status: 400 })
    }
    if (!pathname.startsWith('leases/')) {
      return NextResponse.json({ success: false, error: 'not a lease document' }, { status: 400 })
    }

    // Only the descriptive fields are writable. fileId, uploadedAt and
    // uploadedBy are identity: upsertFile keeps whatever was written first.
    const file = await upsertFile({
      pathname,
      fileName: body?.fileName !== undefined ? S(body.fileName, 260) : undefined,
      contentType: body?.contentType !== undefined ? S(body.contentType, 120) : undefined,
      sizeBytes: body?.sizeBytes !== undefined ? Number(body.sizeBytes) || 0 : undefined,
      uploadedBy: gate.email,
      salonNum: body?.salonNum !== undefined ? S(body.salonNum, 20) : undefined,
      location: body?.location !== undefined ? S(body.location, 120) : undefined,
      unit: body?.unit !== undefined ? S(body.unit, 40) : undefined,
      docType: body?.docType !== undefined ? S(body.docType, 60) : undefined,
      note: body?.note !== undefined ? S(body.note, 500) : undefined,
    })
    return NextResponse.json({ success: true, file })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response
  try {
    const fileId = S(new URL(req.url).searchParams.get('fileId'), 80)
    if (!fileId) {
      return NextResponse.json({ success: false, error: 'fileId is required' }, { status: 400 })
    }
    const gone = await removeFile(fileId)
    if (!gone) return NextResponse.json({ success: true, removed: false })

    // Row first, then bytes. If the blob delete fails the row is already gone,
    // which leaves an orphaned blob — wasteful but harmless. The reverse order
    // could leave a row pointing at nothing, which looks like data loss.
    try {
      await del(gone.pathname)
    } catch {
      // Blob already absent, or a transient failure. The record is what the
      // Lease Manager reads, and that is gone either way.
    }
    return NextResponse.json({ success: true, removed: true, file: gone })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
