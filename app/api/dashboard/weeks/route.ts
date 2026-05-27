// app/api/dashboard/weeks/route.ts
//
// Returns SD_WEEKLY data in the dashboard's expected SalonData format.
// Used by the dashboard's main data-loading path.

import { NextResponse } from 'next/server'
import { getDashboardWeeks } from '@/lib/dashboard-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  const startedAt = Date.now()
  try {
    const weeks = await getDashboardWeeks()
    const durationMs = Date.now() - startedAt
    return NextResponse.json({
      ok: true,
      durationMs,
      weekCount: weeks.length,
      weeks,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[dashboard/weeks] fatal:', msg)
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    )
  }
}