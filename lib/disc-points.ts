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

import { appendSheet, getEmployeeProfiles } from './sheets'

const TAB = 'DiscPoints'
const COLS = ['eventId', 'globalId', 'employeeName', 'points', 'date', 'reason', 'addedAt'] as const

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
  }

  await appendSheet(TAB, [COLS.map(c => row[c] ?? '')])
}
