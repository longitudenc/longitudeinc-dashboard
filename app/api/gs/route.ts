import { NextRequest, NextResponse } from 'next/server'
import { getAllDashboardData, getHomeData } from '@/lib/sheets'
import { AMS } from '@/lib/config'

// ── getAllData ────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const method = req.nextUrl.searchParams.get('method') || 'getAllData'
  
  try {
    if (method === 'getAllData') {
      const data = await getAllDashboardData()
      return NextResponse.json(formatAllData(data))
    }
    return NextResponse.json({ success: false, error: 'Unknown method' })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}

function formatAllData(data: any) {
  // Group salon rows by week
  const weekMap: Record<string, any> = {}
  
  data.salonRows.forEach((row: any) => {
    const wk = row.weekEnding || row.weekending || row['weekEnding'] || ''
    if (!wk) return
    if (!weekMap[wk]) weekMap[wk] = { weekEnding: wk, salons: [], employees: [] }
    weekMap[wk].salons.push(row)
  })

  data.empRows.forEach((row: any) => {
    const wk = row.weekEnding || row.weekending || ''
    if (!wk) return
    if (!weekMap[wk]) weekMap[wk] = { weekEnding: wk, salons: [], employees: [] }
    weekMap[wk].employees.push(row)
  })

  const weeks = Object.values(weekMap).sort((a: any, b: any) =>
    new Date(a.weekEnding).getTime() - new Date(b.weekEnding).getTime()
  )

  // Build tracker data from tracker rows
  const trackerData: Record<string, any[]> = {}
  data.trackerRows.forEach((row: any) => {
    const id = row.globalId || row.GlobalId || ''
    if (!id) return
    if (!trackerData[id]) trackerData[id] = []
    trackerData[id].push(row)
  })

  // Build bonus periods
  const bonusMap: Record<string, any> = {}
  data.bonusRows.forEach((row: any) => {
    const pk = row.periodKey || row.periodkey || ''
    if (!pk) return
    if (!bonusMap[pk]) bonusMap[pk] = {
      periodKey: pk,
      periodLabel: row.periodLabel || pk,
      weeksN: row.weeksN || 4,
      employees: []
    }
    bonusMap[pk].employees.push(row)
  })

  // Build salon summary periods
  const ssMap: Record<string, any> = {}
  data.salonSummaryRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!ssMap[pk]) ssMap[pk] = {
      periodKey: pk,
      periodLabel: row.periodLabel || pk,
      weeksN: row.weeksN || 4,
      salons: []
    }
    ssMap[pk].salons.push(row)
  })

  // Build payroll consolidated periods
  const pcMap: Record<string, any> = {}
  data.payrollRows.forEach((row: any) => {
    const pk = row.periodKey || ''
    if (!pk) return
    if (!pcMap[pk]) pcMap[pk] = {
      periodKey: pk,
      periodLabel: row.periodLabel || pk,
      weeksN: row.weeksN || 4,
      employees: []
    }
    pcMap[pk].employees.push(row)
  })

  // Build manager table
  const managerTable: Record<string, any> = {}
  data.managerRows.forEach((row: any) => {
    const snum = row.salonNum || row.salonnum || ''
    if (snum) managerTable[snum] = { name: row.managerName || row.managername || '', globalId: row.globalId || row.globalid || '' }
  })

  // Build penalty waivers
  const waiverMap: Record<string, any> = {}
  data.waiverRows.forEach((row: any) => {
    const key = `${row.salonNum || ''}_${row.period || ''}`
    waiverMap[key] = row
  })

  // Build home employees
  const homeEmployees = data.homeRows.map((row: any) => ({
    name: row.payrollName || row.payrollname || '',
    globalId: row.globalId || row.globalid || '',
    salon: row.homeSalon || row.homesalon || ''
  })).filter((e: any) => e.name && e.globalId)

  // Add AMs not in home file
  Object.values(AMS).forEach((am: any) => {
    if (am.globalId && !homeEmployees.find((e: any) => e.globalId === am.globalId)) {
      homeEmployees.push({ name: am.name + ' (AM)', globalId: am.globalId, salon: 'AM' })
    }
  })

  return {
    success: true,
    weeks,
    weekCount: weeks.length,
    trackerData,
    bonusPeriods: Object.values(bonusMap),
    salonSummaryPeriods: Object.values(ssMap),
    payrollConsolidated: Object.values(pcMap),
    managerTable,
    penaltyWaivers: data.waiverRows,
    homeEmployees,
    lyAvg: null,
  }
}
