// app/api/leases/upload/route.ts
//
// LEASE-UPLOAD-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Mint a short-lived token so the BROWSER can upload a lease document straight
// to the private Blob store.
//
// This is deliberately not the pattern /api/forms/photos uses. That route takes
// the bytes itself, which works only because the browser compresses a photo to
// a few hundred KB first. A lease is a 10–30 MB scan that cannot be compressed
// without destroying it, and a serverless request body is capped at 4.5 MB — so
// posting it through here would fail on most real documents. Instead the file
// never touches our function: we authorise the upload, Blob receives the bytes.
//
// The flow, all driven by @vercel/blob's handleUpload():
//   1. browser POSTs here asking for a token for a pathname
//   2. onBeforeGenerateToken checks WHO is asking and WHAT they may send
//   3. browser PUTs the bytes directly to Blob with that token
//   4. Blob POSTs back here; onUploadCompleted writes the metadata row
//
// Owner/admin only. Lease paperwork carries rent, guarantees and landlord
// terms — company-level records, not something scoped per salon.
//
// NOTE: step 4 cannot reach a laptop, so on localhost the row is written only
// by the browser's own confirm call to /api/leases/files. upsertFile() is keyed
// on pathname and idempotent precisely so both paths can run.

import { NextResponse } from 'next/server'
import { handleUpload } from '@vercel/blob/client'
import { requireAdmin } from '@/lib/require-role'
import {
  upsertFile, ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES,
} from '@/lib/leases'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max)

export async function POST(req: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }

  try {
    const json = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // The token is scoped to one pathname, so this is the only chance to
        // insist the upload lands where we expect. Without it a valid token
        // could be aimed at any path in the store.
        if (!pathname.startsWith('leases/')) {
          throw new Error('lease uploads must live under leases/')
        }

        // Descriptive fields travel with the token rather than being posted
        // separately, so the metadata written by the Blob callback is the
        // metadata this signed-in admin actually asked for.
        let meta: any = {}
        try { meta = JSON.parse(clientPayload || '{}') } catch { meta = {} }

        return {
          allowedContentTypes: [...ALLOWED_CONTENT_TYPES],
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: false,       // leasePathname() is already unique
          tokenPayload: JSON.stringify({
            fileName: S(meta.fileName, 260),
            contentType: S(meta.contentType, 120),
            salonNum: S(meta.salonNum, 20),
            location: S(meta.location, 120),
            unit: S(meta.unit, 40),
            docType: S(meta.docType, 60),
            note: S(meta.note, 500),
            uploadedBy: gate.email,
          }),
        }
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        let meta: any = {}
        try { meta = JSON.parse(tokenPayload || '{}') } catch { meta = {} }
        await upsertFile({
          pathname: blob.pathname,
          fileName: S(meta.fileName, 260) || blob.pathname.split('/').pop() || 'document',
          contentType: S(meta.contentType, 120),
          sizeBytes: Number((blob as any).size) || 0,
          uploadedBy: S(meta.uploadedBy, 200),
          salonNum: S(meta.salonNum, 20),
          location: S(meta.location, 120),
          unit: S(meta.unit, 40),
          docType: S(meta.docType, 60),
          note: S(meta.note, 500),
        })
      },
    })

    return NextResponse.json(json)
  } catch (e: any) {
    // handleUpload throws on a bad token request as well as on our own checks;
    // 400 is right for both — neither is a server fault.
    return NextResponse.json({ success: false, error: e?.message || 'upload failed' }, { status: 400 })
  }
}
