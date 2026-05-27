// lib/dashboard-data.ts
//
// Translates SD_WEEKLY rows into the legacy SalonData dashboard format.
//
// Growth metrics (ccGrowth, salesGrowth) compare THIS week to the SAME FISCAL
// WEEK last year (week ending Friday minus 364 days). This matches what SD3's
// own reports show — e.g. fiscal week ending 2026-05-22 (Fri) compares to
// fiscal week ending 2025-05-23 (Fri).
//
// If no matching LY week exists in SD_WEEKLY, growth fields are null
// (rendered as 0% / dash in the dashboard).

import { readSheet, rowsToObjects } from '@/lib/sheets'
import { authenticate, fetchSalons } from '@/lib/sd3'
import { addDays } from '@/lib/fiscal'

const SD_WEEKLY_TAB = 'SD_WEEKLY'

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

export type DashboardWeek = {
  weekEnding: string
  salons: DashboardSalonRow[]
  emps: any[]
}

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

function num(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isNaN(n) ? 0 : n
}

function pctChange(thisVal: number, lastVal: number): number {
  if (!lastVal) return 0
  return ((thisVal - lastVal) / lastVal) * 100
}

/**
 * Compute the LY equivalent fiscal week-ending date.
 * Subtracts 364 days (52 weeks) so day-of-week stays the same.
 *
 * Example: 2026-05-22 (Fri) → 2025-05-23 (Fri)
 */
function lyWeekEnd(thisWeekEnd: string): string {
  return addDays(thisWeekEnd, -364)
}

/**
 * Read all SD_WEEKLY rows, build a lookup by (storeId, weekEnd),
 * and use it to populate this-year-vs-last-year growth fields.
 */
export async function getDashboardWeeks(): Promise<DashboardWeek[]> {
  // 1. storeId → salonNum mapping from SD3
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

  // 3. Lookup by composite key for O(1) LY access
  //    Key: `${storeId}|${weekEnd}` → row
  const byStoreWeek = new Map<string, SDWeeklyRow>()
  for (const r of rows) {
    byStoreWeek.set(`${r.storeId}|${r.weekEnd}`, r)
  }

  // 4. Group rows by week (weekEnd) so each "week" contains all salons
  const byWeek = new Map<string, DashboardSalonRow[]>()

  for (const r of rows) {
    const sid = String(r.storeId)
    const salonNum = storeIdToSalonNum.get(sid)
    if (!salonNum) continue
    const salonName = SALON_NAMES[salonNum] || salonNum

    // LY lookup: this week ending minus 364 days, same storeId
    const lyKey = `${sid}|${lyWeekEnd(r.weekEnd)}`
    const lyRow = byStoreWeek.get(lyKey)

    const salesThis = num(r.totalSales)
    const ccThis = num(r.cc)
    const salesLast = lyRow ? num(lyRow.totalSales) : 0
    const ccLast = lyRow ? num(lyRow.cc) : 0

    const dashRow: DashboardSalonRow = {
      weekEnding: r.weekEnd,
      salonNum,
      salonName,
      salesLast,
      salesThis,
      salesGrowth: lyRow ? pctChange(salesThis, salesLast) : 0,
      ccLast,
      ccThis,
      ccGrowth: lyRow ? pctChange(ccThis, ccLast) : 0,
      nr: num(r.nr),
      rr: num(r.rr),
      product: num(r.productPct),
      payroll: num(r.payrollPct),
      waits: num(r.waits),
      ssWaits: num(r.ssWaits),
      nonOciWaits: num(r.nonOciWaits),
      hcTime: num(r.hcTime),
      cph: num(r.cph),
      mbc: num(r.mbc),
    }

    if (!byWeek.has(r.weekEnd)) byWeek.set(r.weekEnd, [])
    byWeek.get(r.weekEnd)!.push(dashRow)
  }

  // 5. Convert to sorted array of DashboardWeek
  const weeks: DashboardWeek[] = []
  const weekEndings = [...byWeek.keys()].sort()
  for (const we of weekEndings) {
    weeks.push({
      weekEnding: we,
      salons: byWeek.get(we)!,
      emps: [],
    })
  }

  return weeks
}