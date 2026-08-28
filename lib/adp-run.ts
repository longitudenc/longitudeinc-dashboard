// lib/adp-run.ts
// ---------------------------------------------------------------------------
// Orchestration for the Office Tools payroll builder: gather a week's inputs,
// hand them to the pure engine in lib/adp-payroll, return the result.
//
// This is the step that used to be "download the Payroll Consolidated report
// from SD3, open the macro workbook, click Load Pay Consol". Nothing is
// downloaded or opened — the same report is pulled straight from SD3.
//
// Inputs gathered here:
//   • Payroll Consolidated CSV — live from SD3, the identical report/date range
//   • Clock punches            — SD_CHKINOUT (scraped nightly), or live on request
//   • Settings                 — ADP_SETTINGS / ADP_SALONS, or built-in defaults
//   • Bonuses                  — BonusData, on the 3rd-paycheck week only
//   • Manual earnings          — ADP_MANUAL, whatever the office keyed for the week
// ---------------------------------------------------------------------------

import { authenticate, fetchSalons, fetchPayrollCsv, fetchEmpChkInOut, batchMap } from '@/lib/sd3'
import { parseCsv, rowsToObjectsAt } from '@/lib/csv'
import { readSheet, rowsToObjects, getChkInOutRange } from '@/lib/sheets'
import { loadAdpSettings, type AdpSettings } from '@/lib/adp-settings'
import { salonMonth } from '@/lib/salon-month'
import { fiscalWeekContaining, lastCompletedFiscalWeek, todayET } from '@/lib/fiscal'
import {
  buildPayroll,
  toPayConsolRows,
  isBonusPayWeek,
  type ExtraEarning,
  type PayrollBuildResult,
  type PunchSegment,
} from '@/lib/adp-payroll'

const ADP_MANUAL_TAB = 'ADP_MANUAL'
const BONUS_TAB = 'BonusData'

/** Sheets round-trips booleans as text; accept every shape they come back in. */
function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === 'yes' || s === '1'
}

function numOrNull(v: unknown): number | null {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

export interface RunOptions {
  /** Week-ending Friday (YYYY-MM-DD). Defaults to the last completed week. */
  weekEnd?: string
  /** 'sheet' (default, nightly scrape) or 'live' (pull punches from SD3 now). */
  punchSource?: 'sheet' | 'live'
  /** Force bonuses on or off; default follows the 3rd-paycheck rule. */
  includeBonuses?: boolean
  /** Override which bonus period to pay ("Jul 26"). */
  bonusPeriod?: string
}

export interface RunResult extends PayrollBuildResult {
  meta: {
    punchSource: 'sheet' | 'live'
    punchSegments: number
    payrollRows: number
    salonsInReport: string[]
    bonusPeriod: string | null
    bonusLines: number
    manualLines: number
    settingsFromSheet: boolean
    /** Codes still unassigned — the office has to fill these in. */
    missingCodes: string[]
    durationMs: number
  }
  settings: AdpSettings
}

/**
 * The most recently COMPLETED salon month as of a week — the bonus period whose
 * payout belongs on this paycheck. Salon months end on the last Friday of the
 * calendar month, so the current month is only complete once we're past it.
 */
export function bonusPeriodFor(weekEnd: string): string {
  const d = new Date(weekEnd + 'T00:00:00Z')
  let y = d.getUTCFullYear()
  let m = d.getUTCMonth() + 1
  let sm = salonMonth(y, m)
  if (sm.monthEnd >= weekEnd) {
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
    sm = salonMonth(y, m)
  }
  return sm.periodKey
}

/** Stylist bonus payouts for a period, as earnings lines keyed by Payroll ID. */
async function loadBonusLines(periodKey: string, code: string): Promise<ExtraEarning[]> {
  let rows: Record<string, any>[]
  try {
    rows = rowsToObjects(await readSheet(BONUS_TAB))
  } catch {
    return []
  }
  const out: ExtraEarning[] = []
  for (const r of rows) {
    if (String(r.periodKey || '').trim() !== periodKey) continue
    const payout = numOrNull(r.payout) ?? 0
    if (!(payout > 0)) continue
    // `eligible` is written by the bonus engine; only an explicit no excludes.
    const elig = String(r.eligible ?? '').trim().toLowerCase()
    if (elig === 'false' || elig === 'no' || elig === '0') continue
    const payId = String(r.payId || '').trim()
    if (!payId) continue
    out.push({
      payId,
      salonNum: String(r.salonNum || '').trim() || undefined,
      code,
      amount: payout,
      label: `Stylist bonus ${periodKey}`,
      kind: 'bonus',
    })
  }
  return out
}

/** Hand-keyed earnings the office saved for this week (referral, cell, …). */
export async function loadManualLines(weekEnd: string): Promise<(ExtraEarning & { id: string })[]> {
  let rows: Record<string, any>[]
  try {
    rows = rowsToObjects(await readSheet(ADP_MANUAL_TAB))
  } catch {
    return []
  }
  return rows
    .filter(r => String(r.weekEnd || '').trim() === weekEnd)
    .map(r => ({
      id: String(r.id || '').trim(),
      payId: String(r.payId || '').trim(),
      salonNum: String(r.salonNum || '').trim() || undefined,
      code: String(r.code || '').trim(),
      amount: numOrNull(r.amount) ?? 0,
      label: String(r.label || '').trim() || 'Manual earning',
      kind: 'manual' as const,
    }))
    .filter(l => l.payId && l.amount !== 0)
}

/** Punches from the nightly scrape. Cheap — one Sheets read for the week. */
async function punchesFromSheet(weekStart: string, weekEnd: string): Promise<PunchSegment[]> {
  const { chkinout } = await getChkInOutRange(weekStart, weekEnd)
  return chkinout.map(r => ({
    date: String(r.date || ''),
    salonNum: String(r.salonNum || '').trim(),
    fname: String(r.fname || ''),
    lname: String(r.lname || ''),
    checkInTime: r.checkInTime ? String(r.checkInTime) : null,
    checkOutTime: r.checkOutTime ? String(r.checkOutTime) : null,
    hours: numOrNull(r.hours),
    breakTime: numOrNull(r.breakTime),
    asStylist: truthy(r.asStylist),
    asRecept: truthy(r.asRecept),
    asTraining: truthy(r.asTraining),
    asAdmin: truthy(r.asAdmin),
    absent: truthy(r.absent),
  }))
}

/**
 * Build the ADP upload for a week.
 *
 * Punches come from the nightly SD_CHKINOUT scrape by default; if that has
 * nothing for the week (the scrape hasn't run, or the week is older than the
 * retained window) it falls back to pulling them live from SD3, because 6-day
 * pay and short breaks are silently wrong without them.
 */
export async function runPayrollBuild(opts: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now()

  const weekEnd = opts.weekEnd || lastCompletedFiscalWeek(todayET()).end
  const weekStart = fiscalWeekContaining(weekEnd).start

  const settings = await loadAdpSettings()

  const session = await authenticate()
  const salons = await fetchSalons(session)
  const storeIds = salons.map(s => s.storeId)

  const csvText = await fetchPayrollCsv(session, storeIds, weekStart, weekEnd)
  const rows = toPayConsolRows(rowsToObjectsAt(parseCsv(csvText), 0))

  // ── Punches ──
  let punchSource: 'sheet' | 'live' = opts.punchSource === 'live' ? 'live' : 'sheet'
  let punches: PunchSegment[] = []
  if (punchSource === 'sheet') {
    try {
      punches = await punchesFromSheet(weekStart, weekEnd)
    } catch {
      punches = []
    }
    if (punches.length === 0) punchSource = 'live'
  }
  if (punchSource === 'live') {
    const perStore = await batchMap(salons, 4, async s => {
      try {
        const segs = await fetchEmpChkInOut(session, s.storeId, weekStart, weekEnd)
        return segs.map(seg => ({
          date: seg.date,
          salonNum: s.salonNum,
          fname: seg.fname,
          lname: seg.lname,
          checkInTime: seg.checkInTime,
          checkOutTime: seg.checkOutTime,
          hours: seg.hours,
          breakTime: seg.breakTime,
          asStylist: seg.asStylist,
          asRecept: seg.asRecept,
          asTraining: seg.asTraining,
          asAdmin: seg.asAdmin,
          absent: seg.absent,
        }))
      } catch {
        return [] as PunchSegment[]
      }
    })
    punches = perStore.flat()
  }

  // ── Bonuses (3rd paycheck of the month, unless overridden) ──
  const autoBonusWeek = isBonusPayWeek(
    weekEnd,
    settings.rules.payDateOffsetDays,
    settings.rules.bonusPaycheckOfMonth
  )
  const wantBonuses = opts.includeBonuses ?? autoBonusWeek
  const bonusPeriod = wantBonuses ? (opts.bonusPeriod || bonusPeriodFor(weekEnd)) : null
  const bonuses = bonusPeriod
    ? await loadBonusLines(bonusPeriod, settings.codes.stylistBonus || '')
    : []

  const manual = await loadManualLines(weekEnd)

  const result = buildPayroll({
    rows,
    punches,
    settings,
    weekStart,
    weekEnd,
    bonuses,
    manual,
  })

  const missingCodes = Object.entries(settings.codes)
    .filter(([, v]) => !v)
    .map(([k]) => k)

  return {
    ...result,
    settings,
    meta: {
      punchSource,
      punchSegments: punches.length,
      payrollRows: rows.length,
      salonsInReport: [...new Set(rows.map(r => r.salonNum))].sort(),
      bonusPeriod,
      bonusLines: bonuses.length,
      manualLines: manual.length,
      settingsFromSheet: Object.keys(settings.overrides).length > 0,
      missingCodes,
      durationMs: Date.now() - startedAt,
    },
  }
}
