// client/lease-upload.ts
// ---------------------------------------------------------------------------
// The browser half of a lease upload, bundled to public/lease-upload.js.
//
// WHY THIS FILE EXISTS AT ALL: public/*.html are plain static files with no
// build step, so they cannot import from npm. A lease is a 10–30 MB scan and a
// serverless request body is capped at 4.5 MB, so the bytes have to go straight
// from the browser to Blob — which needs @vercel/blob/client. Bundling this one
// module is what lets a static page use it. `npm run build` regenerates it via
// the prebuild script; the output is committed so the page works even if that
// step is ever skipped.
//
// Everything security-relevant happens server-side in /api/leases/upload: who
// may upload, which content types, how large, and where in the store it may
// land. Nothing here is trusted.
// ---------------------------------------------------------------------------

import { upload } from '@vercel/blob/client'

export interface LeaseUploadMeta {
  fileName: string
  contentType: string
  location?: string
  unit?: string
  docType?: string
  note?: string
}

/**
 * Where this file will live in the store.
 *
 * Grouped by location so the store stays browsable, and carrying a timestamp
 * plus a random chunk so two files named "Lease.pdf" cannot collide. The
 * original filename is kept in the metadata row, not relied on here — path
 * characters are too easy to get wrong.
 *
 * The server only insists on the `leases/` prefix, so this does not have to
 * agree with anything else byte for byte.
 */
export function leasePathname(location: string, fileName: string): string {
  const slug = (s: string, max: number) =>
    String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, max)
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? slug(fileName.slice(dot + 1), 8) : 'bin'
  const base = slug(dot > 0 ? fileName.slice(0, dot) : fileName, 60) || 'document'
  const where = slug(location, 40) || 'unfiled'
  return `leases/${where}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}.${ext}`
}

/** Anything past this goes up in parts, so one dropped connection is not a restart. */
const MULTIPART_OVER_BYTES = 8 * 1024 * 1024

async function uploadLease(
  file: File,
  meta: LeaseUploadMeta,
  onProgress?: (percentage: number) => void,
  abortSignal?: AbortSignal,
) {
  const pathname = leasePathname(meta.location || '', meta.fileName || file.name)
  return upload(pathname, file, {
    access: 'private',
    handleUploadUrl: '/api/leases/upload',
    contentType: file.type || 'application/octet-stream',
    // Read back in onBeforeGenerateToken, so the metadata recorded is what this
    // signed-in admin actually asked for rather than a later, separate claim.
    clientPayload: JSON.stringify(meta),
    multipart: file.size > MULTIPART_OVER_BYTES,
    abortSignal,
    onUploadProgress: (e: { percentage: number }) => {
      if (onProgress) onProgress(e.percentage)
    },
  })
}

declare global {
  interface Window {
    LeaseUpload: {
      upload: typeof uploadLease
      leasePathname: typeof leasePathname
      MULTIPART_OVER_BYTES: number
    }
  }
}

window.LeaseUpload = { upload: uploadLease, leasePathname, MULTIPART_OVER_BYTES }
