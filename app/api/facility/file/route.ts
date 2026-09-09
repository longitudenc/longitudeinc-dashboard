// app/api/facility/file/route.ts
//
// FACILITY-FILE-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET ?photoId=…        a repair photo
//   GET ?reviewId=…&dl=1  the original review email
//
// Serve a private blob, by ID and never by path. The id is looked up in
// FacilityPhotos or FacilityReviews first, so a signed-in user cannot read an
// arbitrary object out of the store by guessing at pathnames — and the salon on
// that row is checked against the ones they may see, so an area manager cannot
// pull another area's evidence by holding onto a link.

import { NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'
import { canSeeSalon } from '@/lib/scope-filter'
import { listPhotos, listReviews } from '@/lib/facility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function dispositionFor(fileName: string, download: boolean) {
  const safe = String(fileName || 'file').replace(/["\\\r\n]/g, '').slice(0, 200) || 'file'
  return `${download ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

export async function GET(req: Request) {
  const gate = await requireCapability('view.facility')
  if (!gate.ok) return gate.response

  const url = new URL(req.url)
  const photoId = (url.searchParams.get('photoId') || '').trim()
  const reviewId = (url.searchParams.get('reviewId') || '').trim()
  const download = url.searchParams.get('dl') === '1'

  let pathname = '', fileName = '', contentType = '', salonNum = ''
  if (photoId) {
    const p = (await listPhotos()).find(x => x.photoId === photoId)
    if (!p) return new NextResponse('Not found', { status: 404 })
    pathname = p.pathname; fileName = p.fileName; contentType = p.contentType; salonNum = p.salonNum
  } else if (reviewId) {
    const r = (await listReviews()).find(x => x.reviewId === reviewId)
    if (!r || !r.msgPathname) return new NextResponse('Not found', { status: 404 })
    pathname = r.msgPathname
    fileName = r.sourceFile || `facility-review-${r.salonNum}-${r.reviewDate}.msg`
    contentType = 'application/vnd.ms-outlook'
    salonNum = r.salonNum
  } else {
    return NextResponse.json({ error: 'photoId or reviewId is required' }, { status: 400 })
  }

  if (!canSeeSalon(gate.access, salonNum)) {
    return new NextResponse('Not found', { status: 404 })
  }

  try {
    const result = await get(pathname, {
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
        'Content-Type': result.blob.contentType || contentType || 'application/octet-stream',
        'Content-Disposition': dispositionFor(fileName, download || !!reviewId),
        'X-Content-Type-Options': 'nosniff',
        ETag: result.blob.etag,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 })
  }
}
