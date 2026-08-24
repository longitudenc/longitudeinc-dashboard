// app/api/forms/photos/view/route.ts
//
// PHOTO-VIEW-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// Stream one private form photo back to the browser — but only to someone who
// is allowed to see the submission it belongs to, and only if the pathname is
// actually referenced by that submission. So a valid session cannot read
// arbitrary blobs by guessing pathnames: it must both pass canViewSubmission
// AND name a photo that submission really holds.
//
// GET /api/forms/photos/view?sid=<submissionId>&p=<blob pathname>

import { NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { requireSignedIn } from '@/lib/require-role'
import { getSubmissions, canViewSubmission, getFormDefs } from '@/lib/forms'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  const url = new URL(req.url)
  const sid = (url.searchParams.get('sid') || '').trim()
  const pathname = (url.searchParams.get('p') || '').trim()
  if (!sid || !pathname) {
    return NextResponse.json({ error: 'missing sid or p' }, { status: 400 })
  }

  // Find the submission and confirm the caller may see it. A 404 (not 403) is
  // returned on a permission miss so we don't reveal that the id exists.
  const sub = (await getSubmissions()).find(s => s.submissionId === sid)
  if (!sub) return new NextResponse('Not found', { status: 404 })
  const rv = (await getFormDefs()).find(d => d.formId === sub.formId)?.responseView || []
  if (!canViewSubmission(sub, gate.access, gate.email, rv)) {
    return new NextResponse('Not found', { status: 404 })
  }

  // The requested pathname must be one this submission actually references —
  // otherwise a viewer of ticket A could pull a photo pathname from ticket B.
  const refs = new Set<string>()
  for (const v of Object.values(sub.data || {})) {
    if (Array.isArray(v)) v.forEach(x => refs.add(String(x)))
    else if (typeof v === 'string') refs.add(v)
  }
  if (!refs.has(pathname)) {
    return new NextResponse('Not found', { status: 404 })
  }

  // Read from the PRIVATE store and stream it back. ETag/304 lets the browser
  // reuse its cached copy on revalidation.
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
      'Content-Type': result.blob.contentType || 'image/jpeg',
      'X-Content-Type-Options': 'nosniff',
      ETag: result.blob.etag,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
