// lib/adp-stipends.ts
//
// STIPENDS-v1  (Ctrl+F this string to confirm the file saved)
//
// The weekly stipends paid to the GM and the area managers.
//
// THESE NEVER REACH THE ADP FILE. ADP auto-populates them already, so writing
// them into the upload would pay each person twice. They exist here for one
// reason: the reconciliation. Without them the dashboard's weekly total sits
// about $1,685 below the office spreadsheet every single week, and a constant
// difference is indistinguishable from a fault until somebody works out what
// it is -- which is a conversation that has now happened twice.
//
// Stored in a Google Sheet tab so a change is a change, not a deploy. They move
// roughly once a year.
//
//   ADP_STIPENDS   name | amount | note | active
//
// A missing tab means no stipends, which is the correct behaviour for anyone
// who has not set them up: the reconciliation then simply reports the gap it
// always did.

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'

export const ADP_STIPENDS_TAB = 'ADP_STIPENDS'
export const STIPEND_COLUMNS = ['name', 'amount', 'note', 'active'] as const

const S = (v: unknown) => String(v ?? '').trim()
const money = (v: unknown) => {
  const n = Number(S(v).replace(/[$,]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}
// A blank `active` means active. Somebody adding a row by hand should not have
// to know to type "yes" for it to count.
const isActive = (v: unknown) => {
  const s = S(v).toLowerCase()
  return s === '' || ['true', 'yes', 'y', '1', 'active'].includes(s)
}

export interface Stipend {
  name: string
  amount: number
  note: string
  active: boolean
}

/** Seeded from the office spreadsheet on 2026-09-08. Weekly amounts. */
export const DEFAULT_STIPENDS: Stipend[] = [
  { name: 'Kayla', amount: 1150.00, note: 'GM', active: true },
  { name: 'Luann', amount: 171.55, note: 'Area manager', active: true },
  { name: 'Bridgette', amount: 140.28, note: 'Area manager', active: true },
  { name: 'Cassi', amount: 135.04, note: 'Area manager', active: true },
  { name: 'Dana', amount: 88.17, note: 'Area manager', active: true },
]

/**
 * Read the tab. A missing tab returns the seed above rather than nothing, so
 * the first reconciliation after this ships is already right and the office
 * can correct a figure rather than type five.
 */
export async function loadStipends(opts?: { fresh?: boolean }): Promise<Stipend[]> {
  try {
    const rows = rowsToObjects((await readSheet(ADP_STIPENDS_TAB, undefined, opts)) || [])
    if (!rows.length) return DEFAULT_STIPENDS.map(s => ({ ...s }))
    return rows
      .map(r => ({
        name: S(r.name),
        amount: money(r.amount),
        note: S(r.note),
        active: isActive(r.active),
      }))
      .filter(s => s.name)
  } catch {
    return DEFAULT_STIPENDS.map(s => ({ ...s }))
  }
}

export async function saveStipends(list: Stipend[]): Promise<number> {
  const rows = list
    .map(s => ({
      name: S(s.name),
      amount: money(s.amount),
      note: S(s.note),
      active: s.active === false ? 'no' : 'yes',
    }))
    .filter(s => s.name)

  await writeSheet(ADP_STIPENDS_TAB, [
    [...STIPEND_COLUMNS],
    ...rows.map(r => STIPEND_COLUMNS.map(c => String((r as any)[c] ?? ''))),
  ])
  return rows.length
}

/** What the active stipends add to a week. Inactive rows are kept, not counted. */
export const stipendTotal = (list: Stipend[]) =>
  Math.round(list.filter(s => s.active).reduce((t, s) => t + s.amount, 0) * 100) / 100
