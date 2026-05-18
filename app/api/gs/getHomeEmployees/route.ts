import { NextResponse } from 'next/server'
import { getHomeData } from '@/lib/sheets'
import { AMS } from '@/lib/config'

export async function GET() {
  try {
    const rows = await getHomeData()
    const employees = rows.map((row: any) => ({
      name: row.payrollName || '', globalId: row.globalId || '', salon: row.homeSalon || ''
    })).filter((e: any) => e.name && e.globalId)
    Object.values(AMS).forEach((am: any) => {
      if (am.globalId && !employees.find((e: any) => e.globalId === am.globalId)) {
        employees.push({ name: am.name + ' (AM)', globalId: am.globalId, salon: 'AM' })
      }
    })
    employees.sort((a: any, b: any) => a.name.localeCompare(b.name))
    return NextResponse.json({ success: true, employees })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message, employees: [] })
  }
}
