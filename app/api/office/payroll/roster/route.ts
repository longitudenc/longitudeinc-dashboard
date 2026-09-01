// app/api/office/payroll/roster/route.ts
//
// Who can be paid this week, for the pickers on the Manual Earnings screen.
//
// Hand-keying a Payroll ID is where a manual line goes wrong: one wrong digit
// pays the wrong person, or nobody — the build reports that as an orphan
// earning, but only after the fact. So the screen offers the roster instead.
//
// The roster comes from SD_EMP_WEEKLY — the nightly employee scrape, one row
// per employee per salon per week, already carrying Payroll ID. That means one
// cached Sheets read rather than a live SD3 pull, so the picker is instant and
// costs nothing. A week that hasn't been scraped yet falls back to the most
// recent week on the tab, and says which week it used.
//
//   GET ?weekEnd=YYYY-MM-DD

import { NextResponse } from 'next/server'
import { requireOffice } from '@/lib/require-role'
import { readSheet, rowsToObjects } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SD_EMP_WEEKLY_TAB = 'SD_EMP_WEEKLY'
const SALON_ROSTER_TAB = 'SalonRoster'

interface RosterEntry {
  payId: string
  name: string
  globalId: string
  salons: string[]
}

/** Match the payroll report's Payroll ID handling: no leading zeros. */
function normalizePayId(raw: string): string {
  const s = String(raw || '').trim()
  return /^0\d+$/.test(s) ? (s.replace(/^0+/, '') || '0') : s
}

export async function GET(request: Request) {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response

  const weekEnd = new URL(request.url).searchParams.get('weekEnd') || ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
    return NextResponse.json({ success: false, error: 'weekEnd must be YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const rows = rowsToObjects(await readSheet(SD_EMP_WEEKLY_TAB))
    const weeks = [...new Set(rows.map(r => String(r.weekEnd || '').trim()).filter(Boolean))].sort()
    // The requested week if it has been scraped, otherwise the newest there is.
    const useWeek = weeks.includes(weekEnd) ? weekEnd : (weeks[weeks.length - 1] || '')

    const byPay = new Map<string, RosterEntry>()
    for (const r of rows) {
      if (String(r.weekEnd || '').trim() !== useWeek) continue
      const payId = normalizePayId(String(r.payId || ''))
      const name = String(r.employeeName || '').trim()
      if (!payId || !name) continue
      let e = byPay.get(payId)
      if (!e) byPay.set(payId, (e = { payId, name, globalId: String(r.globalId || '').trim(), salons: [] }))
      const salon = String(r.salonNum || '').trim()
      if (salon && !e.salons.includes(salon)) e.salons.push(salon)
    }

    let activeSalons: string[] = []
    try {
      activeSalons = rowsToObjects(await readSheet(SALON_ROSTER_TAB))
        .filter(r => { const st = String(r.status ?? '').trim().toLowerCase(); return !st || st === 'active' })
        .map(r => String(r.salonNum ?? '').trim()).filter(Boolean).sort()
    } catch { activeSalons = [] }   // no roster -> the picker falls back to all

    const employees = [...byPay.values()]
      .map(e => ({ ...e, salons: e.salons.sort() }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({
      success: true,
      weekEnd,
      // Which week the names actually came from. The screen says so when it is
      // not the week being paid, rather than implying a roster it doesn't have.
      sourceWeekEnd: useWeek,
      employees,
      // Salons still open. The ADP settings map carries every salon that ever
      // had a co-code — 3446, 1082 and 8725 among them — which is right for
      // rebuilding an old week and wrong for a picker.
      activeSalons,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[office/payroll/roster]', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
