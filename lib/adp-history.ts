// lib/adp-history.ts
//
// The payroll download log, and what it is for beyond a receipt.
//
// Two things read it back:
//   • the week-over-week variance check (compareToPrevious below) — a salon
//     whose cost jumps or collapses is usually a bad scrape or a missing person,
//     and it is far cheaper to see that before the file goes to ADP
//   • the "this week was already downloaded" warning, so the same week doesn't
//     get sent twice
//
// Kept out of the route files because a Next.js route module may only export
// handlers and its own config — exporting constants from one fails the build
// (tsc alone does not catch it).

import type { PayrollBuildResult, SalonTotal } from '@/lib/adp-payroll'

export const ADP_HISTORY_TAB = 'ADP_HISTORY'

export const HISTORY_COLUMNS = [
  'weekEnd', 'weekStart', 'payDate', 'fileName',
  'employees', 'salons', 'paidHours', 'grossPay', 'tips',
  'overtimePay', 'overtimeDelta', 'sixDayDelta', 'sixDaySd3Paid',
  'breakMinutes', 'extraEarnings', 'exceptions', 'forced',
  // Per-salon totals as JSON, so a later week can be compared salon by salon
  // without rebuilding this one. ~18 small objects; a Sheets cell holds 50k.
  'salonJson',
  // Blob pathname of the exact CSV that was sent. The file is the evidence when
  // ADP and SD3 disagree weeks later; the totals alone are not.
  'filePath',
  'downloadedAt', 'downloadedBy',
] as const

/** One salon's figures as they were sent, kept small — this is stored as JSON. */
export interface SalonSnapshot {
  salonNum: string
  employees: number
  hours: number
  grossPay: number
  tips: number
}

export function salonSnapshot(totals: SalonTotal[]): SalonSnapshot[] {
  return totals.map(t => ({
    salonNum: t.salonNum,
    employees: t.employees,
    hours: t.hours,
    grossPay: t.grossPay,
    tips: t.tips,
  }))
}

export function parseSalonSnapshot(raw: unknown): SalonSnapshot[] {
  const s = String(raw ?? '').trim()
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── Week-over-week variance ─────────────────────────────────────────────────

export interface SalonVariance {
  salonNum: string
  now: number
  prev: number
  delta: number
  /** Percent change, or null when there is nothing to divide by. */
  pct: number | null
  /** Had rows last week and none now — the case worth stopping for. */
  gone: boolean
  /** No rows last week — a new or reopened salon, not an error. */
  isNew: boolean
}

export interface VarianceReport {
  /** The week compared against, or '' when there is no history yet. */
  prevWeekEnd: string
  prevDownloadedAt: string
  salons: SalonVariance[]
  /** Whole-week payroll cost movement. */
  totalNow: number
  totalPrev: number
  totalPct: number | null
  /** Plain-English lines for anything past the threshold. */
  warnings: string[]
}

const pctOf = (now: number, prev: number): number | null =>
  prev === 0 ? null : ((now - prev) / Math.abs(prev)) * 100

const money = (n: number) => `$${n.toFixed(2)}`

/**
 * Compare a build against the last week that was actually downloaded.
 *
 * Deliberately compares against what was SENT, not against a rebuild of last
 * week: SD3 keeps settling figures for days after a week closes, so a rebuild
 * would drift and every week would look like a variance.
 *
 * @param history rows straight off the ADP_HISTORY tab
 * @param alertPct movement (either way) that earns a warning
 */
export function compareToPrevious(
  result: PayrollBuildResult,
  history: Record<string, any>[],
  alertPct: number
): VarianceReport {
  // The newest download for a week strictly BEFORE this one. A week downloaded
  // twice keeps its latest run, which is the file that went to ADP.
  let prev: Record<string, any> | null = null
  for (const r of history) {
    const we = String(r.weekEnd || '').trim()
    if (!we || we >= result.weekEnd) continue
    if (!prev || we > String(prev.weekEnd) ||
        (we === String(prev.weekEnd) &&
         String(r.downloadedAt || '') > String(prev.downloadedAt || ''))) {
      prev = r
    }
  }

  const totalNow = result.totals.grossPay
  if (!prev) {
    return {
      prevWeekEnd: '', prevDownloadedAt: '', salons: [],
      totalNow, totalPrev: 0, totalPct: null,
      warnings: [],
    }
  }

  const prevSalons = new Map(parseSalonSnapshot(prev.salonJson).map(s => [s.salonNum, s]))
  const nowSalons = new Map(result.salonTotals.map(t => [t.salonNum, t]))
  const allNums = [...new Set([...prevSalons.keys(), ...nowSalons.keys()])].sort()

  const salons: SalonVariance[] = allNums.map(salonNum => {
    const now = nowSalons.get(salonNum)?.grossPay ?? 0
    const p = prevSalons.get(salonNum)?.grossPay ?? 0
    return {
      salonNum,
      now, prev: p,
      delta: Math.round((now - p) * 100) / 100,
      pct: pctOf(now, p),
      gone: p > 0 && !nowSalons.has(salonNum),
      isNew: !prevSalons.has(salonNum),
    }
  })

  const warnings: string[] = []
  for (const v of salons) {
    if (v.gone) {
      warnings.push(
        `Salon ${v.salonNum} paid ${money(v.prev)} in the week ending ${prev.weekEnd} ` +
        `and has no rows at all this week — check the report actually covered it`
      )
      continue
    }
    if (v.isNew && v.now > 0) {
      warnings.push(`Salon ${v.salonNum} is new since the week ending ${prev.weekEnd} (${money(v.now)})`)
      continue
    }
    if (v.pct != null && Math.abs(v.pct) >= alertPct) {
      warnings.push(
        `Salon ${v.salonNum} payroll ${v.delta > 0 ? 'up' : 'down'} ` +
        `${Math.abs(v.pct).toFixed(0)}% on the week ending ${prev.weekEnd} ` +
        `(${money(v.prev)} → ${money(v.now)})`
      )
    }
  }

  const totalPrev = Number(prev.grossPay) || 0
  const totalPct = pctOf(totalNow, totalPrev)
  if (totalPct != null && Math.abs(totalPct) >= alertPct) {
    warnings.push(
      `Total payroll ${totalPct > 0 ? 'up' : 'down'} ${Math.abs(totalPct).toFixed(0)}% ` +
      `on the week ending ${prev.weekEnd} (${money(totalPrev)} → ${money(totalNow)})`
    )
  }

  return {
    prevWeekEnd: String(prev.weekEnd || ''),
    prevDownloadedAt: String(prev.downloadedAt || ''),
    salons, totalNow, totalPrev, totalPct, warnings,
  }
}

/** The latest download of a given week, for the "already sent" warning. */
export function lastDownloadOf(history: Record<string, any>[], weekEnd: string) {
  let hit: Record<string, any> | null = null
  for (const r of history) {
    if (String(r.weekEnd || '').trim() !== weekEnd) continue
    if (!hit || String(r.downloadedAt || '') > String(hit.downloadedAt || '')) hit = r
  }
  if (!hit) return null
  return {
    at: String(hit.downloadedAt || ''),
    by: String(hit.downloadedBy || ''),
    fileName: String(hit.fileName || ''),
    forced: String(hit.forced || '') === 'true',
  }
}
