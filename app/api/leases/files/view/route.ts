// app/api/leases/files/view/route.ts
//
// LEASE-VIEW-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Stream one lease document back to the browser.
//
//   GET /api/leases/files/view?fileId=<id>[&dl=1]
//
// Addressed by fileId, never by blob pathname. The pathname is resolved from
// the LeaseFiles tab here, so a signed-in admin cannot read an arbitrary blob
// by guessing a path — they can only fetch documents this store knows about.
// Same reasoning as the form-photo viewer, which checks a pathname against the
// submission that references it.
//
// The private store's own URLs do not open on their own; this is the only way
// in, and it is owner/admin like the rest of /api/leases.
//
// dl=1 forces a download rather than the browser's inline PDF viewer.

import { NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'
import { listFiles } from '@/lib/leases'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Quote a filename for Content-Disposition without breaking the header. */
function dispositionFor(fileName: string, download: boolean): string {
  const safe = fileName.replace(/["\\\r\n]/g, '').slice(0, 200) || 'document'
  const utf8 = encodeURIComponent(safe)
  return `${download ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${utf8}`
}

export async function GET(req: Request) {
  const gate = await requireCapability('view.leases')
  if (!gate.ok) return gate.response

  const url = new URL(req.url)
  const fileId = (url.searchParams.get('fileId') || '').trim()
  const download = url.searchParams.get('dl') === '1'
  if (!fileId) return NextResponse.json({ error: 'fileId is required' }, { status: 400 })

  const file = (await listFiles()).find(f => f.fileId === fileId)
  if (!file) return new NextResponse('Not found', { status: 404 })

  const result = await get(file.pathname, {
    access: 'private',
    ifNoneMatch: req.headers.get('if-none-match') ?? undefined,
  })
  if (!result) return new NextResponse('Not found', { status: 404 })

  if (result.statusCode === 304) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: result.blob.etag, 'Cache-Control': 'private, max-age=300' },
    })
  }

  return new NextResponse(result.stream, {
    headers: {
      'Content-Type': result.blob.contentType || file.contentType || 'application/octet-stream',
      'Content-Disposition': dispositionFor(file.fileName, download),
      'X-Content-Type-Options': 'nosniff',
      ETag: result.blob.etag,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
