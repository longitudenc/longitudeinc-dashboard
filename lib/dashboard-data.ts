// lib/dashboard-data.ts
//
// Translates SD_WEEKLY rows into the legacy SalonData dashboard format.
//
// The existing dashboard (public/dashboard.html) reads a "salonRows" array
// with these exact field names:
//   weekEnding, salonNum, salonName, salesLast, salesThis, salesGrowth,
//   ccLast, ccThis, ccGrowth, nr, rr, product, payroll, waits, ssWaits,
//   nonOciWaits, hcTime, cph, mbc
//
// This module reads from SD_WEEKLY (our new clean schema) and returns rows
// in the dashboard's expected shape.

import { readSheet, rowsToObjects } from '@/lib/sheets'
import { authenticate, fetchSalons } from '@/lib/sd3'

const SD_WEEKLY_TAB = 'SD_WEEKLY'

// Salon name lookup — matches public/dashboard.html SALON_NAMES.
// Duplicated here so server-side rendering doesn't depend on the client file.
const SALON_NAMES: Record<string, string> = {
  '1304': '1304 Hilltop',
  '2554': '2554 Carmel',
  '3015': '3015 Food Lion',
  '3025': '3025 Landing',
  '3027': '3027 Franklin',
  '3043': '3043 Roosevelt',
  '3045': '3045 Park',
  '3053': '3053 Plantation',
  '3058': '3058 Crown Point',
  '3062': '3062 Mint Hill',
  '3071': '3071 Sun Valley',
  '3545': '3545 Meridian',
  '3685': '3685 Marvin',
  '4138': '4138 Northwoods',
  '7728': '7728 Springfield',
  '8725': '8725 Anderson',
  '9478': '9478 Carolina',
  '9489': '9489 Arboretum',
  '9689': '9689 Cureton',
}

// Dashboard's expected SalonData row shape
export type DashboardSalonRow = {
  weekEnding: string
  salonNum: string
  salonName: string
  salesLast: number
  salesThis: number
  salesGrowth: number
  ccLast: number
  ccThis: number
  ccGrowth: number
  nr: number
  rr: number
  product: number
  payroll: number
  waits: number
  ssWaits: number
  nonOciWaits: number
  hcTime: number
  cph: number
  mbc: number
}

// Dashboard's "weeks" array shape — one element per week, with all 19 salons inside
export type DashboardWeek = {
  weekEnding: string
  salons: DashboardSalonRow[]
  emps: any[] // future: EmpData translation
}

// Raw SD_WEEKLY row shape (what we read from Sheets)
type SDWeeklyRow = {
  weekEnd: string
  weekStart: string
  storeId: string | number
  cc: string | number
  serviceSales: string | number
  productSales: string | number
  totalSales: string | number
  payrollPct: string | number
  productPct: string | number
  nr: string | number
  rr: string | number
  hcTime: string | number
  mbc: string | number
  ssWaits: string | number
  waits: string | number
  nonOciWaits: string | number
  cph: string | number
  [k: string]: any
}

// Safe number parse — handles strings, nulls, empties
function num(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isNaN(n) ? 0 : n
}

// Percent change between this and last; returns 0 if last is 0 or missing
function pctChange(thisVal: number, lastVal: number): number {
  if (!lastVal) return 0
  return ((thisVal - lastVal) / lastVal) * 100
}

/**
 * Read all SD_WEEKLY rows, group by week, fill in prior-week comparison
 * fields, and join storeId → salonNum.
 *
 * Returns an array of DashboardWeek, sorted by weekEnding ascending.
 */
export async function getDashboardWeeks(): Promise<DashboardWeek[]> {
  // 1. Pull mapping storeId → salonNum (always fresh from SD3)
  const session = await authenticate()
  const salons = await fetchSalons(session)
  const storeIdToSalonNum = new Map<string, string>()
  for (const s of salons) {
    storeIdToSalonNum.set(String(s.storeId), s.salonNum)
  }

  // 2. Read all SD_WEEKLY rows
  const sheetData = await readSheet(SD_WEEKLY_TAB)
  if (!sheetData.length) return []

  const rows = rowsToObjects(sheetData) as SDWeeklyRow[]

  // 3. Group rows by (storeId) so we can look up prior weeks per salon
  //    Each salon's history sorted by weekEnd ascending
  const bySalon = new Map<string, SDWeeklyRow[]>()
  for (const r of rows) {
    const sid = String(r.storeId)
    if (!bySalon.has(sid)) bySalon.set(sid, [])
    bySalon.get(sid)!.push(r)
  }
  for (const arr of bySalon.values()) {
    arr.sort((a, b) => (a.weekEnd < b.weekEnd ? -1 : a.weekEnd > b.weekEnd ? 1 : 0))
  }

  // 4. Now group by week (weekEnd) so each "week" contains all salons
  const byWeek = new Map<string, DashboardSalonRow[]>()

  for (const [sid, history] of bySalon.entries()) {
    const salonNum = storeIdToSalonNum.get(sid)
    if (!salonNum) {
      // Unknown store — skip rather than crash
      continue
    }
    const salonName = SALON_NAMES[salonNum] || salonNum

    history.forEach((row, idx) => {
      const prior = idx > 0 ? history[idx - 1] : null

      const salesThis = num(row.totalSales)
      const ccThis = num(row.cc)
      const salesLast = prior ? num(prior.totalSales) : 0
      const ccLast = prior ? num(prior.cc) : 0

      const dashRow: DashboardSalonRow = {
        weekEnding: row.weekEnd,
        salonNum,
        salonName,
        salesLast,
        salesThis,
        salesGrowth: pctChange(salesThis, salesLast),
        ccLast,
        ccThis,
        ccGrowth: pctChange(ccThis, ccLast),
        nr: num(row.nr),
        rr: num(row.rr),
        product: num(row.productPct),
        payroll: num(row.payrollPct),
        waits: num(row.waits),
        ssWaits: num(row.ssWaits),
        nonOciWaits: num(row.nonOciWaits),
        hcTime: num(row.hcTime),
        cph: num(row.cph),
        mbc: num(row.mbc),
      }

      const weekEnd = row.weekEnd
      if (!byWeek.has(weekEnd)) byWeek.set(weekEnd, [])
      byWeek.get(weekEnd)!.push(dashRow)
    })
  }

  // 5. Convert map to sorted array of DashboardWeek
  const weeks: DashboardWeek[] = []
  const weekEndings = [...byWeek.keys()].sort()
  for (const we of weekEndings) {
    weeks.push({
      weekEnding: we,
      salons: byWeek.get(we)!,
      emps: [], // empty for now — EmpData translation comes later
    })
  }

  return weeks
}