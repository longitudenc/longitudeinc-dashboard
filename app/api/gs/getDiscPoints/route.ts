// app/api/gs/getDiscPoints/route.ts
//
// Returns disciplinary-point EVENTS (not totals). Each row in the DiscPoints
// tab is a single event: when it was incurred and how many points. The client
// computes the active total per evaluation month using the rolling 12-month
// window, so this route just returns the raw events grouped by employee.
//
// Sheet schema (DiscPoints tab):
//   eventId | globalId | employeeName | points | date (YYYY-MM-DD) | reason | addedAt
//
// Tolerates a missing tab (returns empty) so getAllData / reviews never error.

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export async function GET() {
  try {
    let data: any[] = []
    try {
      data = rowsToObjects(await readSheet('DiscPoints'))
    } catch {
      return NextResponse.json({ success: true, events: [], byEmp: {} })
    }

    const events = data
      .map((row: any) => ({
        eventId: String(row.eventId || '').trim(),
        globalId: String(row.globalId || '').trim(),
        employeeName: String(row.employeeName || '').trim(),
        points: Number(row.points) || 0,
        date: String(row.date || '').trim(), // YYYY-MM-DD
        reason: String(row.reason || '').trim(),
        addedAt: String(row.addedAt || '').trim(),
      }))
      .filter((e) => e.globalId && e.points > 0 && e.date)

    // Group by globalId for convenient client lookup
    const byEmp: Record<string, any[]> = {}
    for (const e of events) {
      ;(byEmp[e.globalId] ||= []).push(e)
    }

    return NextResponse.json({ success: true, events, byEmp })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message, events: [], byEmp: {} })
  }
}
