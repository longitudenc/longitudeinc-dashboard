// lib/adp-payroll-detail.ts
// ---------------------------------------------------------------------------
// Parser for SD3's "Payroll Detail Report - Weekly".
//
// This report is the missing piece for 6-day pay. Unlike the Payroll
// Consolidated report (one row per employee per salon, weekly totals only) it
// gives, per employee per salon:
//
//   • floor hours for EACH DAY of the Sat→Fri week, so qualifying days can be
//     counted directly instead of inferred from clock punches
//   • SD3's OWN "Six Day" line — the amount it already folded into All Other
//     Incentives — stated outright, so nothing has to be reverse-engineered
//
// Layout (CSV, one section per salon):
//
//   "Payroll Detail Report - Weekly","Hilltop Plaza #1304","Saturday, …"
//   "ALDRIDGE, KAYLA R","Position:","Hire Date:","Global EE ID:","Base Wage:","Pay ID:"
//   ,"Stylist","4/13/2017","2016-0000-8686","14.41","7784"
//   (blank)
//   "DETAIL","SAT","SUN","MON","TUE","WED","THU","FRI","Weekly #'s",…
//   "Floor Hrs","0","6.96","0","4.80","6.67","6.13","0","24.56",…
//   "Six Day","5.06","6.48","0","7.87","5.90","0","7.49","32.80","Six Day","1.00/hr",…
//   …
//   "SALON TOTALS","Hours",…          ← employee blocks end here
//
// The salon-totals and performance-summary sections reuse row labels like
// "Floor Hrs", so parsing MUST stop at them — otherwise a salon's 190-hour
// total lands on whichever employee happened to be last.
//
// ── WHY THIS REPORT IS REQUIRED ─────────────────────────────────────────────
//
// Two cheaper routes to SD3's Six Day figure were tried against the real week
// ending 2026-08-21 (140 employee-salon rows, 18 of them paid) and BOTH failed.
// Recorded here so neither is attempted again:
//
// 1. /rest/empincentive is NOT the Six Day feed. It is a manual adjustment
//    table — additionalHours, bonusCentsPerHour, flatBonus, approved — and
//    returned a single record for an entire salon-week, with no amount
//    resembling any Six Day figure. Six Day is computed, not stored there.
//
// 2. SD3's qualification rule cannot be modelled reliably. Best fits over all
//    140 rows:
//      • 6+ days with FLOOR hours, 34+ total hours  → 4 wrong
//      • 6+ days with ANY hours, 34+ total hours    → 3 wrong
//      • …+ threshold on hours WORKED (excluding vacation) → 1 wrong
//    That last residual (one stylist with 5 floor days, 6 worked days and 37.15
//    hours worked, whom SD3 did NOT pay) has no explanation in any field the
//    other feeds expose. 139/140 is a fine hit rate for an estimate and an
//    unacceptable one for payroll: each miss is a whole person's 6-day pay,
//    roughly $35, moving the wrong way.
//
// So the amount is READ from this report rather than inferred. If SD3 ever
// exposes the breakdown as data, the JSON behind the report
// (payrollweekresult?lineNum!=10&weekEnding>=…) is the place to look next —
// the lineNum filter hints at per-line incentive items.
// ---------------------------------------------------------------------------

import { parseCsv } from '@/lib/csv'
import type { DailyFloorRow } from '@/lib/adp-payroll'

/** What SD3 already paid one employee in 6-day pay at one salon. */
export interface Sd3SixDayRow {
  payId: string
  salonNum: string
  amount: number
}

export interface PayrollDetailParse {
  dailyFloor: DailyFloorRow[]
  sd3SixDay: Sd3SixDayRow[]
  /** Employee-salon blocks seen — a sanity check against the payroll report. */
  blocks: number
  /** Salon numbers the report covered. */
  salons: string[]
  /** Anything that looked wrong while parsing, for the caller to surface. */
  warnings: string[]
}

/** Section headers that end an employee block. */
const BLOCK_ENDERS = new Set([
  'SALON TOTALS', 'Performance Summary', 'TOTALS*', 'Payroll %',
])

function num(v: unknown): number {
  const s = String(v ?? '').replace(/[$,%\s]/g, '')
  if (!s) return 0
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parse the report for a known Sat→Fri week.
 *
 * `weekStart` must be the Saturday: the report's day columns are positional
 * (SAT…FRI) and carry no dates of their own, so the caller supplies the anchor.
 */
export function parsePayrollDetail(csvText: string, weekStart: string): PayrollDetailParse {
  const rows = parseCsv(csvText)
  const warnings: string[] = []

  // SAT … FRI → real dates.
  const dates: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + i)
    dates.push(d.toISOString().slice(0, 10))
  }

  const dailyFloor: DailyFloorRow[] = []
  const sd3SixDay: Sd3SixDayRow[] = []
  const salons = new Set<string>()

  let salonNum = ''
  let cur: { name: string; payId: string; salonNum: string } | null = null
  let blocks = 0

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const first = (r[0] ?? '').trim()

    // New salon section.
    if (first.startsWith('Payroll Detail Report')) {
      const m = /#(\d+)/.exec(r[1] ?? '')
      if (m) { salonNum = m[1]; salons.add(salonNum) }
      cur = null
      continue
    }

    // Totals / summary sections reuse the same row labels — stop reading here.
    if (BLOCK_ENDERS.has(first)) { cur = null; continue }

    // Employee header: name in col 0, "Position:" in col 1, ids on the NEXT row.
    if ((r[1] ?? '').trim() === 'Position:') {
      const detail = rows[i + 1] ?? []
      const payId = (detail[5] ?? '').trim()
      if (!payId) {
        warnings.push(`${first || 'an employee'} at salon ${salonNum} has no Pay ID in the detail report`)
        cur = null
        continue
      }
      cur = { name: first, payId: normalizeId(payId), salonNum }
      blocks++
      continue
    }

    if (!cur || !first) continue

    if (first === 'Floor Hrs') {
      // Columns 1..7 are SAT..FRI; column 8 is the week total. A row shorter
      // than that is a totals-section stray, not an employee's day row.
      if (r.length < 9) continue
      for (let d = 0; d < 7; d++) {
        const hours = num(r[d + 1])
        if (hours > 0) {
          dailyFloor.push({ date: dates[d], payId: cur.payId, salonNum: cur.salonNum, floorHours: hours })
        }
      }
    } else if (first === 'Six Day') {
      if (r.length < 9) continue
      const amount = num(r[8])
      if (amount > 0) {
        sd3SixDay.push({ payId: cur.payId, salonNum: cur.salonNum, amount })
      }
    }
  }

  if (blocks === 0) {
    warnings.push('No employee blocks found — is this the Payroll Detail Report (Weekly)?')
  }

  return { dailyFloor, sd3SixDay, blocks, salons: [...salons].sort(), warnings }
}

/** Match the payroll report's Payroll ID handling: no leading zeros. */
function normalizeId(raw: string): string {
  return /^0\d+$/.test(raw) ? (raw.replace(/^0+/, '') || '0') : raw
}
