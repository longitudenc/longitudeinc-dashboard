// lib/supply-order.ts
//
// SUPPLY-ORDER-v1
//
// Two tabs behind the supply order form.
//
//   SupplyItems   the catalogue: what each option on the form actually IS.
//                 item | category | vendor | asin | url | packSize | notes | status
//
//   SupplyOrders  the decision: how many of each, per submission.
//                 submissionId | item | qty | updatedAt | updatedBy
//
// The two are deliberately apart from the submission itself. A submission is
// the REQUEST -- what a manager said they were out of -- and it should stay
// exactly as they left it. Quantities are the office manager's ANSWER, decided
// later by someone else, and writing them back into the form data would blur
// who said what. It also means re-opening an order shows the quantities as
// last saved rather than as first guessed.
//
// A missing tab is an empty catalogue or an empty order, never an error: the
// panel degrades to "no product mapped yet" rather than taking the form down.

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'

export const TAB_ITEMS = 'SupplyItems'
export const TAB_ORDERS = 'SupplyOrders'
export const ORDER_COLUMNS = ['submissionId', 'item', 'qty', 'updatedAt', 'updatedBy'] as const
export const ITEM_COLUMNS = [
  'item', 'category', 'vendor', 'asin', 'url', 'packSize', 'notes', 'status',
  // CATALOGUE-MEDIA-v1. Only needed when the ASIN thumbnail below does not
  // resolve; otherwise the picture comes free from the ASIN.
  'image',
  // Written by the catalogue editor so a wrong ASIN can be traced to whoever
  // typed it. Read nowhere -- listSupplyItems ignores unknown columns.
  'updatedAt', 'updatedBy',
] as const

const S = (v: unknown) => String(v ?? '').trim()

export interface SupplyItem {
  item: string
  category: string
  vendor: string
  /** May hold several comma-separated ASINs when the item is bought interchangeably. */
  asins: string[]
  url: string
  packSize: string
  notes: string
  status: string
  image: string
  /** Resolved: `image` if set, else Amazon's thumbnail for the first ASIN. */
  imageUrl: string
}

// Amazon serves a product thumbnail off the ASIN alone. It is not guaranteed
// -- for a few of ours it returns a 43-byte transparent pixel instead -- so
// every consumer must hide an image that arrives 1px wide rather than assume
// this worked. Checked against the real catalogue: 18 of 22 mapped items
// resolve to a genuine 160x160.
export const asinThumb = (asin: string) =>
  asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCL_SL160_.jpg' : ''

export interface OrderLine {
  item: string
  qty: number
}

async function readTab(tab: string, fresh = false): Promise<Record<string, any>[]> {
  try {
    return rowsToObjects((await readSheet(tab, undefined, { fresh })) || [])
  } catch {
    return []
  }
}

export async function listSupplyItems(fresh = false): Promise<SupplyItem[]> {
  return (await readTab(TAB_ITEMS, fresh))
    .map(r => ({
      item: S(r.item),
      category: S(r.category),
      vendor: S(r.vendor),
      // One cell, possibly several products -- some items are bought on
      // whichever of a few is cheapest or in stock that week.
      asins: S(r.asin).split(/[,;]/).map(x => x.trim()).filter(Boolean),
      url: S(r.url),
      packSize: S(r.packSize),
      notes: S(r.notes),
      status: S(r.status) || 'active',
      image: S(r.image),
      imageUrl: S(r.image) || asinThumb(S(r.asin).split(/[,;]/)[0].trim()),
    }))
    .filter(i => i.item)
}

/**
 * Replace the whole catalogue.
 *
 * Whole-tab replace, like saveOrderLines: the catalogue is a few dozen rows
 * edited as one screen, and a per-row upsert would need a stable id that the
 * item name already is.
 *
 * The header is the canonical columns FOLLOWED BY whatever else the tab
 * already had, and unknown fields are carried through per item. Somebody may
 * have added a column by hand; a save from this screen must not be the thing
 * that deletes it.
 *
 * The item name is the join key -- it must match the option text on the supply
 * order form exactly, or the order panel will not find the product. The editor
 * therefore offers form options rather than free text; this function only
 * refuses the empty name.
 */
export async function saveSupplyItems(items: SupplyItem[], by: string): Promise<number> {
  const raw = ((await readSheet(TAB_ITEMS, undefined, { fresh: true }).catch(() => [])) || []) as any[][]
  const { header, rows } = buildSupplyItemRows(raw, items, by)
  await writeSheet(TAB_ITEMS, [header, ...rows])
  return rows.length
}

/**
 * The row-building half of saveSupplyItems, split out so it can be tested
 * against the real tab's shape without writing to it. A whole-tab replace is
 * not something to first find out about in production.
 */
export function buildSupplyItemRows(
  raw: any[][], items: SupplyItem[], by: string, now = new Date().toISOString(),
): { header: string[]; rows: string[][] } {
  const existingHeader = ((raw && raw[0]) || []).map((h: any) => S(h)).filter(Boolean)
  const known = ITEM_COLUMNS as readonly string[]
  const header = [...ITEM_COLUMNS, ...existingHeader.filter(h => !known.includes(h))]

  // Anything already on the tab that this screen does not edit -- a column
  // somebody added by hand, and `category`, which the editor shows but does
  // not ask about. Blank incoming values fall back to these rather than
  // overwriting: a save must not be able to empty a field it never offered.
  const prior = new Map<string, Record<string, string>>()
  if (existingHeader.length) {
    for (const r of rowsToObjects(raw)) {
      const key = S(r.item).toLowerCase()
      if (key) prior.set(key, Object.fromEntries(header.map(c => [c, S(r[c])])))
    }
  }

  const seen = new Set<string>()
  const rows: string[][] = []
  for (const it of items) {
    const item = S(it.item)
    if (!item) continue
    const key = item.toLowerCase()
    if (seen.has(key)) continue      // a duplicated name would silently keep the last edit
    seen.add(key)
    const was = prior.get(key) || {}
    // Written every save, so a wrong ASIN can be traced to whoever typed it.
    const forced: Record<string, string> = { item, updatedAt: now, updatedBy: S(by) }
    const edited: Record<string, string> = {
      category: S(it.category),
      vendor: S(it.vendor),
      asin: (it.asins || []).map(a => S(a)).filter(Boolean).join(', '),
      url: S(it.url),
      packSize: S(it.packSize),
      notes: S(it.notes),
      status: S(it.status),
      image: S(it.image),
    }
    rows.push(header.map(c => {
      if (c in forced) return forced[c]
      // Deliberately not `|| was[c]` for every field: blanking notes, a URL or
      // an ASIN is a real edit somebody may mean to make. Only the fields the
      // editor does not put on screen fall back.
      if (c === 'category') return edited.category || was.category || ''
      if (c in edited) return edited[c] || (c === 'status' ? was.status || 'active' : '')
      return was[c] ?? ''
    }))
  }
  return { header, rows }
}

/** Quantities already decided for one submission, as item -> qty. */
export async function getOrderLines(submissionId: string): Promise<Record<string, number>> {
  const id = S(submissionId)
  if (!id) return {}
  const out: Record<string, number> = {}
  for (const r of await readTab(TAB_ORDERS, true)) {
    if (S(r.submissionId) !== id) continue
    const item = S(r.item)
    const qty = Number(r.qty)
    if (item && Number.isFinite(qty)) out[item] = qty
  }
  return out
}

/**
 * Replace the quantities for one submission.
 *
 * Whole-submission replace rather than per-line upsert: the office manager
 * saves a form, not a field, and a partial write would leave an order that is
 * half the previous decision and half this one. Rows for OTHER submissions are
 * carried through untouched.
 *
 * A qty of 0 is stored, not dropped -- "we decided none of this" is an answer,
 * and losing it would make the item look merely unconsidered next time.
 */
export async function saveOrderLines(
  submissionId: string, lines: OrderLine[], by: string,
): Promise<number> {
  const id = S(submissionId)
  if (!id) return 0

  const raw = ((await readSheet(TAB_ORDERS, undefined, { fresh: true }).catch(() => [])) || []) as any[][]
  const header = (raw[0] || []).map((h: any) => S(h))
  const cols = [...ORDER_COLUMNS]
  const now = new Date().toISOString()

  const others = header.length
    ? rowsToObjects(raw).filter(r => S(r.submissionId) !== id)
    : []

  const mine = lines
    .filter(l => S(l.item))
    .map(l => ({
      submissionId: id,
      item: S(l.item),
      qty: String(Math.max(0, Math.round(Number(l.qty) || 0))),
      updatedAt: now,
      updatedBy: by,
    }))

  const all = [...others, ...mine]
  await writeSheet(TAB_ORDERS, [
    cols, ...all.map((r: any) => cols.map(c => String(r[c] ?? ''))),
  ])
  return mine.length
}
