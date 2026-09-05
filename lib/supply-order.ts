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
}

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
    }))
    .filter(i => i.item)
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
