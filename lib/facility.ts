// lib/facility.ts
// ---------------------------------------------------------------------------
// FACILITY-TRACKER-v1
//
// Everything that is wrong with a building, from either direction: what a salon
// reports, and what a corporate facility review finds. One list, because they
// are the same work — a peeling front desk is a repair whether the manager
// noticed it or Erin Davidson did — and because the question that matters is
// "what is outstanding at 9689", not "which system told us".
//
// TWO CLASSES OF FINDING, kept apart because they carry different consequences.
// A Critical Brand Element triggers a compliance action on its own; an ordinary
// Action Required item only does at five. That rule is quoted in every review
// email, so it is modelled here rather than left in the reader's head.
//
// COMMENTS LIVE IN FormComments, the same tab the forms engine uses, keyed on
// the item id. A facility item is not a form submission, but the conversation
// on one is identical in shape and there is no reason for a second comment
// implementation, a second schema and a second set of bugs. Item ids are
// prefixed `fac_` so the two key spaces cannot collide.
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, appendSheet, rowsToObjects, tabExists, createTab } from '@/lib/sheets'
import { TAB_COMMENTS, COMMENT_COLUMNS } from '@/lib/forms'

export const TAB_FACILITY = 'FacilityItems'

export const FACILITY_COLUMNS = [
  'itemId', 'salonNum', 'salonName', 'source', 'sourceRef',
  'reviewDate', 'category', 'categoryLabel', 'component', 'detail',
  'status', 'dueDate', 'assignee', 'cost',
  'addedAt', 'addedBy', 'closedAt', 'closedBy', 'note',
] as const

/** open → in progress → fixed (photo sent for a green flag) → verified. */
export const FACILITY_STATUSES = ['open', 'in_progress', 'fixed', 'verified', 'waived'] as const
export type FacilityStatus = typeof FACILITY_STATUSES[number]
export const STATUS_LABEL: Record<string, string> = {
  open: 'Open', in_progress: 'In progress', fixed: 'Fixed — awaiting green flag',
  verified: 'Verified', waived: 'Waived',
}
/** The two that still count against the salon. */
export const OPEN_STATUSES = new Set(['open', 'in_progress'])

export interface FacilityItem {
  itemId: string
  salonNum: string
  salonName: string
  /** 'review' = corporate facility review · 'salon' = raised in-salon. */
  source: string
  /** The email subject, file name or form submission it came from. */
  sourceRef: string
  reviewDate: string
  category: 'critical' | 'action' | string
  categoryLabel: string
  component: string
  detail: string
  status: string
  dueDate: string
  assignee: string
  cost: number
  addedAt: string
  addedBy: string
  closedAt: string
  closedBy: string
  note: string
}

const S = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max)
const N = (v: unknown) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : 0 }

function toItem(o: Record<string, any>): FacilityItem {
  return {
    itemId: S(o.itemId, 60), salonNum: S(o.salonNum, 10), salonName: S(o.salonName, 120),
    source: S(o.source, 20) || 'review', sourceRef: S(o.sourceRef, 300),
    reviewDate: S(o.reviewDate, 10),
    category: (S(o.category, 20) === 'critical' ? 'critical' : 'action'),
    categoryLabel: S(o.categoryLabel, 80), component: S(o.component, 200),
    detail: S(o.detail, 4000),
    status: (FACILITY_STATUSES as readonly string[]).includes(S(o.status, 20)) ? S(o.status, 20) : 'open',
    dueDate: S(o.dueDate, 10), assignee: S(o.assignee, 120), cost: N(o.cost),
    addedAt: S(o.addedAt, 40), addedBy: S(o.addedBy, 120),
    closedAt: S(o.closedAt, 40), closedBy: S(o.closedBy, 120), note: S(o.note, 2000),
  }
}

export async function listFacility(fresh = false): Promise<FacilityItem[]> {
  const rows = await readSheet(TAB_FACILITY, undefined, fresh ? { fresh: true } : undefined)
  if (!rows || !rows.length) return []
  return rowsToObjects(rows).map(toItem).filter(i => i.itemId && i.salonNum)
}

async function writeAll(items: FacilityItem[]): Promise<void> {
  const cols = FACILITY_COLUMNS as unknown as string[]
  await writeSheet(TAB_FACILITY, [cols, ...items.map(i => cols.map(c => String((i as any)[c] ?? '')))])
}

const newId = () => 'fac_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

/**
 * Add a review's worth of items.
 *
 * Keyed on salon + review date + component, so re-loading the same email does
 * not double the list. A component that is already there keeps its status and
 * its comments — re-importing must never quietly reopen something that has
 * been fixed, or the tracker punishes you for checking your work.
 */
export async function addItems(
  input: Partial<FacilityItem>[], by: string,
): Promise<{ added: FacilityItem[]; skipped: number }> {
  if (!(await tabExists(TAB_FACILITY))) await createTab(TAB_FACILITY)
  const all = await listFacility(true)
  const seen = new Set(all.map(i => [i.salonNum, i.reviewDate, i.component.toLowerCase()].join('|')))

  const now = new Date().toISOString()
  const added: FacilityItem[] = []
  let skipped = 0
  for (const raw of input) {
    const it = toItem({ ...raw, itemId: newId(), addedAt: now, addedBy: by })
    if (!it.salonNum || !it.component) { skipped++; continue }
    const key = [it.salonNum, it.reviewDate, it.component.toLowerCase()].join('|')
    if (seen.has(key)) { skipped++; continue }
    seen.add(key)
    added.push(it)
  }
  if (added.length) {
    const cols = FACILITY_COLUMNS as unknown as string[]
    await appendSheet(TAB_FACILITY, added.map(i => cols.map(c => String((i as any)[c] ?? ''))))
  }
  return { added, skipped }
}

export async function updateItem(
  itemId: string, patch: Partial<FacilityItem>, by: string,
): Promise<FacilityItem | null> {
  const all = await listFacility(true)
  const idx = all.findIndex(i => i.itemId === itemId)
  if (idx < 0) return null
  const before = all[idx]
  const next = toItem({ ...before, ...patch, itemId: before.itemId })
  // Closing stamps who and when; reopening clears it, so the stamp never
  // describes a state the item is no longer in.
  const wasOpen = OPEN_STATUSES.has(before.status)
  const nowOpen = OPEN_STATUSES.has(next.status)
  if (wasOpen && !nowOpen) { next.closedAt = new Date().toISOString(); next.closedBy = by }
  if (!wasOpen && nowOpen) { next.closedAt = ''; next.closedBy = '' }
  all[idx] = next
  await writeAll(all)
  return next
}

export async function removeItem(itemId: string): Promise<boolean> {
  const all = await listFacility(true)
  const keep = all.filter(i => i.itemId !== itemId)
  if (keep.length === all.length) return false
  await writeAll(keep)
  return true
}

// ── comments, on the forms engine's tab ──────────────────────────────────
export interface FacilityComment {
  id: string; submissionId: string; author: string; authorRole: string
  body: string; createdAt: string
}

export async function listComments(itemIds: string[]): Promise<Record<string, FacilityComment[]>> {
  const want = new Set(itemIds)
  const out: Record<string, FacilityComment[]> = {}
  try {
    const rows = rowsToObjects(await readSheet(TAB_COMMENTS))
    for (const r of rows) {
      const sid = S(r.submissionId, 60)
      if (!want.has(sid)) continue
      ;(out[sid] ||= []).push({
        id: S(r.id, 60), submissionId: sid, author: S(r.author, 120),
        authorRole: S(r.authorRole, 40), body: S(r.body, 4000), createdAt: S(r.createdAt, 40),
      })
    }
  } catch { /* no comments tab yet */ }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return out
}

export async function addComment(o: {
  itemId: string; author: string; authorRole: string; body: string
}): Promise<FacilityComment> {
  if (!(await tabExists(TAB_COMMENTS))) await createTab(TAB_COMMENTS)
  const row: FacilityComment = {
    id: 'fc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    submissionId: S(o.itemId, 60),
    author: S(o.author, 120), authorRole: S(o.authorRole, 40),
    body: S(o.body, 4000), createdAt: new Date().toISOString(),
  }
  const cols = COMMENT_COLUMNS as unknown as string[]
  await appendSheet(TAB_COMMENTS, [cols.map(c => String((row as any)[c] ?? ''))])
  return row
}

// ── what a salon looks like right now ────────────────────────────────────
export interface SalonFacility {
  salonNum: string
  openCritical: number
  openAction: number
  overdue: number
  /** The compliance rule the review emails quote, applied to what is still open. */
  compliance: boolean
  nextDue: string
  total: number
}

export function summarise(items: FacilityItem[], todayIso: string): SalonFacility[] {
  const by = new Map<string, FacilityItem[]>()
  for (const i of items) (by.get(i.salonNum) ?? by.set(i.salonNum, []).get(i.salonNum)!).push(i)
  return [...by.entries()].map(([salonNum, list]) => {
    const open = list.filter(i => OPEN_STATUSES.has(i.status))
    const openCritical = open.filter(i => i.category === 'critical').length
    const openAction = open.length - openCritical
    const due = open.map(i => i.dueDate).filter(Boolean).sort()
    return {
      salonNum,
      openCritical, openAction,
      overdue: open.filter(i => i.dueDate && i.dueDate < todayIso).length,
      compliance: openCritical > 0 || openAction >= 5,
      nextDue: due[0] || '',
      total: list.length,
    }
  }).sort((a, b) => (parseInt(a.salonNum, 10) || 0) - (parseInt(b.salonNum, 10) || 0))
}
