import { NextRequest, NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { requireSignedIn } from '@/lib/require-role'

export async function POST(req: NextRequest) {
  const gate = await requireSignedIn(); if (!gate.ok) return gate.response
  try {
    const { globalId, year } = await req.json()
    const rows = rowsToObjects(await readSheet('ReviewData'))
    const filtered = rows.filter((r: any) => 
      (!globalId || r.globalId === globalId) && (!year || r.year === String(year))
    )
    return NextResponse.json({ success: true, reviews: filtered })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message })
  }
}
