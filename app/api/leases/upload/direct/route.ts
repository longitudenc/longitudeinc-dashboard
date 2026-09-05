// app/api/leases/upload/direct/route.ts
//
// LEASE-DIRECT-UPLOAD-v1  (Ctrl+F this string to confirm the file saved)
//
// Take the bytes ourselves and put them in the private Blob store — the same
// thing /api/forms/photos does, and the DEFAULT path for lease documents.
//
// Why this exists alongside the client-token route next door: handleUpload()
// signs a client token with BLOB_READ_WRITE_TOKEN and, unlike put(), has no
// OIDC fallback. On a project that never set that variable every client upload
// fails with "Failed to retrieve the client token". put() authenticates via
// short-lived OIDC on Vercel, so this route works with nothing configured.
//
// Real lease paperwork turns out to be small — executed leases and amendments
// arrive as Word files and modest PDFs, a few hundred KB each — so this handles
// essentially all of it. The client-token route stays for the occasional large
// scan, and only that needs the token set.
//
// The ceiling here is the platform's, not ours: a serverless request body is
// capped at 4.5 MB. MAX_DIRECT_BYTES sits under that so a rejection is a clear
// message from us rather than an opaque 413 from the edge.
//
// Owner/admin, like everything under /api/leases.

import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'
import {
  upsertFile, leasePathname, ALLOWED_CONTENT_TYPES, MAX_DIRECT_BYTES,
} from '@/lib/leases'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const S = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max)

/**
 * A browser sometimes reports no type at all (a .docx dragged from some file
 * managers, anything from a network share). Fall back to the extension rather
 * than refusing a document that is plainly fine.
 */
const EXT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain',
}

function contentTypeFor(file: File, declared: string): string {
  if (declared && ALLOWED_CONTENT_TYPES.has(declared)) return declared
  if (file.type && ALLOWED_CONTENT_TYPES.has(file.type)) return file.type
  const dot = file.name.lastIndexOf('.')
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  return EXT_TYPE[ext] || ''
}

export async function POST(req: Request) {
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response

  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'no file provided' }, { status: 400 })
    }

    const contentType = contentTypeFor(file, S(form.get('contentType'), 120))
    if (!contentType) {
      return NextResponse.json({
        success: false,
        error: 'Not a document type this store accepts (PDF, image, Word or Excel).',
      }, { status: 400 })
    }
    if (file.size > MAX_DIRECT_BYTES) {
      return NextResponse.json({
        success: false,
        error: `Too large to send this way (${(file.size / 1048576).toFixed(1)} MB). `
             + 'Files this size need the client-upload path.',
      }, { status: 413 })
    }

    const location = S(form.get('location'), 120)
    const fileName = S(form.get('fileName'), 260) || file.name
    const pathname = leasePathname(location, fileName)

    const blob = await put(pathname, file, {
      access: 'private',
      contentType,
      addRandomSuffix: false,     // leasePathname() is already unique
    })

    const record = await upsertFile({
      pathname: blob.pathname,
      fileName,
      contentType,
      sizeBytes: file.size,
      uploadedBy: gate.email,
      salonNum: S(form.get("salonNum"), 20),
      location,
      unit: S(form.get('unit'), 40),
      docType: S(form.get('docType'), 60),
      note: S(form.get('note'), 500),
    })

    return NextResponse.json({ success: true, file: record })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'upload failed' }, { status: 500 })
  }
}
