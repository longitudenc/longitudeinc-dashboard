// lib/lease-notices.ts
// ---------------------------------------------------------------------------
// Scheduled reminders, and the ledger of which ones have been sent.
//
// The daily alert in app/api/cron/lease-alerts already reports anything inside
// a rolling window — a rent step within 35 days, a notice deadline within 120,
// an expiry within 180. That is a running status, and it repeats every day.
//
// This is a different thing: a MILESTONE that fires ONCE, on a date computed
// backwards from the deadline it protects.
//
//   Lease expiry        12 months out, then 9 months out
//   Option notice        3 months out, then 1 month out
//
// The two horizons differ because the decisions differ. A lease with no option
// left is a negotiation, and a year is roughly how long it takes to open one,
// walk the site, price alternatives and get paper drawn. An option deadline is
// a letter someone has to post, so three months is ample and one month is the
// last honest chance.
//
// FIRING ONCE IS THE WHOLE POINT, so a sent milestone is written to a sheet
// tab. Without that ledger a daily cron either spams the same reminder for
// three months — which trains everyone to ignore it — or fires on an exact
// date and is lost forever if that run fails.
//
// Two consequences of the ledger worth knowing:
//
//   1. A milestone missed because the feature did not exist yet, or because
//      the cron was down, still fires on the next run. It is late, but it is
//      not lost.
//   2. When several milestones for the same deadline are overdue at once, only
//      the LATEST is sent and the earlier ones are marked superseded. Telling
//      someone "12 months to go" when it is really seven is worse than
//      silence — see dueNow().
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'
import { normDate, daysBetween, type Lease, type LeaseOption } from '@/lib/lease-records'

export const TAB_LEASE_NOTICES = 'LeaseNotices'

export const NOTICE_COLUMNS = [
  'noticeId', 'salonNum', 'kind', 'months', 'targetDate', 'dueDate',
  'sentAt', 'sentTo', 'status', 'note',
] as const

/** Months before a lease expires. Long, because this is a negotiation. */
export const EXPIRY_MILESTONES = [12, 9] as const

/** Months before an option notice deadline. Short, because this is a letter. */
export const OPTION_MILESTONES = [3, 1] as const

export interface Milestone {
  /** Stable across runs, so the ledger can be keyed on it. */
  key: string
  salonNum: string
  locationName: string
  kind: 'expiry' | 'notice'
  months: number
  /** The deadline being protected. */
  targetDate: string
  /** The date this reminder should fire. */
  dueDate: string
  daysUntilDue: number
  daysUntilTarget: number
  optionNo: number
  /** Filled from the ledger: '' when never sent. */
  sentAt: string
  status: string
}

const S = (v: unknown) => String(v ?? '').trim()
const p2 = (n: number) => String(n).padStart(2, '0')

/**
 * N months before an ISO date, clamping the day to the shorter month.
 *
 * Nine months before 31 March is 30 June, not an invalid 31 June — which is
 * what `new Date()` arithmetic would silently roll forward into July.
 */
export function minusMonths(iso: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ''
  const [y, m, d] = iso.split('-').map(Number)
  let ty = y
  let tm = m - months
  while (tm <= 0) { tm += 12; ty -= 1 }
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  return `${ty}-${p2(tm)}-${p2(Math.min(d, lastDay))}`
}

/** A tab that does not exist yet is an empty ledger, not an error. */
async function readTab(fresh = false): Promise<Record<string, any>[]> {
  try {
    return rowsToObjects((await readSheet(TAB_LEASE_NOTICES, undefined, { fresh })) || [])
  } catch {
    return []
  }
}

/** Every milestone already written to the ledger, keyed by noticeId. */
export async function sentLedger(fresh = false): Promise<Map<string, { sentAt: string; status: string }>> {
  const out = new Map<string, { sentAt: string; status: string }>()
  for (const r of await readTab(fresh)) {
    const id = S(r.noticeId)
    if (id) out.set(id, { sentAt: S(r.sentAt), status: S(r.status) })
  }
  return out
}

/**
 * Every milestone the current records imply, sent or not.
 *
 * Options that have been decided are skipped — a notice deadline for an option
 * already exercised or declined protects nothing. Leases that are terminated
 * or already recorded as expired are skipped for the same reason.
 */
export function milestonesFor(
  leases: Lease[],
  options: LeaseOption[],
  today: string,
  ledger?: Map<string, { sentAt: string; status: string }>,
): Milestone[] {
  const out: Milestone[] = []
  const nameOf = (salonNum: string) =>
    leases.find(l => l.salonNum === salonNum)?.locationName || ''

  const add = (
    salonNum: string, kind: Milestone['kind'], months: number,
    targetDate: string, optionNo: number,
  ) => {
    const dueDate = minusMonths(targetDate, months)
    if (!dueDate) return
    const key = `${salonNum}|${kind}|${targetDate}|${months}`
    const seen = ledger?.get(key)
    out.push({
      key, salonNum, locationName: nameOf(salonNum), kind, months,
      targetDate, dueDate,
      daysUntilDue: daysBetween(today, dueDate),
      daysUntilTarget: daysBetween(today, targetDate),
      optionNo,
      sentAt: seen ? seen.sentAt : '',
      status: seen ? seen.status : '',
    })
  }

  for (const l of leases) {
    if (l.status === 'terminated' || l.status === 'expired') continue
    const target = normDate(l.expirationDate)
    if (!target) continue
    for (const m of EXPIRY_MILESTONES) add(l.salonNum, 'expiry', m, target, 0)
  }

  for (const o of options) {
    if (o.exercised === 'yes' || o.exercised === 'no') continue
    const target = normDate(o.noticeBy)
    if (!target) continue
    for (const m of OPTION_MILESTONES) add(o.salonNum, 'notice', m, target, o.optionNo)
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.salonNum.localeCompare(b.salonNum))
}

export interface DueResult {
  /** Send an email for these. */
  send: Milestone[]
  /**
   * Record these as sent without emailing. They are earlier milestones for a
   * deadline whose later milestone is also overdue — saying "a year to go"
   * when it is seven months would be worse than saying nothing.
   */
  supersede: Milestone[]
}

/**
 * What to send today.
 *
 * A milestone is due when its dueDate has arrived, its deadline has NOT yet
 * passed, and the ledger has no record of it. Where several are due for the
 * same deadline, only the latest — the smallest number of months — is sent.
 */
export function dueNow(milestones: Milestone[], today: string): DueResult {
  const live = milestones.filter(m =>
    !m.sentAt &&
    m.dueDate <= today &&
    m.targetDate >= today)

  const byTarget = new Map<string, Milestone[]>()
  for (const m of live) {
    const k = `${m.salonNum}|${m.kind}|${m.targetDate}`
    if (!byTarget.has(k)) byTarget.set(k, [])
    byTarget.get(k)!.push(m)
  }

  const send: Milestone[] = []
  const supersede: Milestone[] = []
  for (const group of byTarget.values()) {
    group.sort((a, b) => a.months - b.months)   // latest milestone first
    send.push(group[0])
    supersede.push(...group.slice(1))
  }

  const order = (m: Milestone) => m.targetDate
  return {
    send: send.sort((a, b) => order(a).localeCompare(order(b))),
    supersede,
  }
}

/**
 * Append to the ledger. Read-modify-write over a shared tab, so it reads fresh.
 *
 * Called only after the email has actually gone out — recording first and
 * failing to send would lose the reminder permanently, which is the one
 * outcome this whole file exists to prevent.
 */
export async function recordSent(
  entries: { milestone: Milestone; status: string; sentTo: string; note?: string }[],
): Promise<number> {
  if (!entries.length) return 0
  const rows = await readTab(true)
  const cols = [...NOTICE_COLUMNS]
  const existing = new Set(rows.map(r => S(r.noticeId)))
  const now = new Date().toISOString()

  const fresh = entries
    .filter(e => !existing.has(e.milestone.key))
    .map(e => ({
      noticeId: e.milestone.key,
      salonNum: e.milestone.salonNum,
      kind: e.milestone.kind,
      months: e.milestone.months,
      targetDate: e.milestone.targetDate,
      dueDate: e.milestone.dueDate,
      sentAt: now,
      sentTo: e.sentTo,
      status: e.status,
      note: e.note || '',
    }))
  if (!fresh.length) return 0

  const keep = rows.map(r => cols.map(c => S(r[c])))
  await writeSheet(TAB_LEASE_NOTICES, [
    cols, ...keep, ...fresh.map(f => cols.map(c => String((f as any)[c] ?? ''))),
  ])
  return fresh.length
}

/** How a milestone reads in an email or on screen. */
export function milestoneHeadline(m: Milestone): string {
  const when = m.months === 1 ? 'One month' : `${m.months} months`
  return m.kind === 'expiry'
    ? `${when} until the lease expires`
    : `${when} until the option ${m.optionNo ? m.optionNo + ' ' : ''}notice deadline`
}
