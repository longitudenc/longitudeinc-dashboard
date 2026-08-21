// lib/payroll-pace.ts
//
// Weekly "payroll pace" report. For the current fiscal week-to-date (Sat →
// yesterday), compares each salon's actual payroll % to its per-day target %
// (from the 2026 goals sheet), and emails a %-based over/under digest.
//
// Read-only: uses the daily data already scraped into SD_DAILY. Sends via
// Resend. No dashboard UI. Triggered Wednesday morning from the daily cron,
// and callable on demand at /api/report/payroll-pace?secret=… for testing.

import { readSheet, rowsToObjects } from '@/lib/sheets'
import { todayET, addDays, dayOfWeek, fiscalWeekContaining } from '@/lib/fiscal'
import { Resend } from 'resend'

const FROM = process.env.PAYROLL_PACE_FROM || 'Longitude Dashboard <noreply@mail.longitudenc.com>'

// Daily payroll % targets by day-of-week × customer-count band (2026 goals sheet).
// Band index: 0=700+, 1=651-700, 2=600-650, 3=551-600, 4=500-550, 5=451-500,
//             6=400-450, 7=351-400, 8=300-350, 9=250-300, 10=<250.
// Day-of-week keys match dayOfWeek(): 0=Sun … 6=Sat.
const DAILY_TARGET: Record<number, number[]> = {
  6: [31, 32, 32, 33, 33, 34, 34, 34, 40, 45, 46], // Saturday
  0: [32, 33, 33, 34, 34, 35, 35, 35, 41, 46, 47], // Sunday
  1: [33, 34, 34, 35, 35, 36, 36, 36, 42, 47, 48], // Monday
  2: [34, 34, 34, 35, 35, 36, 36, 37, 42, 47, 48], // Tuesday
  3: [34, 35, 35, 35, 35, 36, 36, 38, 43, 47, 48], // Wednesday
  4: [34, 35, 35, 36, 36, 37, 37, 39, 44, 48, 49], // Thursday
  5: [35, 36, 36, 37, 37, 38, 38, 40, 45, 49, 50], // Friday
}

// Salons with a flat payroll % target regardless of band/day.
const FLAT_TARGET: Record<string, number> = { '3545': 55 }

function bandForCC(cc: number): number {
  const cuts = [700, 651, 600, 551, 500, 451, 400, 351, 300, 250]
  for (let i = 0; i < cuts.length; i++) if (cc >= cuts[i]) return i
  return 10
}

const num = (v: any) => {
  const x = parseFloat(String(v ?? '').replace(/[$,%\s]/g, ''))
  return isFinite(x) ? x : 0
}

export interface PaceRow {
  salonNum: string
  avgCC: number
  bandLabel: string
  days: number
  actual: number   // WTD actual payroll %
  target: number   // WTD sales-weighted target payroll %
  diff: number     // actual − target, in percentage points (+ = over)
}

export async function buildPayrollPace(asOf?: string): Promise<{ weekStart: string; weekEnd: string; lastDay: string; rows: PaceRow[] }> {
  const today = asOf || todayET()
  const { start: weekStart, end: weekEnd } = fiscalWeekContaining(today) // Sat start, Fri end
  const lastDay = addDays(today, -1)                        // through yesterday (settled)
  const windowStart = addDays(weekStart, -42)               // 6 prior weeks for the CC band

  const [salonRaw, rosterRaw] = await Promise.all([readSheet('SD_DAILY'), readSheet('SalonRoster')])

  const salonNumByStore: Record<string, string> = {}
  const statusByNum: Record<string, string> = {}
  for (const r of rowsToObjects(rosterRaw)) {
    const sid = String((r as any).storeId || '').trim()
    const sn = String((r as any).salonNum || '').trim()
    if (sid) salonNumByStore[sid] = sn
    if (sn) statusByNum[sn] = String((r as any).status || '').trim().toLowerCase()
  }

  const rows = rowsToObjects(salonRaw)
    .map(r => ({
      date: String((r as any).date || '').trim(),
      salonNum: salonNumByStore[String((r as any).storeId || '').trim()] || '',
      cc: num((r as any).customerCount),
      sales: num((r as any).serviceSales) + num((r as any).productSales),
      pay: num((r as any).approximatePayrollAmount),
    }))
    .filter(r => r.salonNum && r.date >= windowStart && r.date <= lastDay)

  // 6-week avg weekly CC per salon, from the weeks BEFORE this week's Saturday.
  const priorCC: Record<string, number> = {}
  for (const r of rows) if (r.date < weekStart) priorCC[r.salonNum] = (priorCC[r.salonNum] || 0) + r.cc
  const avgWeeklyCC: Record<string, number> = {}
  for (const sn in priorCC) avgWeeklyCC[sn] = priorCC[sn] / 6

  // WTD actual + sales-weighted target per salon (this week: weekStart .. lastDay).
  interface Agg { pay: number; sales: number; tgtWeighted: number; days: Set<string> }
  const agg: Record<string, Agg> = {}
  for (const r of rows) {
    if (r.date < weekStart) continue      // only this week-to-date
    if (r.sales <= 0) continue            // skip closed / no-business days
    const a = agg[r.salonNum] || (agg[r.salonNum] = { pay: 0, sales: 0, tgtWeighted: 0, days: new Set() })
    const band = bandForCC(avgWeeklyCC[r.salonNum] ?? 0)
    const flat = FLAT_TARGET[r.salonNum]
    const tgtPct = flat != null ? flat : (DAILY_TARGET[dayOfWeek(r.date)]?.[band] ?? 0)
    a.pay += r.pay
    a.sales += r.sales
    a.tgtWeighted += tgtPct * r.sales
    a.days.add(r.date)
  }

  const out: PaceRow[] = Object.keys(agg)
    .filter(sn => !['closed', 'sold'].includes(statusByNum[sn] || ''))
    .map(sn => {
      const a = agg[sn]
      const actual = a.sales > 0 ? (a.pay / a.sales) * 100 : 0
      const target = a.sales > 0 ? a.tgtWeighted / a.sales : 0
      const avg = avgWeeklyCC[sn] || 0
      return {
        salonNum: sn,
        avgCC: Math.round(avg),
        bandLabel: FLAT_TARGET[sn] != null ? 'flat 55%' : String(Math.round(avg)),
        days: a.days.size,
        actual,
        target,
        diff: actual - target,
      }
    })
    .sort((x, y) => Number(x.salonNum) - Number(y.salonNum)) // numerical salon order

  return { weekStart, weekEnd, lastDay, rows: out }
}

function fmtMDY(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}/${y}`
}

function paceHtml(weekEnd: string, lastDay: string, rows: PaceRow[]): string {
  const cell = (v: string, style = '') => `<td style="padding:6px 10px;border-bottom:1px solid #eee;${style}">${v}</td>`
  const body = rows.map(r => {
    const over = r.diff > 0.05
    const under = r.diff < -0.05
    const color = over ? '#b23' : under ? '#1a7a3a' : '#666'
    const sign = r.diff >= 0 ? '+' : '−'
    const diffTxt = `<span style="color:${color};font-weight:700;">${sign}${Math.abs(r.diff).toFixed(1)} pts</span>`
    return `<tr>
      ${cell(r.salonNum, 'font-weight:600;')}
      ${cell(r.bandLabel, 'color:#666;')}
      ${cell(r.actual.toFixed(1) + '%', 'text-align:center;')}
      ${cell(r.target.toFixed(1) + '%', 'text-align:center;color:#666;')}
      ${cell(diffTxt, 'text-align:right;')}
    </tr>`
  }).join('')

  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#1a2b25;max-width:640px;">
    <h2 style="margin:0 0 2px;color:#03654e;">Payroll Pace — week ending ${fmtMDY(weekEnd)}</h2>
    <div style="color:#666;margin-bottom:12px;">Week-to-date through ${fmtMDY(lastDay)}. Actual payroll % vs. daily target. <b style="color:#b23;">+ = over</b> (tighten up), <b style="color:#1a7a3a;">− = under</b>.</div>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead><tr style="background:#03654e;color:#fff;">
        <th style="padding:7px 10px;text-align:left;">Salon</th>
        <th style="padding:7px 10px;text-align:left;">Avg CC</th>
        <th style="padding:7px 10px;text-align:center;">Actual %</th>
        <th style="padding:7px 10px;text-align:center;">Target %</th>
        <th style="padding:7px 10px;text-align:right;">Over / Under</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div style="color:#888;font-size:11px;margin-top:10px;">
      Targets vary by day of week and each salon's ~6-week avg weekly customers. Salon 3545 uses a flat 55% target.
      Over/Under is in payroll percentage points, averaged across the days worked so far this week.
    </div>
  </div>`
}

export async function sendPayrollPace(asOf?: string): Promise<{ sent: boolean; count: number }> {
  const to = (process.env.PAYROLL_PACE_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!process.env.RESEND_API_KEY || to.length === 0) {
    console.warn('[payroll-pace] skipped — RESEND_API_KEY or PAYROLL_PACE_EMAIL not set')
    return { sent: false, count: 0 }
  }
  const { weekEnd, lastDay, rows } = await buildPayrollPace(asOf)
  if (!rows.length) {
    console.warn('[payroll-pace] no salon data for the current week-to-date; nothing sent')
    return { sent: false, count: 0 }
  }
  const html = paceHtml(weekEnd, lastDay, rows)
  const resend = new Resend(process.env.RESEND_API_KEY)
  await resend.emails.send({
    from: FROM,
    to,
    subject: `Payroll Pace — week ending ${fmtMDY(weekEnd)} (through ${fmtMDY(lastDay)})`,
    html,
  })
  console.log(`[payroll-pace] sent to ${to.join(', ')} — ${rows.length} salons`)
  return { sent: true, count: rows.length }
}
