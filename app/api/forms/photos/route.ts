// app/api/forms/photo/route.ts
//
// PHOTO-UPLOAD-ROUTE-v2-PRIVATE  (Ctrl+F this string to confirm the file saved)
//
// Upload one photo for a form submission into the PRIVATE Blob store and return
// its pathname + URL. The bytes live in Vercel Blob; only the reference is
// stored on the submission row, so the spreadsheet never holds image data.
//
// The store is PRIVATE: the returned URL is NOT publicly openable. Photos are
// served back to the browser through a separate auth-checked route (built with
// the viewing UI) that reuses canViewSubmission, so a photo is visible to
// exactly the people who can see its ticket.
//
// The browser COMPRESSES each image before sending it here (downscaled JPEG,
// typically a few hundred KB), which keeps the request well under the
// serverless body limit — so we can accept a normal upload and skip the
// client-token dance entirely.
//
// Any signed-in user may upload: anyone who can fill out a form can attach a
// photo. The sign-in gate is what stops this being an open dumping ground.
// On Vercel, put() authenticates to the private store via short-lived OIDC
// automatically — there is no token to paste.

import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { requireSignedIn } from '@/lib/require-role'

export const runtime = 'nodejs'

// Ceiling AFTER the browser has compressed. Real maintenance photos land around
// 200–600 KB; anything past this is uncompressed or not actually a photo.
const MAX_BYTES = 8 * 1024 * 1024 // 8 MB
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const form = await req.formData()
    const file = form.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'no file provided' }, { status: 400 })
    }
    if (!ALLOWED.has(file.type)) {
      return NextResponse.json({ success: false, error: 'must be a JPEG, PNG, or WebP image' }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ success: false, error: 'image too large after compression' }, { status: 400 })
    }

    // Group uploads under the form they belong to, with a collision-proof name.
    const formId = String(form.get('formId') || 'misc').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'misc'
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const pathname = `forms/${formId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

    // access:'private' MUST match a private store. On Vercel the SDK
    // authenticates with short-lived OIDC — nothing to paste.
    const blob = await put(pathname, file, {
      access: 'private',
      contentType: file.type,
      addRandomSuffix: false, // pathname is already unique
    })

    // pathname is what the viewing route needs to stream the file back with
    // get(); the private url is stored for reference but won't open on its own.
    return NextResponse.json({ success: true, pathname: blob.pathname, url: blob.url })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'upload failed' }, { status: 500 })
  }
}
