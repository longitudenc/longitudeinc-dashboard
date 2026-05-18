import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export async function GET() {
  try {
    const rows = await readSheet('DiscPoints')
    const data = rowsToObjects(rows)
    const points: Record<string, any[]> = {}
    data.forEach((row: any) => {
      const id = row.globalId || ''
      if (!id) return
      if (!points[id]) points[id] = []
      points[id].push(row)
    })
    return NextResponse.json({ success: true, points })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message, points: {} })
  }
}
