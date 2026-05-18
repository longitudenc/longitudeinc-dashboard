import { NextResponse } from 'next/server'
import { getAllDashboardData, getHomeData } from '@/lib/sheets'
import { AMS } from '@/lib/config'

let cache: { data: any; timestamp: number } | null = null
const CACHE_TTL = 3 * 60 * 1000 // 3 minutes

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

function formatAllData(data: any) {
  const weekMap: Record<string, any> = {}
  data.salonRows.forEach((row: any) => {
    const wk = row.weekEnding || ''
    if (!wk) return
    if (!weekMap[wk]) weekMap[wk] = { weekEnding: wk, salons: [], employees: [] }
    weekMap[wk].salons.push(row)
  })
  data.empRows.forEach((row: any) => {
    const wk = row.weekEnding || ''
    if (!wk) return
    if (!weekMap[wk]) weekMap[wk] = { weekEnding: wk, salons: [], employees: [] }
    weekMap[wk].employees.push(row)
  })
  const weeks = Object.values(weekMap).sort((a: any, b: any) =>
    new Date(a.weekEnding).getTime() - new Date(b.weekEnding).getTime()
  )
  const trackerData: Record<string, any[]> = {}
  data.trackerRows.forEach((row: any) => {
    const id = row.globalId || ''
    if (!id) return
    if (!trackerData[id]) trackerData[id] = []
    trackerData[id].push(row)
  })
  const bonusMap: Record<string, any> = {}
  data.bonusRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!bonusMap[pk]) bonusMap[pk] = { periodKey: pk, periodLabel: row.periodLabel || pk, weeksN: parseInt(row.weeksN) || 4, employees: [] }
    bonusMap[pk].employees.push(row)
  })
  const ssMap: Record<string, any> = {}
  data.salonSummaryRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!ssMap[pk]) ssMap[pk] = { periodKey: pk, periodLabel: row.periodLabel || pk, weeksN: parseInt(row.weeksN) || 4, salons: [] }
    ssMap[pk].salons.push(row)
  })
  const pcMap: Record<string, any> = {}
  data.payrollRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!pcMap[pk]) pcMap[pk] = { periodKey: pk, periodLabel: row.periodLabel || pk, weeksN: parseInt(row.weeksN) || 4, employees: [] }
    pcMap[pk].employees.push(row)
  })
  const managerTable: Record<string, any> = {}
  data.managerRows.forEach((row: any) => {
    const snum = row.salonNum || ''
    if (snum) managerTable[snum] = { name: row.managerName || '', globalId: row.globalId || '' }
  })
  const homeEmployees = data.homeRows.map((row: any) => ({
    name: row.payrollName || '', globalId: row.globalId || '', salon: row.homeSalon || ''
  })).filter((e: any) => e.name && e.globalId)
  Object.values(AMS).forEach((am: any) => {
    if (am.globalId && !homeEmployees.find((e: any) => e.globalId === am.globalId)) {
      homeEmployees.push({ name: am.name + ' (AM)', globalId: am.globalId, salon: 'AM' })
    }
  })
  return {
    success: true, weeks, weekCount: weeks.length, trackerData,
    bonusPeriods: Object.values(bonusMap),
    salonSummaryPeriods: Object.values(ssMap),
    payrollConsolidated: Object.values(pcMap),
    managerTable, penaltyWaivers: data.waiverRows,
    homeEmployees, lyAvg: null,
  }
}
