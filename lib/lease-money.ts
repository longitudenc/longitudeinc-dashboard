// lib/lease-money.ts
// ---------------------------------------------------------------------------
// The two things that change on a schedule: rent, and the NNN escrow.
//
// Both were living in a lease record's free-text notes, which is fine for
// reading and useless for anything else. A note cannot tell you that 2554's
// rent steps up on 1 June, or that 3025 has no CAM figure for 2026. These two
// tabs make those facts queryable, which is what the alerts and the gap report
// are built on — and what document abstraction writes into.
//
//   RentSteps    one row per rent period. Retail leases step annually; an
//                amendment replaces the schedule wholesale.
//   LeaseCharges one row per salon per YEAR. Landlords send a reconciliation
//                or escrow letter each autumn with next year's monthly
//                amounts, broken into CAM / tax / insurance / waste. Keeping
//                the components is the point: a total alone cannot be checked
//                against the letter, and the office reconciles by component.
//
// A missing row here is a real finding, not an inconvenience — see gaps() at
// the bottom. "No rent step covers today" almost always means an amendment was
// signed and never recorded.
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'
import { normDate, daysBetween, monthsBetween, type Lease } from '@/lib/lease-records'

export const TAB_RENT_STEPS = 'RentSteps'
export const TAB_LEASE_CHARGES = 'LeaseCharges'

export const RENT_STEP_COLUMNS = [
  'stepId', 'salonNum', 'startDate', 'endDate', 'monthlyRent', 'source', 'note',
] as const

export const CHARGE_COLUMNS = [
  'chargeId', 'salonNum', 'year', 'effectiveFrom',
  'cam', 'tax', 'insurance', 'waste', 'other', 'source', 'note',
] as const

export interface RentStep {
  stepId: string
  salonNum: string
  startDate: string
  endDate: string
  monthlyRent: number
  source: string
  note: string
}

export interface LeaseCharge {
  chargeId: string
  salonNum: string
  year: number
  effectiveFrom: string
  cam: number
  tax: number
  insurance: number
  waste: number
  other: number
  source: string
  note: string
}

const S = (v: unknown) => String(v ?? '').trim()
const N = (v: unknown) => {
  const x = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(x) ? x : 0
}
const newId = (p: string) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

async function readTab(tab: string, fresh = false): Promise<Record<string, any>[]> {
  try {
    return rowsToObjects((await readSheet(tab, undefined, { fresh })) || [])
  } catch {
    return []
  }
}

const toStep = (r: Record<string, any>): RentStep => ({
  stepId: S(r.stepId), salonNum: S(r.salonNum),
  startDate: normDate(r.startDate), endDate: normDate(r.endDate),
  monthlyRent: N(r.monthlyRent), source: S(r.source), note: S(r.note),
})

const toCharge = (r: Record<string, any>): LeaseCharge => ({
  chargeId: S(r.chargeId), salonNum: S(r.salonNum),
  year: N(r.year), effectiveFrom: normDate(r.effectiveFrom),
  cam: N(r.cam), tax: N(r.tax), insurance: N(r.insurance),
  waste: N(r.waste), other: N(r.other), source: S(r.source), note: S(r.note),
})

/** Every component added up — what actually gets billed each month. */
export function chargeTotal(c: LeaseCharge): number {
  return Math.round((c.cam + c.tax + c.insurance + c.waste + c.other) * 100) / 100
}

export async function listSteps(fresh = false): Promise<RentStep[]> {
  return (await readTab(TAB_RENT_STEPS, fresh)).map(toStep).filter(s => s.salonNum)
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.startDate.localeCompare(b.startDate))
}

export async function listCharges(fresh = false): Promise<LeaseCharge[]> {
  return (await readTab(TAB_LEASE_CHARGES, fresh)).map(toCharge).filter(c => c.salonNum)
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.year - b.year)
}

export async function upsertStep(input: Partial<RentStep> & { salonNum: string }): Promise<RentStep> {
  const salonNum = S(input.salonNum)
  if (!salonNum) throw new Error('salonNum is required')
  const rows = await readTab(TAB_RENT_STEPS, true)      // read-modify-write
  const id = S(input.stepId)
  const existing = id ? rows.find(r => S(r.stepId) === id) : undefined
  const merged: RentStep = {
    ...toStep(existing || {}),
    ...(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<RentStep>),
    salonNum,
    stepId: S(existing?.stepId) || id || newId('rs'),
  } as RentStep
  merged.startDate = normDate(merged.startDate)
  merged.endDate = normDate(merged.endDate)
  merged.monthlyRent = N(merged.monthlyRent)
  const cols = [...RENT_STEP_COLUMNS]
  const all = [...rows.filter(r => S(r.stepId) !== merged.stepId).map(toStep), merged]
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.startDate.localeCompare(b.startDate))
  await writeSheet(TAB_RENT_STEPS, [cols, ...all.map(x => cols.map(k => String((x as any)[k] ?? '')))])
  return merged
}

export async function upsertCharge(input: Partial<LeaseCharge> & { salonNum: string }): Promise<LeaseCharge> {
  const salonNum = S(input.salonNum)
  if (!salonNum) throw new Error('salonNum is required')
  const rows = await readTab(TAB_LEASE_CHARGES, true)
  const id = S(input.chargeId)
  // Keyed on salon+year when no id is given: a landlord sends ONE schedule per
  // year, so re-recording it must replace rather than duplicate.
  const existing = id
    ? rows.find(r => S(r.chargeId) === id)
    : rows.find(r => S(r.salonNum) === salonNum && N(r.year) === N(input.year))
  const merged: LeaseCharge = {
    ...toCharge(existing || {}),
    ...(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<LeaseCharge>),
    salonNum,
    chargeId: S(existing?.chargeId) || id || newId('ch'),
  } as LeaseCharge
  merged.year = N(merged.year)
  merged.effectiveFrom = normDate(merged.effectiveFrom) || (merged.year ? `${merged.year}-01-01` : '')
  for (const k of ['cam', 'tax', 'insurance', 'waste', 'other'] as const) merged[k] = N(merged[k])
  const cols = [...CHARGE_COLUMNS]
  const all = [...rows.filter(r => S(r.chargeId) !== merged.chargeId).map(toCharge), merged]
    .sort((a, b) => a.salonNum.localeCompare(b.salonNum) || a.year - b.year)
  await writeSheet(TAB_LEASE_CHARGES, [cols, ...all.map(x => cols.map(k => String((x as any)[k] ?? '')))])
  return merged
}

export async function removeStep(stepId: string): Promise<boolean> {
  const rows = await readTab(TAB_RENT_STEPS, true)
  const keep = rows.filter(r => S(r.stepId) !== S(stepId))
  if (keep.length === rows.length) return false
  const cols = [...RENT_STEP_COLUMNS]
  await writeSheet(TAB_RENT_STEPS, [cols, ...keep.map(toStep).map(x => cols.map(k => String((x as any)[k] ?? '')))])
  return true
}

export async function removeCharge(chargeId: string): Promise<boolean> {
  const rows = await readTab(TAB_LEASE_CHARGES, true)
  const keep = rows.filter(r => S(r.chargeId) !== S(chargeId))
  if (keep.length === rows.length) return false
  const cols = [...CHARGE_COLUMNS]
  await writeSheet(TAB_LEASE_CHARGES, [cols, ...keep.map(toCharge).map(x => cols.map(k => String((x as any)[k] ?? '')))])
  return true
}

// ── What is true today, and what changes next ─────────────────────────────

/** The step covering `today`, or null when the schedule has a hole in it. */
export function currentStep(steps: RentStep[], salonNum: string, today: string): RentStep | null {
  return steps.find(s =>
    s.salonNum === salonNum &&
    s.startDate && s.startDate <= today &&
    (!s.endDate || s.endDate >= today)) || null
}

/** The next step to begin after today — the rent increase to warn about. */
export function nextStep(steps: RentStep[], salonNum: string, today: string): RentStep | null {
  const later = steps
    .filter(s => s.salonNum === salonNum && s.startDate && s.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
  return later[0] || null
}

/** The charge schedule for a given year. */
export function chargeFor(charges: LeaseCharge[], salonNum: string, year: number): LeaseCharge | null {
  return charges.find(c => c.salonNum === salonNum && c.year === year) || null
}

export interface RentChange {
  salonNum: string
  from: number
  to: number
  /** Dollars per month, positive = an increase. */
  delta: number
  pct: number
  startDate: string
  daysAway: number
}

/**
 * Rent increases starting within `withinDays`.
 *
 * This is what the monthly email is built on. It reports DECREASES too — rare,
 * but a rent that drops unexpectedly is as much a sign of a mis-keyed schedule
 * as one that jumps.
 */
export function upcomingRentChanges(
  steps: RentStep[], salonNums: string[], today: string, withinDays = 45,
): RentChange[] {
  const out: RentChange[] = []
  for (const salonNum of salonNums) {
    const cur = currentStep(steps, salonNum, today)
    const nxt = nextStep(steps, salonNum, today)
    if (!nxt) continue
    const days = daysBetween(today, nxt.startDate)
    if (days < 0 || days > withinDays) continue
    const from = cur ? cur.monthlyRent : 0
    const delta = Math.round((nxt.monthlyRent - from) * 100) / 100
    if (!from || Math.abs(delta) < 0.005) continue
    out.push({
      salonNum, from, to: nxt.monthlyRent, delta,
      pct: Math.round((delta / from) * 1000) / 10,
      startDate: nxt.startDate, daysAway: days,
    })
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate))
}

// ── What is missing ───────────────────────────────────────────────────────

export interface Gap {
  salonNum: string
  kind: string
  /** 'blocking' = the record is wrong or unusable; 'warning' = incomplete. */
  severity: 'blocking' | 'warning'
  message: string
  /** What to do about it, in one line. */
  fix: string
}

/**
 * Everything incomplete or inconsistent, per salon.
 *
 * The important one is `rent-step-gap`: no rent step covers today. On a live
 * lease that nearly always means an amendment was signed and never recorded —
 * exactly the "missing an amendment to bring us current" case. It is reported
 * as blocking because every figure derived from that salon is then wrong.
 */
export function gaps(
  opts: {
    leases: Lease[]
    steps: RentStep[]
    charges: LeaseCharge[]
    clauseSalons: string[]
    docSalons: string[]
    allSalons: string[]
    today: string
  },
): Gap[] {
  const { leases, steps, charges, clauseSalons, docSalons, allSalons, today } = opts
  const year = Number(today.slice(0, 4))
  const out: Gap[] = []
  const add = (salonNum: string, kind: string, severity: Gap['severity'], message: string, fix: string) =>
    out.push({ salonNum, kind, severity, message, fix })

  for (const salonNum of allSalons) {
    const l = leases.find(x => x.salonNum === salonNum)
    if (!l) {
      add(salonNum, 'no-record', 'warning',
        'No lease record at all.',
        'Add the lease under Lease records, or upload the lease and let abstraction fill it in.')
      continue
    }
    const live = l.status === 'active' || l.status === 'month-to-month'
    if (!live) continue

    if (!l.expirationDate) {
      add(salonNum, 'no-expiry', 'blocking',
        'No expiration date, so this lease is invisible to every deadline check.',
        'Record the expiration from the most recent amendment.')
    } else if (l.expirationDate < today) {
      add(salonNum, 'expired-still-active', 'blocking',
        `Term ended ${l.expirationDate} but the record still says ${l.status}.`,
        'Either a later amendment is missing, or the status should change to expired / month-to-month.')
    }

    const mine = steps.filter(s => s.salonNum === salonNum)
    if (!mine.length) {
      add(salonNum, 'no-rent-steps', 'warning',
        'No rent schedule recorded, so an increase cannot be warned about.',
        'Add the rent steps from the lease or amendment.')
    } else {
      const cur = currentStep(steps, salonNum, today)
      if (!cur) {
        add(salonNum, 'rent-step-gap', 'blocking',
          'The rent schedule does not cover today — it stops before now.',
          'An amendment has probably been signed and not recorded. Find the current amendment and add its rent schedule.')
      } else if (l.monthlyRent && Math.abs(cur.monthlyRent - l.monthlyRent) >= 0.01) {
        add(salonNum, 'rent-mismatch', 'blocking',
          `The lease record says ${l.monthlyRent.toFixed(2)}/mo but the schedule says ${cur.monthlyRent.toFixed(2)} for today.`,
          'One of the two is stale. The schedule is normally right.')
      }
      const last = mine[mine.length - 1]
      if (l.expirationDate && last.endDate && last.endDate < l.expirationDate) {
        add(salonNum, 'rent-steps-short', 'warning',
          `The rent schedule ends ${last.endDate} but the term runs to ${l.expirationDate}.`,
          'Add the remaining steps so future increases are known in advance.')
      }
    }

    const thisYear = chargeFor(charges, salonNum, year)
    const anyCharge = charges.filter(c => c.salonNum === salonNum)
    if (!anyCharge.length) {
      add(salonNum, 'no-cam', 'warning',
        'No CAM / NNN figures at all, so the monthly obligation shown is rent only.',
        'Upload the landlord’s reconciliation or escrow letter and record the components.')
    } else if (!thisYear) {
      const newest = anyCharge[anyCharge.length - 1]
      add(salonNum, 'stale-cam', 'warning',
        `CAM figures are from ${newest.year}; nothing recorded for ${year}.`,
        'The landlord normally sends next year’s escrow letter in the autumn — record it when it arrives.')
    } else if (chargeTotal(thisYear) <= 0) {
      add(salonNum, 'empty-cam', 'warning',
        `A ${year} CAM row exists but every component is zero.`,
        'Fill in the components from the escrow letter.')
    }

    if (!clauseSalons.includes(salonNum)) {
      add(salonNum, 'no-clauses', 'warning',
        'No clauses recorded, so questions about this lease cannot be answered.',
        'Abstract the lease, or record the key clauses by hand.')
    }
    if (!docSalons.includes(salonNum)) {
      add(salonNum, 'no-documents', 'warning',
        'No documents filed against this salon.',
        'Upload the lease and any amendments, picking this salon at drop time.')
    }
  }

  // Blocking first, then by salon, so the report reads worst-first.
  const rank = (g: Gap) => (g.severity === 'blocking' ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || a.salonNum.localeCompare(b.salonNum))
}

export { monthsBetween }
