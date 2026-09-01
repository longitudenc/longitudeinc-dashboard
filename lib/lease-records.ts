// lib/lease-records.ts
// ---------------------------------------------------------------------------
// The structured half of the Lease Manager.
//
// lib/leases.ts stores DOCUMENTS. This stores what the documents SAY: term
// dates, rent, area, landlord, deposit — and separately the renewal options,
// because those are what the dashboard actually runs on.
//
// Options live in their own tab rather than as columns on the lease. A lease
// commonly carries three or four five-year options, each with its own notice
// deadline, and "option 1 notice by 2026-10-31" is the single most important
// fact in this whole feature: miss it and the option is gone. Flattening them
// into option1NoticeBy, option2NoticeBy… caps the count and makes the deadline
// scan a column sweep instead of a row filter.
//
// Everything is keyed on salonNum, which is also what a document carries, so a
// lease and its paperwork join without a second identifier.
//
// Dates are ISO yyyy-mm-dd strings throughout. They are compared as strings —
// correct for ISO, and it avoids a timezone turning a notice deadline into the
// day before.
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'

export const TAB_LEASES = 'Leases'
export const TAB_LEASE_OPTIONS = 'LeaseOptions'

export const LEASE_COLUMNS = [
  'leaseId', 'salonNum', 'locationName', 'landlord', 'address',
  'areaSqFt', 'commencementDate', 'expirationDate',
  'monthlyRent', 'camMonthly', 'securityDeposit',
  'status', 'note', 'updatedAt', 'updatedBy',
] as const

export const OPTION_COLUMNS = [
  'optionId', 'salonNum', 'optionNo', 'noticeBy',
  'effectiveFrom', 'effectiveTo', 'exercised', 'note',
] as const

export const LEASE_STATUSES = ['active', 'month-to-month', 'expired', 'terminated'] as const

export interface Lease {
  leaseId: string
  salonNum: string
  locationName: string
  landlord: string
  address: string
  areaSqFt: number
  commencementDate: string
  expirationDate: string
  monthlyRent: number
  camMonthly: number
  securityDeposit: number
  status: string
  note: string
  updatedAt: string
  updatedBy: string
}

export interface LeaseOption {
  optionId: string
  salonNum: string
  /** 1, 2, 3… so "Option 2" can be named without inferring it from order. */
  optionNo: number
  /** Written notice must reach the landlord BY this date. The whole point. */
  noticeBy: string
  effectiveFrom: string
  effectiveTo: string
  /** '' = undecided, 'yes' = exercised, 'no' = deliberately let go. */
  exercised: string
  note: string
}

const S = (v: unknown) => String(v ?? '').trim()
const N = (v: unknown) => {
  const x = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(x) ? x : 0
}

/** yyyy-mm-dd, or '' if it is not a date we can compare. */
export function normDate(v: unknown): string {
  const raw = S(v)
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const d = new Date(raw)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Today in Eastern time, as yyyy-mm-dd. Every salon is in NC. */
export function todayISO(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  return parts
}

/**
 * Whole months from `from` to `to`, rounded down, negative if `to` is past.
 * Used for "expires in 6 months", so approximate is fine and off-by-a-day
 * noise is not worth a date library.
 */
export function monthsBetween(from: string, to: string): number {
  if (!from || !to) return 0
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  let m = (ty - fy) * 12 + (tm - fm)
  if (td < fd) m -= 1
  return m
}

export function daysBetween(from: string, to: string): number {
  if (!from || !to) return 0
  const a = Date.parse(from + 'T00:00:00Z')
  const b = Date.parse(to + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86400000)
}

export function newId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function toLease(r: Record<string, any>): Lease {
  return {
    leaseId: S(r.leaseId),
    salonNum: S(r.salonNum),
    locationName: S(r.locationName),
    landlord: S(r.landlord),
    address: S(r.address),
    areaSqFt: N(r.areaSqFt),
    commencementDate: normDate(r.commencementDate),
    expirationDate: normDate(r.expirationDate),
    monthlyRent: N(r.monthlyRent),
    camMonthly: N(r.camMonthly),
    securityDeposit: N(r.securityDeposit),
    status: S(r.status) || 'active',
    note: S(r.note),
    updatedAt: S(r.updatedAt),
    updatedBy: S(r.updatedBy),
  }
}

function toOption(r: Record<string, any>): LeaseOption {
  return {
    optionId: S(r.optionId),
    salonNum: S(r.salonNum),
    optionNo: N(r.optionNo) || 1,
    noticeBy: normDate(r.noticeBy),
    effectiveFrom: normDate(r.effectiveFrom),
    effectiveTo: normDate(r.effectiveTo),
    exercised: S(r.exercised).toLowerCase(),
    note: S(r.note),
  }
}

/** A tab that does not exist yet is an empty list, not an error. */
async function readTab(tab: string, fresh = false): Promise<Record<string, any>[]> {
  try {
    return rowsToObjects((await readSheet(tab, undefined, { fresh })) || [])
  } catch {
    return []
  }
}

export async function listLeases(fresh = false): Promise<Lease[]> {
  return (await readTab(TAB_LEASES, fresh)).map(toLease).filter(l => l.salonNum)
}

export async function listOptions(fresh = false): Promise<LeaseOption[]> {
  return (await readTab(TAB_LEASE_OPTIONS, fresh))
    .map(toOption)
    .filter(o => o.salonNum)
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.optionNo - b.optionNo)
}

/**
 * Write one lease. Keyed on salonNum — a salon has one current lease, and
 * making that the key means re-saving cannot quietly create a duplicate that
 * then double-counts in every portfolio total.
 *
 * Read-modify-write over a shared tab, so it reads fresh. Same rule as
 * everywhere else in this codebase.
 */
export async function upsertLease(input: Partial<Lease> & { salonNum: string }, by: string): Promise<Lease> {
  const salonNum = S(input.salonNum)
  if (!salonNum) throw new Error('salonNum is required')

  const rows = await readTab(TAB_LEASES, true)
  const existing = rows.find(r => S(r.salonNum) === salonNum)
  const merged: Lease = {
    ...toLease(existing || {}),
    ...Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ) as Partial<Lease>,
    salonNum,
    leaseId: S(existing?.leaseId) || newId('ls'),
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  } as Lease

  // Re-normalise: values arrive from a form as strings.
  merged.areaSqFt = N(merged.areaSqFt)
  merged.monthlyRent = N(merged.monthlyRent)
  merged.camMonthly = N(merged.camMonthly)
  merged.securityDeposit = N(merged.securityDeposit)
  merged.commencementDate = normDate(merged.commencementDate)
  merged.expirationDate = normDate(merged.expirationDate)
  merged.status = S(merged.status) || 'active'

  const cols = [...LEASE_COLUMNS]
  const others = rows.filter(r => S(r.salonNum) !== salonNum).map(toLease)
  const all = [...others, merged].sort((a, b) => a.salonNum.localeCompare(b.salonNum))
  await writeSheet(TAB_LEASES, [cols, ...all.map(l => cols.map(c => String((l as any)[c] ?? '')))])
  return merged
}

export async function removeLease(salonNum: string): Promise<boolean> {
  const num = S(salonNum)
  const rows = await readTab(TAB_LEASES, true)
  const keep = rows.filter(r => S(r.salonNum) !== num)
  if (keep.length === rows.length) return false
  const cols = [...LEASE_COLUMNS]
  await writeSheet(TAB_LEASES, [cols, ...keep.map(toLease).map(l => cols.map(c => String((l as any)[c] ?? '')))])
  return true
}

/** Write one option. Keyed on optionId, so a salon may hold several. */
export async function upsertOption(input: Partial<LeaseOption> & { salonNum: string }, ): Promise<LeaseOption> {
  const salonNum = S(input.salonNum)
  if (!salonNum) throw new Error('salonNum is required')

  const rows = await readTab(TAB_LEASE_OPTIONS, true)
  const id = S(input.optionId)
  const existing = id ? rows.find(r => S(r.optionId) === id) : undefined
  const merged: LeaseOption = {
    ...toOption(existing || {}),
    ...Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ) as Partial<LeaseOption>,
    salonNum,
    optionId: S(existing?.optionId) || id || newId('op'),
  } as LeaseOption

  merged.optionNo = N(merged.optionNo) || 1
  merged.noticeBy = normDate(merged.noticeBy)
  merged.effectiveFrom = normDate(merged.effectiveFrom)
  merged.effectiveTo = normDate(merged.effectiveTo)
  merged.exercised = S(merged.exercised).toLowerCase()

  const cols = [...OPTION_COLUMNS]
  const others = rows.filter(r => S(r.optionId) !== merged.optionId).map(toOption)
  const all = [...others, merged]
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.optionNo - b.optionNo)
  await writeSheet(TAB_LEASE_OPTIONS, [cols, ...all.map(o => cols.map(c => String((o as any)[c] ?? '')))])
  return merged
}

export async function removeOption(optionId: string): Promise<boolean> {
  const id = S(optionId)
  const rows = await readTab(TAB_LEASE_OPTIONS, true)
  const keep = rows.filter(r => S(r.optionId) !== id)
  if (keep.length === rows.length) return false
  const cols = [...OPTION_COLUMNS]
  await writeSheet(TAB_LEASE_OPTIONS, [cols, ...keep.map(toOption).map(o => cols.map(c => String((o as any)[c] ?? '')))])
  return true
}

// ── What the dashboard is actually for ────────────────────────────────────

export interface ActionItem {
  kind: 'notice' | 'expiry'
  salonNum: string
  locationName: string
  /** The date being counted down to. */
  date: string
  daysAway: number
  monthsAway: number
  /** 'past' | 'urgent' (<= 60d) | 'soon' (<= 180d) */
  severity: 'past' | 'urgent' | 'soon'
  headline: string
  detail: string
}

/**
 * Everything with a date worth acting on, soonest first.
 *
 * A notice deadline that has PASSED is still reported. Silently dropping it
 * would hide the one failure this feature exists to prevent — and a deadline
 * missed last week is often still recoverable if someone notices today.
 */
export function actionItems(
  leases: Lease[],
  options: LeaseOption[],
  today: string,
  horizonMonths = 12,
): ActionItem[] {
  const out: ActionItem[] = []
  const nameOf = (salonNum: string) =>
    leases.find(l => l.salonNum === salonNum)?.locationName || ''

  const sev = (days: number): ActionItem['severity'] =>
    days < 0 ? 'past' : days <= 60 ? 'urgent' : 'soon'

  for (const o of options) {
    if (!o.noticeBy) continue
    if (o.exercised === 'yes' || o.exercised === 'no') continue   // decided
    const days = daysBetween(today, o.noticeBy)
    const months = monthsBetween(today, o.noticeBy)
    if (months > horizonMonths) continue
    out.push({
      kind: 'notice',
      salonNum: o.salonNum,
      locationName: nameOf(o.salonNum),
      date: o.noticeBy,
      daysAway: days,
      monthsAway: months,
      severity: sev(days),
      headline: days < 0
        ? `Renewal notice deadline PASSED (option ${o.optionNo})`
        : `Renewal notice deadline (option ${o.optionNo})`,
      detail: o.effectiveFrom
        ? `Notify the landlord in writing by ${o.noticeBy} to exercise the option effective ${o.effectiveFrom}.`
        : `Notify the landlord in writing by ${o.noticeBy} to exercise this option.`,
    })
  }

  for (const l of leases) {
    if (!l.expirationDate) continue
    if (l.status === 'terminated' || l.status === 'expired') continue
    const days = daysBetween(today, l.expirationDate)
    const months = monthsBetween(today, l.expirationDate)
    if (months > horizonMonths) continue
    out.push({
      kind: 'expiry',
      salonNum: l.salonNum,
      locationName: l.locationName,
      date: l.expirationDate,
      daysAway: days,
      monthsAway: months,
      severity: sev(days),
      headline: days < 0 ? 'Lease has EXPIRED' : 'Lease expires',
      detail: `Expiration date ${l.expirationDate}.`,
    })
  }

  return out.sort((a, b) => a.date.localeCompare(b.date))
}

export interface Portfolio {
  activeLeases: number
  expiringWithin12: number
  expiringWithin18: number
  totalAreaSqFt: number
  totalDeposits: number
  totalMonthly: number
  totalAnnual: number
  /** How many salons have a lease record at all — the honesty check. */
  recordsPresent: number
  recordsExpected: number
  missingSalons: string[]
}

export function portfolio(leases: Lease[], today: string, allSalons: string[]): Portfolio {
  const live = leases.filter(l => l.status === 'active' || l.status === 'month-to-month')
  const within = (l: Lease, months: number) =>
    !!l.expirationDate && monthsBetween(today, l.expirationDate) <= months

  return {
    activeLeases: live.length,
    expiringWithin12: live.filter(l => within(l, 12)).length,
    expiringWithin18: live.filter(l => within(l, 18)).length,
    totalAreaSqFt: live.reduce((s, l) => s + l.areaSqFt, 0),
    totalDeposits: live.reduce((s, l) => s + l.securityDeposit, 0),
    totalMonthly: live.reduce((s, l) => s + l.monthlyRent + l.camMonthly, 0),
    totalAnnual: live.reduce((s, l) => s + (l.monthlyRent + l.camMonthly) * 12, 0),
    recordsPresent: leases.length,
    recordsExpected: allSalons.length,
    missingSalons: allSalons.filter(n => !leases.some(l => l.salonNum === n)),
  }
}

/** Rent per square foot per year — the number every retail lease is judged on. */
export function rentPerSfYr(l: Lease): number {
  if (!l.areaSqFt) return 0
  return (l.monthlyRent * 12) / l.areaSqFt
}

/** How far through the term we are, 0–100. Blank dates give 0 rather than NaN. */
export function termProgress(l: Lease, today: string): number {
  if (!l.commencementDate || !l.expirationDate) return 0
  const total = daysBetween(l.commencementDate, l.expirationDate)
  if (total <= 0) return 0
  const gone = daysBetween(l.commencementDate, today)
  return Math.max(0, Math.min(100, (gone / total) * 100))
}
