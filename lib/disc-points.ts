// lib/disc-points.ts
//
// DISC-POINTS-WRITE-v1
//
// The disciplinary "Documentation Form" writes one event per violation into the
// DiscPoints tab, which getDiscPoints already reads and activeDiscPoints already
// sums over its rolling 12-month window. This is the "connect the form to the
// tracker" piece — no new math, just an append in the schema getDiscPoints expects.
//
// DiscPoints schema: eventId | globalId | employeeName | points | date | reason | addedAt

import { appendSheet, getEmployeeProfiles, readSheet, writeSheet, rowsToObjects } from './sheets'

const TAB = 'DiscPoints'
// sourceSubmissionId links the event back to the form submission that caused
// it. Without it an approval cannot be reversed: a denied write-up would leave
// its points sitting in the tracker with nothing pointing at them.
const COLS = ['eventId', 'globalId', 'employeeName', 'points', 'date', 'reason', 'addedAt',
  'sourceSubmissionId'] as const

// Violation options carry their point value as a trailing "(N pts)" — this pulls
// it back out so the tracker stores a number.
export function parseViolationPoints(label: string): number {
  const m = String(label || '').match(/\((\d+)\s*pts?\)/i)
  return m ? Number(m[1]) : 0
}

export async function recordDisciplinaryEvent(o: {
  globalId: string
  points: number
  reason: string
  date: string
  /** The submission this came from, so it can be reversed if that is undone. */
  sourceSubmissionId?: string
}): Promise<void> {
  const globalId = String(o.globalId || '').trim()
  const points = Number(o.points) || 0
  const date = String(o.date || '').trim()
  // Nothing trackable without a real employee, a point value, and a date.
  if (!globalId || !points || !date) return

  let employeeName = ''
  try {
    const profs = await getEmployeeProfiles()
    const p = profs.find((r: any) => String(r.globalId || '').trim() === globalId)
    if (p) employeeName = String((p as any).name || (p as any).employeeName || '').trim()
  } catch { /* name is display-only; globalId is what matters */ }

  const reason = String(o.reason || '').trim()

  const row: Record<string, string> = {
    eventId: 'dp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    globalId,
    employeeName,
    points: String(points),
    date,
    reason,
    addedAt: new Date().toISOString(),
    sourceSubmissionId: String(o.sourceSubmissionId || '').trim(),
  }

  // Header-aware, because the tab predates sourceSubmissionId. If the column is
  // missing the tab is rewritten whole with the full header, keeping every row;
  // otherwise a plain append, which is safe against a concurrent write.
  let raw: any[][] = []
  try { raw = ((await readSheet(TAB, undefined, { fresh: true })) || []) as any[][] } catch { raw = [] }
  const header = (raw[0] || []).map((h: any) => String(h ?? '').trim())
  const cols = [...COLS]

  if (!header.length) {
    await writeSheet(TAB, [cols, cols.map(c => row[c] ?? '')])
    return
  }
  const missing = cols.filter(c => !header.some(h => h.toLowerCase() === c.toLowerCase()))
  if (missing.length) {
    const existing = rowsToObjects(raw)
    await writeSheet(TAB, [
      cols,
      ...existing.map((r: any) => cols.map(c => String(r[c] ?? ''))),
      cols.map(c => row[c] ?? ''),
    ])
    return
  }
  await appendSheet(TAB, [header.map(h => {
    const hit = cols.find(c => c.toLowerCase() === h.toLowerCase())
    return hit ? (row[hit] ?? '') : ''
  })])
}

/**
 * Undo the event a submission created.
 *
 * An approval that can be given but not taken back is not an approval. If a
 * write-up is denied, or the approval is reversed, the points must leave the
 * tracker -- they gate bonus at 4 and a raise at 6, so a stale event is not a
 * cosmetic problem.
 *
 * Returns how many rows went, so the caller can tell "removed" from "there was
 * nothing to remove" rather than guessing.
 */
export async function removeDisciplinaryEventsBySubmission(submissionId: string): Promise<number> {
  const sid = String(submissionId || '').trim()
  if (!sid) return 0
  let raw: any[][] = []
  try { raw = ((await readSheet(TAB, undefined, { fresh: true })) || []) as any[][] } catch { return 0 }
  const header = (raw[0] || []).map((h: any) => String(h ?? '').trim())
  if (!header.length) return 0
  // Nothing can match on a tab that never had the column.
  if (!header.some(h => h.toLowerCase() === 'sourcesubmissionid')) return 0

  const rows = rowsToObjects(raw)
  const kept = rows.filter((r: any) => String(r.sourceSubmissionId ?? '').trim() !== sid)
  const removed = rows.length - kept.length
  if (!removed) return 0
  await writeSheet(TAB, [header, ...kept.map((r: any) => header.map(h => String(r[h] ?? '')))])
  return removed
}
