// lib/leases.ts
// ---------------------------------------------------------------------------
// The document store behind the Lease Manager.
//
// Lease paperwork is scanned PDFs — executed leases, amendments, estoppels,
// renewal notices — routinely 10–30 MB each. The bytes live in the PRIVATE
// Vercel Blob store, exactly like form photos; this tab holds only the
// reference, so the spreadsheet never carries document data.
//
// Two things follow from the file sizes, and they drive the whole design:
//
//   1. A serverless request body is capped at 4.5 MB, so a lease CANNOT be
//      posted through one of our routes the way a compressed photo is. The
//      browser uploads straight to Blob using a short-lived token minted by
//      /api/leases/upload. See that route for the flow.
//
//   2. Because the browser talks to Blob directly, the metadata row is written
//      afterwards. Blob calls us back (onUploadCompleted) AND the browser
//      confirms; upsertFile() is keyed on pathname so whichever arrives first
//      wins and the second is a no-op. Neither path is trusted to be the only
//      one — the callback cannot reach localhost, and a browser can be closed
//      mid-upload.
//
// Nothing here is scoped to a salon. Leases are a company-level record and the
// routes gate on owner/admin; see app/api/leases/* for the enforcement.
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, appendSheet, rowsToObjects } from '@/lib/sheets'

export const TAB_LEASE_FILES = 'LeaseFiles'

export const LEASE_FILE_COLUMNS = [
  'fileId', 'pathname', 'fileName', 'contentType', 'sizeBytes',
  'uploadedAt', 'uploadedBy', 'location', 'unit', 'docType', 'note',
] as const

/** What kind of paper this is. Free text is allowed; these are the offered set. */
export const DOC_TYPES = [
  'Lease',
  'Amendment',
  'Abstract',
  'Renewal notice',
  'Estoppel',
  'Correspondence',
  'Other',
] as const

/**
 * What the browser is allowed to send. Deliberately narrow: this is a document
 * store, and an open one becomes a dumping ground for anything.
 */
export const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

/** Generous, but not unbounded — a 200 MB "lease" is a mistake, not a lease. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * The ceiling for an upload sent THROUGH one of our routes. A serverless
 * request body is capped at 4.5 MB by the platform; this sits under it so a
 * file that is too big gets a sentence from us rather than an opaque 413.
 * Anything larger has to go the client-token route, which needs
 * BLOB_READ_WRITE_TOKEN set.
 */
export const MAX_DIRECT_BYTES = 4 * 1024 * 1024

/**
 * Where an uploaded file lives in the store.
 *
 * Grouped by location so the store stays browsable, and carrying a timestamp
 * plus a random chunk so two files named "Lease.pdf" cannot collide. The
 * original filename is kept on the metadata row, not relied on here.
 *
 * client/lease-upload.ts has its own copy for the client-token path, where
 * the browser must name the path before asking for a token. The two do NOT
 * have to agree: the server only requires the leases/ prefix, and each path
 * is independently unique.
 */
export function leasePathname(location: string, fileName: string): string {
  const slug = (v: string, max: number) =>
    S(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max)
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? slug(fileName.slice(dot + 1), 8) : 'bin'
  const base = slug(dot > 0 ? fileName.slice(0, dot) : fileName, 60) || 'document'
  const where = slug(location, 40) || 'unfiled'
  return `leases/${where}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}.${ext}`
}

export interface LeaseFile {
  fileId: string
  pathname: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedAt: string
  uploadedBy: string
  location: string
  unit: string
  docType: string
  note: string
}

const S = (v: unknown) => String(v ?? '').trim()
const N = (v: unknown) => {
  const x = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(x) ? x : 0
}

export function newFileId(): string {
  return 'lf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function toFile(r: Record<string, any>): LeaseFile {
  return {
    fileId: S(r.fileId),
    pathname: S(r.pathname),
    fileName: S(r.fileName),
    contentType: S(r.contentType),
    sizeBytes: N(r.sizeBytes),
    uploadedAt: S(r.uploadedAt),
    uploadedBy: S(r.uploadedBy),
    location: S(r.location),
    unit: S(r.unit),
    docType: S(r.docType),
    note: S(r.note),
  }
}

/**
 * Every uploaded file, newest first.
 *
 * `fresh` matters after an upload: the read cache would otherwise hide a file
 * that was just added, which reads as the upload having failed.
 */
export async function listFiles(opts: { fresh?: boolean } = {}): Promise<LeaseFile[]> {
  let rows: Record<string, any>[] = []
  try {
    rows = rowsToObjects((await readSheet(TAB_LEASE_FILES, undefined, { fresh: !!opts.fresh })) || [])
  } catch {
    return []            // tab not created yet — an empty store, not an error
  }
  return rows
    .map(toFile)
    .filter(f => f.pathname)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
}

/**
 * Record one uploaded file, keyed on pathname.
 *
 * Idempotent by design: both the Blob callback and the browser confirm the same
 * upload, and either may arrive first or not at all. A second call for a
 * pathname already present updates the descriptive fields and leaves the
 * identity (fileId, uploadedAt, uploadedBy) as first written.
 */
export async function upsertFile(input: Partial<LeaseFile> & { pathname: string }): Promise<LeaseFile> {
  const pathname = S(input.pathname)
  if (!pathname) throw new Error('pathname is required')

  // Read-modify-write over a shared tab: must be fresh, or a concurrent upload
  // is clobbered. Same rule as every other RMW in this codebase.
  let raw: any[][] = []
  try {
    raw = ((await readSheet(TAB_LEASE_FILES, undefined, { fresh: true })) || []) as any[][]
  } catch {
    raw = []
  }

  const header = (raw[0] || []).map((h: any) => S(h))
  const hasHeader = header.length > 0
  const rows = hasHeader ? rowsToObjects(raw) : []
  const existing = rows.find(r => S(r.pathname) === pathname)

  const merged: LeaseFile = {
    fileId: S(existing?.fileId) || S(input.fileId) || newFileId(),
    pathname,
    fileName: S(input.fileName) || S(existing?.fileName),
    contentType: S(input.contentType) || S(existing?.contentType),
    sizeBytes: N(input.sizeBytes) || N(existing?.sizeBytes),
    uploadedAt: S(existing?.uploadedAt) || S(input.uploadedAt) || new Date().toISOString(),
    uploadedBy: S(existing?.uploadedBy) || S(input.uploadedBy),
    location: input.location !== undefined ? S(input.location) : S(existing?.location),
    unit: input.unit !== undefined ? S(input.unit) : S(existing?.unit),
    docType: input.docType !== undefined ? S(input.docType) : S(existing?.docType),
    note: input.note !== undefined ? S(input.note) : S(existing?.note),
  }

  const cols = [...LEASE_FILE_COLUMNS]
  const rowFor = (f: LeaseFile) => cols.map(c => String((f as any)[c] ?? ''))

  if (!hasHeader) {
    await writeSheet(TAB_LEASE_FILES, [cols, rowFor(merged)])
    return merged
  }
  if (!existing) {
    // Append, so a concurrent upload writing a different row is not overwritten.
    await appendSheet(TAB_LEASE_FILES, [header.map(h => {
      const i = cols.findIndex(c => c.toLowerCase() === h.toLowerCase())
      return i >= 0 ? String((merged as any)[cols[i]] ?? '') : ''
    })])
    return merged
  }

  const updated = rows.map(r => {
    const f = S(r.pathname) === pathname ? merged : toFile(r)
    return header.map(h => {
      const i = cols.findIndex(c => c.toLowerCase() === h.toLowerCase())
      return i >= 0 ? String((f as any)[cols[i]] ?? '') : S(r[h])
    })
  })
  await writeSheet(TAB_LEASE_FILES, [header, ...updated])
  return merged
}

/** Forget a file. Returns the row that was removed, so the caller can delete the blob. */
export async function removeFile(fileId: string): Promise<LeaseFile | null> {
  const id = S(fileId)
  if (!id) return null
  let raw: any[][] = []
  try {
    raw = ((await readSheet(TAB_LEASE_FILES, undefined, { fresh: true })) || []) as any[][]
  } catch {
    return null
  }
  const header = (raw[0] || []).map((h: any) => S(h))
  if (!header.length) return null
  const rows = rowsToObjects(raw)
  const gone = rows.find(r => S(r.fileId) === id)
  if (!gone) return null
  const keep = rows.filter(r => S(r.fileId) !== id)
  await writeSheet(TAB_LEASE_FILES, [header, ...keep.map(r => header.map(h => S(r[h])))])
  return toFile(gone)
}
