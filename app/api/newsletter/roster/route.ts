// app/api/newsletter/roster/route.ts
//
// NEWSLETTER-ROSTER-v1
//
// Roster feed for the monthly newsletter creator. Returns one entry per ACTIVE
// employee, shaped exactly like the newsletter's "Pull month" expects:
//
//   [ { "name": "First Last", "salon": "3015",
//       "hire": "YYYY-MM-DD",  // work-anniversary source (may be "")
//       "bday": "MM-DD" } ]    // birthday source, month-day only (may be "")
//
// Everything comes from EmployeeProfile, which the profile scrape now fills with
// dateOfHire + birthday (month-day only — no birth year, so no age is exposed).
// The newsletter does the month filtering client-side, so we return the full
// active roster and let it slice by the selected month.
//
// Gated to the roles that actually build newsletters (owner / admin / office).
// Returns a BARE JSON ARRAY on purpose: the newsletter's Roster loader accepts a
// pasted/fetched array directly, so you can open this URL, copy, and load it.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { getEmployeeProfiles } from '@/lib/sheets'

// "Last, First" -> "First Last"; leaves already-natural names untouched.
function displayName(name: string): string {
  const n = String(name || '').trim()
  if (n.includes(',')) {
    const [l, f] = n.split(',').map(x => x.trim())
    return `${f} ${l}`.trim()
  }
  return n
}

export async function GET() {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  if (!['owner', 'admin', 'office'].includes(gate.access.role)) {
    return NextResponse.json({ success: false, error: 'insufficient permissions' }, { status: 403 })
  }

  let profs: any[] = []
  try {
    profs = await getEmployeeProfiles()
  } catch {
    // Before the first profile scrape the tab may not exist — an empty roster is
    // a better failure than a 500 for the newsletter.
    return NextResponse.json([])
  }

  const roster: Array<{ name: string; salon: string; hire: string; bday: string }> = []
  for (const p of profs) {
    if (String(p?.inactive || '').toLowerCase() === 'true') continue
    const name = displayName(String(p?.name || ''))
    if (!name) continue

    const hireRaw = String(p?.dateOfHire || '').trim().slice(0, 10)
    const hire = /^\d{4}-\d{2}-\d{2}$/.test(hireRaw) ? hireRaw : ''

    const bdayRaw = String(p?.birthday || '').trim()
    const bday = /^\d{2}-\d{2}$/.test(bdayRaw) ? bdayRaw : ''

    // Skip people with neither date — they can't appear in either list.
    if (!hire && !bday) continue

    roster.push({ name, salon: String(p?.homeStoreNum || '').trim(), hire, bday })
  }

  roster.sort((a, b) => a.name.localeCompare(b.name))
  return NextResponse.json(roster, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
