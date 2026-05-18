import { NextResponse } from 'next/server'
import { getAllDashboardData } from '@/lib/sheets'
import { AMS } from '@/lib/config'

let cache: { data: any; timestamp: number } | null = null
const CACHE_TTL = 3 * 60 * 1000

export async function GET() {
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return NextResponse.json({ ...cache.data, cached: true })
    }
    const raw = await getAllDashboardData()
    const data = formatAllData(raw)
    cache = { data, timestamp: Date.now() }
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}

function formatAllData(raw: any) {
  // ── Weeks (salon + employee rows grouped by week) ──────────
  const weekMap: Record<string, any> = {}
  raw.salonRows.forEach((row: any) => {
    const wk = row.weekEnding || ''
    if (!wk) return
    if (!weekMap[wk]) weekMap[wk] = { weekEnding: wk, salons: [], emps: [] }
    weekMap[wk].salons.push(row)
  })
  raw.empRows.forEach((row: any) => {
    const wk = row.weekEnding || ''
    if (!wk) return
    if (!weekMap[wk]) weekMap[wk] = { weekEnding: wk, salons: [], emps: [] }
    weekMap[wk].emps.push(row)
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
    pcMap[pk].employees.push(row)
  })

  // ── Manager table — return as ARRAY (dashboard expects forEach) ──
  const managerTable = raw.managerRows.map((row: any) => ({
    salonNum: row.salonNum || '',
    managerName: row.managerName || '',
    globalId: row.globalId || '',
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
    payrollConsolidatedPeriods: Object.values(pcMap), // matches S_payrollConsolidated
    managerTable,           // array, not object
    penaltyWaivers: raw.waiverRows,
    homeEmployees,
    homeDataMap,
    homeCount: raw.homeRows.length,
    homeEffectiveDate: raw.homeRows[0]?.effectiveDate || '',
    homeRetroUpdated: 0,
    lyAvg: null,
  }
}
