// app/api/facility/photo/route.ts
//
// FACILITY-PHOTO-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   POST multipart  file=<image>  salonNum=  requestId=gf_…
//     -> { success, photo }
//
// One "after" photo for a green-flag request, stored before the request is
// sent so the email can attach it and the tracker can keep it as evidence.
//
// The browser shrinks each photo to 1600px JPEG first — the same step the
// forms use — so a phone photo arrives at a few hundred KB, one per request,
// well inside the platform's 4.5 MB body cap however many there are.
//
// Filed under the request id (gf_…), not a review id, so these never land in
// an item's "photos from this review" pool: they are what the salon looks like
// now, not what the reviewer found.

import { NextResponse } from 'next/server'
import { put, del } from '@vercel/blob'
import { requireCapability } from '@/lib/require-role'
import { canSeeSalon } from '@/lib/scope-filter'
import { savePhotos, listPhotos } from '@/lib/facility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX = 4 * 1024 * 1024

export async function POST(req: Request) {
  const gate = await requireCapability('edit.facility')
  if (!gate.ok) return gate.response
  try {
    const form = await req.formData()
    const file = form.get('file')
    const salonNum = String(form.get('salonNum') || '').trim().slice(0, 10)
    const requestId = String(form.get('requestId') || '').trim()
    if (!file || typeof file === 'string') return NextResponse.json({ success: false, error: 'no file' }, { status: 400 })
    if (!/^gf_[a-z0-9]{8,40}$/.test(requestId)) {
      return NextResponse.json({ success: false, error: 'bad request id' }, { status: 400 })
    }
    if (!canSeeSalon(gate.access, salonNum)) {
      return NextResponse.json({ success: false, error: 'outside your salons' }, { status: 403 })
    }
    const f = file as File
    const type = f.type || 'image/jpeg'
    if (!/^image\//i.test(type)) return NextResponse.json({ success: false, error: 'not an image' }, { status: 400 })
    const buf = Buffer.from(await f.arrayBuffer())
    if (!buf.length || buf.length > MAX) {
      return NextResponse.json({ success: false, error: 'photo is empty or too large' }, { status: 400 })
    }
    const safe = String(f.name || 'photo.jpg').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
    const b = await put(`facility/${salonNum}/greenflag/${requestId}/${Date.now().toString(36)}-${safe}`, buf, {
      access: 'private', contentType: type, addRandomSuffix: false,
    })
    const [photo] = await savePhotos([{
      reviewId: requestId, salonNum, itemId: '',
      fileName: f.name || safe, pathname: b.pathname, contentType: type, size: buf.length,
    }], gate.email)
    if (photo) return NextResponse.json({ success: true, photo })
    // The same photo added twice to one request is de-duplicated by savePhotos.
    // Hand back the copy already held and drop the bytes just stored, rather
    // than failing an upload the sender can see succeeded.
    const held = (await listPhotos(true)).find(p =>
      p.reviewId === requestId && p.fileName === (f.name || safe) && p.size === buf.length)
    try { await del(b.pathname) } catch { /* orphan */ }
    return NextResponse.json({ success: true, photo: held || null })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
