// lib/newsletter-store.ts
//
// NEWSLETTER-STORE-v1  (Ctrl+F this string to confirm the file saved)
//
// Draft + published storage for the monthly newsletter, in the PRIVATE Vercel
// Blob store (same store the form photos use). Two copies per month:
//
//   newsletter/draft/<YYYY-MM>.html   editor-only working copy
//   newsletter/pub/<YYYY-MM>.html     published — what signed-in staff can read
//
// Publishing copies the draft over the published copy. Nothing here is publicly
// openable: reads go through get() with access:'private', and the API routes
// gate every call. On Vercel the SDK authenticates to the private store via
// short-lived OIDC — there is no token to paste.

import { put, get, list, del } from '@vercel/blob'

const MONTH = /^\d{4}-\d{2}$/
function assertMonth(m: string): string {
  const s = String(m || '').trim()
  if (!MONTH.test(s)) throw new Error('month must be YYYY-MM')
  return s
}
const draftPath = (m: string) => `newsletter/draft/${m}.html`
const pubPath = (m: string) => `newsletter/pub/${m}.html`

async function readDoc(pathname: string): Promise<string | null> {
  const r = await get(pathname, { access: 'private' }).catch(() => null)
  if (!r || !(r as any).stream) return null
  return await new Response((r as any).stream).text()
}
async function writeDoc(pathname: string, html: string): Promise<void> {
  await put(pathname, html, {
    access: 'private',
    contentType: 'text/html; charset=utf-8',
    addRandomSuffix: false, // stable path so we can overwrite + read it back
    allowOverwrite: true,
  })
}
async function monthsUnder(prefix: string): Promise<string[]> {
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const res: any = await list({ prefix, cursor, limit: 1000 })
    for (const b of res.blobs || []) {
      const m = /([0-9]{4}-[0-9]{2})\.html$/.exec(b.pathname || '')
      if (m) seen.add(m[1])
    }
    cursor = res.cursor
  } while (cursor)
  return Array.from(seen).sort().reverse() // newest first
}

export async function getDraft(month: string) { return readDoc(draftPath(assertMonth(month))) }
export async function getPublished(month: string) { return readDoc(pubPath(assertMonth(month))) }
export async function saveDraft(month: string, html: string): Promise<string> {
  await writeDoc(draftPath(assertMonth(month)), html)
  return new Date().toISOString()
}
export async function publishMonth(month: string): Promise<string> {
  const m = assertMonth(month)
  const html = await getDraft(m)
  if (html == null) throw new Error('no draft to publish for ' + m)
  await writeDoc(pubPath(m), html)
  return new Date().toISOString()
}
export async function unpublishMonth(month: string): Promise<void> {
  // Remove the published copy so it disappears from the reader. The draft
  // stays put, so you can keep editing and re-publish later.
  await del(pubPath(assertMonth(month))).catch(() => {})
}
export async function listPublished() { return monthsUnder('newsletter/pub/') }
export async function listDrafts() { return monthsUnder('newsletter/draft/') }
