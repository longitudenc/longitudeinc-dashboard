import { NextResponse } from 'next/server'
import { getAllDashboardData, readSheet, rowsToObjects } from '@/lib/sheets'
import { getDashboardWeeks } from '@/lib/dashboard-data'
import { AMS } from '@/lib/config'

const SALON_ROSTER_TAB = 'SalonRoster'

let cache: { data: any; timestamp: number } | null = null
const CACHE_TTL = 3 * 60 * 1000

export async function GET() {
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return NextResponse.json({ ...cache.data, cached: true })
    }
    const [raw, scrapedWeeks, rosterRows, inactiveMap] = await Promise.all([
      getAllDashboardData(),
      getDashboardWeeks(),
      fetchSalonRoster(),
      fetchInactiveMap(),
    ])
    const data: any = formatAllData(raw, scrapedWeeks, rosterRows)
    data.inactiveMap = inactiveMap
    cache = { data, timestamp: Date.now() }
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}

/**
 * Fetch the SalonRoster tab. Returns [] (not an error) if the tab is missing or
 * empty — the dashboard should keep working even if the roster hasn't been
 * scraped yet. The dashboard treats an empty roster as "fall back to whatever
 * hardcoded constants used to exist."
 */
async function fetchSalonRoster(): Promise<any[]> {
  try {
    const raw = await readSheet(SALON_ROSTER_TAB)
    const rows = rowsToObjects(raw)
    return rows.map(r => ({
      salonNum: String(r.salonNum || '').trim(),
      storeId: Number(r.storeId) || 0,
      name: String(r.name || '').trim(),
      city: String(r.city || '').trim(),
      state: String(r.state || '').trim(),
      market: String(r.market || '').trim(),
      district: String(r.district || '').trim(),
      entity: String(r.entity || '').trim(),
      openedOn: normalizeDateString(String(r.openedOn || '').trim()),
      am: String(r.am || '').trim().toLowerCase(),
      status: (String(r.status || 'active').trim().toLowerCase() || 'active'),
      closedDate: normalizeDateString(String(r.closedDate || '').trim()),
      soldDate: normalizeDateString(String(r.soldDate || '').trim()),
      notes: String(r.notes || '').trim(),
      lastSyncedAt: String(r.lastSyncedAt || '').trim(),
    }))
  } catch (err) {
    console.warn('[getAllData] SalonRoster fetch failed, continuing without it:', err)
    return []
  }
}

/**
 * Build a globalId → { inactive, inactiveDate } map from EmployeeProfile.
 *
 * PRIVACY: deliberately extracts ONLY the inactive flag + date and the join
 * key. The email (PII) stays server-side and is NEVER included here, so this
 * map is safe to send to the client. The dashboard uses it to mark inactive
 * employees in bonus views and to exclude them from the ADP export.
 */
async function fetchInactiveMap(): Promise<Record<string, { inactive: boolean; inactiveDate: string }>> {
  try {
    const rows = rowsToObjects(await readSheet('EmployeeProfile'))
    const map: Record<string, { inactive: boolean; inactiveDate: string }> = {}
    for (const r of rows) {
      const gid = String((r as any).globalId || '').trim()
      if (!gid) continue
      map[gid] = {
        inactive: String((r as any).inactive || '').trim().toLowerCase() === 'true',
        inactiveDate: String((r as any).inactiveDate || '').trim(),
      }
    }
    return map
  } catch (err) {
    console.warn('[getAllData] inactive map fetch failed, continuing without it:', err)
    return {}
  }
}

/**
 * Normalize a date string to YYYY-MM-DD.
 * Handles:
 *   - "5/15/2026"   → "2026-05-15"
 *   - "5/15/26"     → "2026-05-15"   (assumes 2000s)
 *   - "2026-05-15"  → "2026-05-15"   (already correct)
 *   - "5/15/2026 0:00:00" → "2026-05-15"  (strips time)
 * Returns the original string if it can't parse it (so we don't lose data).
 */
function normalizeDateString(s: string): string {
  if (!s) return s
  const trimmed = String(s).trim()

  // Already YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)

  // M/D/YYYY or MM/DD/YYYY (optionally with time)
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (match) {
    let [, m, d, y] = match
    if (y.length === 2) y = '20' + y
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  return trimmed
}

function formatAllData(raw: any, scrapedWeeks: any[], rosterRows: any[]) {
  // ── Weeks: scraped salon data is the source of truth; emp data joined by normalized weekEnding ──
  const weekMap: Record<string, any> = {}

  // Seed weekMap with scraped salon rows (canonical YYYY-MM-DD keys)
  scrapedWeeks.forEach((w: any) => {
    weekMap[w.weekEnding] = {
      weekEnding: w.weekEnding,
      salons: w.salons,
      emps: [],
    }
  })

  // Layer in employee rows — normalize their weekEnding to YYYY-MM-DD so they
  // merge correctly with scraped weeks (no more duplicate dropdown entries).
  // SD_EMP_WEEKLY uses weekEnd / productPct / employeeName; the dashboard reads
  // weekEnding / product / empName — alias them here so no client change is needed.
  raw.empRows.forEach((row: any) => {
    const rawWk = row.weekEnding || row.weekEnd || ''
    if (!rawWk) return
    const wk = normalizeDateString(rawWk)
    if (!weekMap[wk]) weekMap[wk] = { weekEnding: wk, salons: [], emps: [] }
    weekMap[wk].emps.push({
      ...row,
      weekEnding: wk,
      product: row.product ?? row.productPct ?? '',
      empName: row.empName ?? row.employeeName ?? '',
      payroll: row.payroll ?? row.payrollPct ?? '',
    })
  })

  const weeks = Object.values(weekMap).sort((a: any, b: any) =>
    new Date(a.weekEnding).getTime() - new Date(b.weekEnding).getTime()
  )

  // ── Tracker data ───────────────────────────────────────────
  const trackerData: Record<string, any[]> = {}
  raw.trackerRows.forEach((row: any) => {
    const id = row.globalId || ''
    if (!id) return
    if (!trackerData[id]) trackerData[id] = []
    trackerData[id].push(row)
  })

  // ── Bonus periods ──────────────────────────────────────────
  const bonusMap: Record<string, any> = {}
  raw.bonusRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!bonusMap[pk]) bonusMap[pk] = {
      periodKey: pk, periodLabel: row.periodLabel || pk,
      weeksN: parseInt(row.weeksN) || 4, employees: []
    }
    bonusMap[pk].employees.push(row)
  })

  // ── Salon summary periods ──────────────────────────────────
  const ssMap: Record<string, any> = {}
  raw.salonSummaryRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!ssMap[pk]) ssMap[pk] = {
      periodKey: pk, periodLabel: row.periodLabel || pk,
      weeksN: parseInt(row.weeksN) || 4, salons: []
    }
    ssMap[pk].salons.push(row)
  })

  // ── Payroll consolidated periods ───────────────────────────
  const pcMap: Record<string, any> = {}
  raw.payrollRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!pcMap[pk]) pcMap[pk] = {
      periodKey: pk, periodLabel: row.periodLabel || pk,
      weeksN: parseInt(row.weeksN) || 4, employees: []
    }
    // Coerce hours to numbers — readSheet returns formatted strings, and the
    // bonus cards call .toFixed() on these directly (manager + AM cards).
    pcMap[pk].employees.push({
      ...row,
      avgWeeklyQualifying: Number(row.avgWeeklyQualifying) || 0,
      floorHoursTotal: Number(row.floorHoursTotal) || 0,
    })
  })

  // ── Manager table — return as ARRAY (dashboard expects forEach) ──
  const managerTable = raw.managerRows.map((row: any) => ({
    salonNum: row.salonNum || '',
    managerName: row.managerName || '',
    globalId: row.globalId || '',
  })).filter((r: any) => r.salonNum)

  // ── AM assignments — effective-dated salon→AM history ──────
  const amAssignments = (raw.amAssignmentRows || []).map((row: any) => ({
    salonNum: String(row.salonNum || '').trim(),
    amKey: String(row.amKey || '').trim().toLowerCase(),
    startPeriod: String(row.startPeriod || '').trim(),
    endPeriod: String(row.endPeriod || '').trim(),
    notes: String(row.notes || '').trim(),
  })).filter((r: any) => r.salonNum)

  // ── Home employees ─────────────────────────────────────────
  const homeEmployees = raw.homeRows.map((row: any) => ({
    name: row.payrollName || '', globalId: row.globalId || '', salon: row.homeSalon || ''
  })).filter((e: any) => e.name && e.globalId)
  Object.values(AMS).forEach((am: any) => {
    if (am.globalId && !homeEmployees.find((e: any) => e.globalId === am.globalId)) {
      homeEmployees.push({ name: am.name + ' (AM)', globalId: am.globalId, salon: 'AM' })
    }
  })
  homeEmployees.sort((a: any, b: any) => a.name.localeCompare(b.name))

  // ── Home data map (for tracker) ────────────────────────────
  const homeDataMap: Record<string, any> = {}
  raw.homeRows.forEach((row: any) => {
    const id = row.globalId || ''
    if (id) homeDataMap[id] = row
  })

  return {
    success: true,
    weeks,
    weekCount: weeks.length,
    trackerData,
    bonusPeriods: Object.values(bonusMap),
    salonSummaryPeriods: Object.values(ssMap),
    payrollConsolidatedPeriods: Object.values(pcMap),
    managerTable,
    penaltyWaivers: raw.waiverRows,
    amAssignments,
    homeEmployees,
    homeDataMap,
    homeCount: raw.homeRows.length,
    homeEffectiveDate: raw.homeRows[0]?.effectiveDate || '',
    homeRetroUpdated: 0,
    lyAvg: null,
    salonRoster: rosterRows,
  }
}