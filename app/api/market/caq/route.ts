// app/api/market/caq/route.ts
//
// Per-salon Customer Address Quality (% Good) map for the dashboard salon tables:
//   { "caq": { "1304": { "mtd": 0.692, "ytd": 0.6885, "latestPeriod": "Jun 26" }, ... } }
//
//   mtd = most recently completed month's % Good (raw decimal, 0.692 = 69.2%).
//   ytd = mean of that salon's monthly % Good for the latest year present
//         (calendar year-to-date average).
//
// Public GET + 5-min cache, mirroring /api/market/ratings-data. Reads SalonCAQData,
// the tab written by /api/market/ingest/address-quality. Joins to the dashboard's
// salon tables by salonNum (string).

import { NextResponse } from 'next/server'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TAB = 'SalonCAQData'
const CACHE_TTL = 5 * 60 * 1000
let cache: { caq: Record<string, any>; timestamp: number } | null = null

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const toNum = (v: any) => {
  if (v === '' || v == null || v === '***') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

// "Mon YY" -> sortable integer (year*12 + monthIndex); -1 if unparseable.
function periodSort(pk: string): number {
  const m = String(pk || '').trim().match(/^([A-Za-z]{3})\s+(\d{2})$/)
  if (!m) return -1
  const mi = MONTHS.indexOf(m[1])
  if (mi < 0) return -1
  return (2000 + parseInt(m[2], 10)) * 12 + mi
}

function periodYear(pk: string): number {
  const m = String(pk || '').trim().match(/^[A-Za-z]{3}\s+(\d{2})$/)
  return m ? 2000 + parseInt(m[1], 10) : -1
}

export async function GET() {
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return NextResponse.json({ success: true, caq: cache.caq, cached: true })
    }

    const rows = rowsToObjects((await readSheet(TAB)) || [])

    // Group each salon's monthly points, newest last.
    const bySalon: Record<string, { pk: string; sort: number; good: number }[]> = {}
    for (const r of rows) {
      const sn = String(r.salonNum ?? '').trim()
      if (!sn) continue
      const good = toNum(r.caqGood)
      if (good == null) continue
      const pk = String(r.periodKey ?? '').trim()
      const sort = periodSort(pk)
      if (sort < 0) continue
      if (!bySalon[sn]) bySalon[sn] = []
      bySalon[sn].push({ pk, sort, good })
    }

    const caq: Record<string, any> = {}
    for (const sn of Object.keys(bySalon)) {
      const list = bySalon[sn].sort((a, b) => a.sort - b.sort)
      const latest = list[list.length - 1]
      const yr = periodYear(latest.pk)
      const yearVals = list.filter(x => periodYear(x.pk) === yr).map(x => x.good)
      const ytd = yearVals.length ? yearVals.reduce((s, v) => s + v, 0) / yearVals.length : null
      caq[sn] = { mtd: latest.good, ytd, latestPeriod: latest.pk }
    }

    cache = { caq, timestamp: Date.now() }
    return NextResponse.json({ success: true, caq })
  } catch (error) {
    console.error('[market/caq]', error)
    return NextResponse.json({ success: false, caq: {} }, { status: 200 })
  }
}
