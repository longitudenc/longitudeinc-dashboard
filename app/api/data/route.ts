import { NextResponse } from 'next/server'
import { getAllDashboardData } from '@/lib/sheets'

// Cache data for 5 minutes to avoid hammering Google Sheets API
let cache: { data: any; timestamp: number } | null = null
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export async function GET() {
  try {
    // Return cached data if fresh
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return NextResponse.json({ success: true, ...cache.data, cached: true })
    }

    const data = await getAllDashboardData()
    cache = { data, timestamp: Date.now() }

    return NextResponse.json({ success: true, ...data })
  } catch (error) {
    console.error('Dashboard data error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to load dashboard data' },
      { status: 500 }
    )
  }
}
