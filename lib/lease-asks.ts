// lib/lease-asks.ts
// ---------------------------------------------------------------------------
// The renegotiation punch list.
//
// lib/lease-records.ts holds the numbers, lib/lease-detail.ts holds what the
// documents SAY. This holds what is WRONG with what they say, and what to ask
// for instead — so that walking into a renewal means opening one page rather
// than re-reading a lease.
//
// Three things make a row worth having:
//
//   1. `current`   — the term as it stands, in one sentence.
//   2. `ask`       — what to request. Not "improve the CAM clause" but the
//                    actual words to put in front of the landlord.
//   3. `precedent` — WHICH OF OUR OWN LEASES already has the better language.
//                    This is the whole point. "Publix agreed to this at Mint
//                    Hill last year" is an argument a landlord has to answer;
//                    "we would prefer a cap" is not. A landlord can dismiss a
//                    preference. It is much harder to dismiss a clause the
//                    same tenant already signed somewhere else.
//
// Ordering is by WHEN THE CONVERSATION HAPPENS, not by severity: an urgent ask
// on a lease that runs to 2035 is not urgent yet. See renegotiationPlan().
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'
import { normDate, daysBetween, type Lease, type LeaseOption } from '@/lib/lease-records'

export const TAB_LEASE_ASKS = 'LeaseAsks'

export const ASK_COLUMNS = [
  'askId', 'salonNum', 'issue', 'topic', 'severity',
  'current', 'ask', 'precedent', 'status', 'note',
] as const

/**
 * How much it matters. Deliberately only three levels — a five-point scale
 * invites arguing about the middle instead of deciding what to raise.
 *
 *   high    money, or a term that can cost the lease (a deemed termination,
 *           an option that can be forfeited by something outside our control)
 *   medium  worth asking for, would not walk away over it
 *   low     tidy-up; ask if the conversation is going well
 */
export const ASK_SEVERITIES = ['high', 'medium', 'low'] as const

/** '' means open and unraised — the normal state until a renewal starts. */
export const ASK_STATUSES = ['', 'raised', 'won', 'conceded', 'dropped'] as const

export interface LeaseAsk {
  askId: string
  salonNum: string
  /** Short label, reused across salons so the same problem groups together. */
  issue: string
  /** One of CLAUSE_TOPICS where it maps, so the ask sits next to the clause. */
  topic: string
  severity: string
  current: string
  ask: string
  /** Salon numbers whose leases already carry the better wording. */
  precedent: string
  status: string
  note: string
}

const S = (v: unknown) => String(v ?? '').trim()

function newId(): string {
  return 'ak_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** A tab that does not exist yet is an empty list, not an error. */
async function readTab(fresh = false): Promise<Record<string, any>[]> {
  try {
    return rowsToObjects((await readSheet(TAB_LEASE_ASKS, undefined, { fresh })) || [])
  } catch {
    return []
  }
}

function toAsk(r: Record<string, any>): LeaseAsk {
  return {
    askId: S(r.askId),
    salonNum: S(r.salonNum),
    issue: S(r.issue),
    topic: S(r.topic),
    severity: S(r.severity).toLowerCase() || 'medium',
    current: S(r.current),
    ask: S(r.ask),
    precedent: S(r.precedent),
    status: S(r.status).toLowerCase(),
    note: S(r.note),
  }
}

const rank = (sev: string) => (sev === 'high' ? 0 : sev === 'medium' ? 1 : 2)

export async function listAsks(fresh = false): Promise<LeaseAsk[]> {
  return (await readTab(fresh))
    .map(toAsk)
    .filter(a => a.salonNum && a.issue)
    .sort((a, b) =>
      (Number(a.salonNum) || 0) - (Number(b.salonNum) || 0) ||
      rank(a.severity) - rank(b.severity) ||
      a.issue.localeCompare(b.issue))
}

/** Write one ask. Keyed on askId; read-modify-write, so it reads fresh. */
export async function upsertAsk(input: Partial<LeaseAsk> & { salonNum: string }): Promise<LeaseAsk> {
  const salonNum = S(input.salonNum)
  if (!salonNum) throw new Error('salonNum is required')
  const rows = await readTab(true)
  const id = S(input.askId)
  const existing = id ? rows.find(r => S(r.askId) === id) : undefined
  const merged: LeaseAsk = {
    ...toAsk(existing || {}),
    ...(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<LeaseAsk>),
    salonNum,
    askId: S(existing?.askId) || id || newId(),
  } as LeaseAsk
  merged.severity = S(merged.severity).toLowerCase() || 'medium'
  merged.status = S(merged.status).toLowerCase()

  const cols = [...ASK_COLUMNS]
  const all = [...rows.filter(r => S(r.askId) !== merged.askId).map(toAsk), merged]
    .sort((a, b) => (Number(a.salonNum) || 0) - (Number(b.salonNum) || 0) || rank(a.severity) - rank(b.severity))
  await writeSheet(TAB_LEASE_ASKS, [cols, ...all.map(x => cols.map(k => String((x as any)[k] ?? '')))])
  return merged
}

export async function removeAsk(askId: string): Promise<boolean> {
  const rows = await readTab(true)
  const keep = rows.filter(r => S(r.askId) !== S(askId))
  if (keep.length === rows.length) return false
  const cols = [...ASK_COLUMNS]
  await writeSheet(TAB_LEASE_ASKS, [cols, ...keep.map(toAsk).map(x => cols.map(k => String((x as any)[k] ?? '')))])
  return true
}

// ── When the conversation actually happens ────────────────────────────────

export interface SalonPlan {
  salonNum: string
  locationName: string
  /** The date the next negotiation is driven by, '' when nothing is known. */
  nextDate: string
  /** 'notice' when a renewal notice deadline comes first, else 'expiry'. */
  nextKind: 'notice' | 'expiry' | 'none'
  daysAway: number | null
  expirationDate: string
  openHigh: number
  openTotal: number
  asks: LeaseAsk[]
}

/**
 * Every salon with something to ask for, ordered by when it will be asked.
 *
 * The ordering date is the EARLIER of the next undecided renewal-notice
 * deadline and the lease expiry, because whichever comes first is the moment
 * the landlord is listening. A salon with a live notice deadline in eight
 * months outranks one with worse terms that runs to 2035 — the second is a
 * better lease to fix and a worse use of this month.
 *
 * Salons with no lease record and no dates sort last rather than first: an
 * unknown date is not an imminent one.
 */
export function renegotiationPlan(
  asks: LeaseAsk[],
  leases: Lease[],
  options: LeaseOption[],
  today: string,
): SalonPlan[] {
  const bySalon = new Map<string, LeaseAsk[]>()
  for (const a of asks) {
    if (!bySalon.has(a.salonNum)) bySalon.set(a.salonNum, [])
    bySalon.get(a.salonNum)!.push(a)
  }

  const out: SalonPlan[] = []
  for (const [salonNum, mine] of bySalon) {
    const lease = leases.find(l => l.salonNum === salonNum)
    const notices = options
      .filter(o => o.salonNum === salonNum && o.noticeBy && o.exercised !== 'yes' && o.exercised !== 'no')
      .map(o => normDate(o.noticeBy))
      .filter(Boolean)
      .sort()
    const soonestNotice = notices[0] || ''
    const expiry = lease ? lease.expirationDate : ''

    let nextDate = ''
    let nextKind: SalonPlan['nextKind'] = 'none'
    if (soonestNotice && expiry) {
      nextDate = soonestNotice <= expiry ? soonestNotice : expiry
      nextKind = soonestNotice <= expiry ? 'notice' : 'expiry'
    } else if (soonestNotice) { nextDate = soonestNotice; nextKind = 'notice' }
    else if (expiry) { nextDate = expiry; nextKind = 'expiry' }

    const open = mine.filter(a => a.status !== 'won' && a.status !== 'dropped')
    out.push({
      salonNum,
      locationName: lease ? lease.locationName : '',
      nextDate,
      nextKind,
      daysAway: nextDate ? daysBetween(today, nextDate) : null,
      expirationDate: expiry,
      openHigh: open.filter(a => a.severity === 'high').length,
      openTotal: open.length,
      asks: mine.slice().sort((a, b) => rank(a.severity) - rank(b.severity) || a.issue.localeCompare(b.issue)),
    })
  }

  // Soonest conversation first; anything with no date at all goes last.
  return out.sort((a, b) => {
    if (!a.nextDate && !b.nextDate) return (Number(a.salonNum) || 0) - (Number(b.salonNum) || 0)
    if (!a.nextDate) return 1
    if (!b.nextDate) return -1
    return a.nextDate.localeCompare(b.nextDate)
  })
}

export interface IssueGroup {
  issue: string
  topic: string
  severity: string
  /** Salons that have the problem. */
  salons: string[]
  /** Salons already carrying better language, deduped across every row. */
  precedents: string[]
  /** The clearest statement of the ask, taken from the highest-severity row. */
  ask: string
}

/**
 * The same problem, seen across the portfolio.
 *
 * This is the view that turns fifteen separate leases into leverage: it shows
 * that six salons have no exclusive and that three landlords have already
 * given us one, so the ask stops being aspirational and becomes a pattern.
 */
export function issueGroups(asks: LeaseAsk[]): IssueGroup[] {
  const byIssue = new Map<string, LeaseAsk[]>()
  for (const a of asks) {
    const key = a.issue.toLowerCase()
    if (!byIssue.has(key)) byIssue.set(key, [])
    byIssue.get(key)!.push(a)
  }

  const out: IssueGroup[] = []
  for (const rows of byIssue.values()) {
    const worst = rows.slice().sort((a, b) => rank(a.severity) - rank(b.severity))[0]
    const precedents = new Set<string>()
    for (const r of rows) {
      for (const p of r.precedent.split(/[,;/]/).map(x => x.trim()).filter(Boolean)) precedents.add(p)
    }
    out.push({
      issue: worst.issue,
      topic: worst.topic,
      severity: worst.severity,
      salons: [...new Set(rows.map(r => r.salonNum))].sort((a, b) => (Number(a) || 0) - (Number(b) || 0)),
      precedents: [...precedents].sort((a, b) => (Number(a) || 0) - (Number(b) || 0)),
      ask: worst.ask,
    })
  }

  // Worst first, then whichever affects most salons — that is the order you
  // would work through them in if you were fixing the portfolio rather than
  // one lease.
  return out.sort((a, b) =>
    rank(a.severity) - rank(b.severity) ||
    b.salons.length - a.salons.length ||
    a.issue.localeCompare(b.issue))
}
