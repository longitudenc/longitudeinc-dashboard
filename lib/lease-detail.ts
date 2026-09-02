// lib/lease-detail.ts
// ---------------------------------------------------------------------------
// Who to call, and what the lease actually says.
//
// lib/lease-records.ts holds the numbers — term, rent, area. This holds the two
// things the office asks about that no amount of arithmetic answers: the
// landlord's contacts, and the clauses ("can we assign it", "what's the use
// restriction", "who pays for the HVAC").
//
// Both are per-salon and deliberately free-form. Every landlord organises their
// paperwork differently — Regency bills CAM/tax/insurance/waste as four monthly
// escrow lines, Publix charges a single uncapped pro-rata share — and a rigid
// schema would mean dropping whatever did not fit.
//
// A clause row keeps BOTH a plain-English summary and the lease's own words, so
// the summary can always be checked against the source. That pairing is what
// makes the question box safe to trust.
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'

export const TAB_LEASE_CONTACTS = 'LeaseContacts'
export const TAB_LEASE_CLAUSES = 'LeaseClauses'

export const CONTACT_COLUMNS = [
  'contactId', 'salonNum', 'role', 'org', 'name', 'email', 'phone', 'address', 'note',
] as const

export const CLAUSE_COLUMNS = [
  'clauseId', 'salonNum', 'topic', 'summary', 'text', 'sourceDoc', 'section', 'note',
] as const

/** The questions that actually get asked. Free text is allowed. */
export const CLAUSE_TOPICS = [
  'Assignment', 'Use', 'Exclusive', 'Guaranty', 'CAM / Operating expenses',
  'Renewal', 'Holdover', 'Insurance', 'Notice', 'Percentage rent',
  'Maintenance', 'Signage', 'Default', 'Other',
] as const

export const CONTACT_ROLES = [
  'Landlord', 'Property manager', 'Billing', 'Maintenance', 'Broker', 'Legal', 'Other',
] as const

export interface LeaseContact {
  contactId: string
  salonNum: string
  role: string
  org: string
  name: string
  email: string
  phone: string
  address: string
  note: string
}

export interface LeaseClause {
  clauseId: string
  salonNum: string
  topic: string
  /** Plain English — what this means in practice. */
  summary: string
  /** The lease's own words, so the summary can be checked. */
  text: string
  sourceDoc: string
  section: string
  note: string
}

const S = (v: unknown) => String(v ?? '').trim()

function newId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** A tab that does not exist yet is an empty list, not an error. */
async function readTab(tab: string, fresh = false): Promise<Record<string, any>[]> {
  try {
    return rowsToObjects((await readSheet(tab, undefined, { fresh })) || [])
  } catch {
    return []
  }
}

function toContact(r: Record<string, any>): LeaseContact {
  return {
    contactId: S(r.contactId), salonNum: S(r.salonNum), role: S(r.role),
    org: S(r.org), name: S(r.name), email: S(r.email), phone: S(r.phone),
    address: S(r.address), note: S(r.note),
  }
}

function toClause(r: Record<string, any>): LeaseClause {
  return {
    clauseId: S(r.clauseId), salonNum: S(r.salonNum), topic: S(r.topic),
    summary: S(r.summary), text: S(r.text), sourceDoc: S(r.sourceDoc),
    section: S(r.section), note: S(r.note),
  }
}

export async function listContacts(fresh = false): Promise<LeaseContact[]> {
  return (await readTab(TAB_LEASE_CONTACTS, fresh)).map(toContact).filter(c => c.salonNum)
}

export async function listClauses(fresh = false): Promise<LeaseClause[]> {
  return (await readTab(TAB_LEASE_CLAUSES, fresh)).map(toClause).filter(c => c.salonNum)
}

export async function upsertContact(
  input: Partial<LeaseContact> & { salonNum: string },
): Promise<LeaseContact> {
  const salonNum = S(input.salonNum)
  if (!salonNum) throw new Error('salonNum is required')
  // Read fresh: read-modify-write over a shared tab.
  const rows = await readTab(TAB_LEASE_CONTACTS, true)
  const id = S(input.contactId)
  const existing = id ? rows.find(r => S(r.contactId) === id) : undefined
  const merged: LeaseContact = {
    ...toContact(existing || {}),
    ...(Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ) as Partial<LeaseContact>),
    salonNum,
    contactId: S(existing?.contactId) || id || newId('ct'),
  } as LeaseContact
  const cols = [...CONTACT_COLUMNS]
  const all = [...rows.filter(r => S(r.contactId) !== merged.contactId).map(toContact), merged]
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.role.localeCompare(b.role))
  await writeSheet(TAB_LEASE_CONTACTS, [cols, ...all.map(c => cols.map(k => String((c as any)[k] ?? '')))])
  return merged
}

export async function upsertClause(
  input: Partial<LeaseClause> & { salonNum: string },
): Promise<LeaseClause> {
  const salonNum = S(input.salonNum)
  if (!salonNum) throw new Error('salonNum is required')
  const rows = await readTab(TAB_LEASE_CLAUSES, true)
  const id = S(input.clauseId)
  const existing = id ? rows.find(r => S(r.clauseId) === id) : undefined
  const merged: LeaseClause = {
    ...toClause(existing || {}),
    ...(Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ) as Partial<LeaseClause>),
    salonNum,
    clauseId: S(existing?.clauseId) || id || newId('cl'),
  } as LeaseClause
  const cols = [...CLAUSE_COLUMNS]
  const all = [...rows.filter(r => S(r.clauseId) !== merged.clauseId).map(toClause), merged]
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.topic.localeCompare(b.topic))
  await writeSheet(TAB_LEASE_CLAUSES, [cols, ...all.map(c => cols.map(k => String((c as any)[k] ?? '')))])
  return merged
}

export async function removeContact(contactId: string): Promise<boolean> {
  const id = S(contactId)
  const rows = await readTab(TAB_LEASE_CONTACTS, true)
  const keep = rows.filter(r => S(r.contactId) !== id)
  if (keep.length === rows.length) return false
  const cols = [...CONTACT_COLUMNS]
  await writeSheet(TAB_LEASE_CONTACTS, [cols, ...keep.map(toContact).map(c => cols.map(k => String((c as any)[k] ?? '')))])
  return true
}

export async function removeClause(clauseId: string): Promise<boolean> {
  const id = S(clauseId)
  const rows = await readTab(TAB_LEASE_CLAUSES, true)
  const keep = rows.filter(r => S(r.clauseId) !== id)
  if (keep.length === rows.length) return false
  const cols = [...CLAUSE_COLUMNS]
  await writeSheet(TAB_LEASE_CLAUSES, [cols, ...keep.map(toClause).map(c => cols.map(k => String((c as any)[k] ?? '')))])
  return true
}

export interface AskResult {
  /** The salon the question named, '' if it named none. */
  salonNum: string
  hits: LeaseClause[]
  /** What was searched for, so the screen can say why it matched. */
  terms: string[]
}

/**
 * Answer a question like "what is the assignment clause for 1304".
 *
 * This is retrieval, NOT a language model. It pulls the salon number out of the
 * question, matches the rest against clause topics and text, and hands back the
 * clauses themselves — the lease's own words, with their source document named.
 *
 * That choice is deliberate. A model that paraphrases an assignment provision
 * and gets it subtly wrong is worse than useless here, because the answer looks
 * equally confident either way. This can only ever show text somebody recorded
 * from a real document, so it cannot invent a clause that does not exist.
 */
export function askClauses(
  question: string,
  clauses: LeaseClause[],
  salonNums: string[],
): AskResult {
  const q = String(question ?? '').toLowerCase()
  // A 3–4 digit run that IS one of our salons. Any other number is just a word.
  const salonNum = (q.match(/\b\d{3,4}\b/g) || []).find(n => salonNums.includes(n)) || ''

  const stop = new Set([
    'what', 'whats', 'is', 'the', 'for', 'of', 'in', 'on', 'a', 'an', 'my', 'our',
    'clause', 'clauses', 'salon', 'store', 'lease', 'does', 'say', 'says', 'about',
    'tell', 'me', 'show', 'and', 'to', 'at', 'can', 'we', 'do', 'have', 'there',
    'any', 'it', 'this', 'that', 'are', 'was', 'how', 'when', 'who', 'where',
  ])
  const terms = q.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(t => t.length > 2 && !stop.has(t) && !/^\d+$/.test(t))

  const pool = salonNum ? clauses.filter(c => c.salonNum === salonNum) : clauses
  if (!terms.length) return { salonNum, hits: pool, terms }

  const scored = pool
    .map(c => {
      const topic = c.topic.toLowerCase()
      const body = (c.summary + ' ' + c.text + ' ' + c.note).toLowerCase()
      let score = 0
      for (const t of terms) {
        // A topic match is what was actually asked for; body text is corroboration.
        if (topic.includes(t)) score += 10
        else if (body.includes(t)) score += 1
      }
      return { c, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)

  return { salonNum, hits: scored.map(x => x.c), terms }
}
