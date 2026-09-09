// app/api/leases/abstract/route.ts
//
// LEASE-ABSTRACT-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   POST { lines?: string[], text?: string, fileName?: string }
//     -> { success, proposal }
//
// Read a dropped document and PROPOSE what it means. Writes nothing, ever —
// the browser shows the proposal, a person confirms or corrects it, and only
// then does /api/leases/cam save anything.
//
// The bytes never come here. The browser has already put the file in the Blob
// store and pulled the text out of it with the column positions intact (see
// lib/lease-abstract.ts for why the positions matter), so this route receives
// a few kilobytes of text rather than a 30 MB scan.
//
// edit.leases, like the rest of the write side of this feature: a proposal is
// the first half of an edit, and it exposes the whole portfolio's landlords
// and areas in the process of matching one.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
import { listLeases } from '@/lib/lease-records'
import { abstractDocument, type LeaseLite } from '@/lib/lease-abstract'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max = 400) => String(v ?? '').trim().slice(0, max)

/** A document that needs more than this is not a reconciliation letter. */
const MAX_LINES = 4000
const MAX_TEXT = 400_000

export async function POST(req: Request) {
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }

  const lines = Array.isArray(body?.lines)
    ? body.lines.slice(0, MAX_LINES).map((l: unknown) => String(l ?? '').slice(0, 2000))
    : []
  const text = String(body?.text ?? '').slice(0, MAX_TEXT)
  if (!lines.length && !text.trim()) {
    return NextResponse.json({ success: false, error: 'nothing to read' }, { status: 400 })
  }

  try {
    const leases: LeaseLite[] = (await listLeases()).map(l => ({
      salonNum: String(l.salonNum || ''),
      locationName: String(l.locationName || ''),
      landlord: String(l.landlord || ''),
      address: String(l.address || ''),
      areaSqFt: Number(l.areaSqFt) || 0,
    })).filter(l => l.salonNum)

    const proposal = abstractDocument({ lines, text, fileName: S(body?.fileName, 200) }, leases)

    // What the record says today, so the browser can show the change rather
    // than just the new number. Only for the salon we actually landed on.
    const top = proposal.salonGuesses[0]
    const current = top
      ? (await listLeases()).find(l => String(l.salonNum) === top.salonNum) || null
      : null

    return NextResponse.json({
      success: true,
      proposal,
      current: current ? {
        salonNum: current.salonNum,
        locationName: current.locationName,
        camMonthly: Number(current.camMonthly) || 0,
        monthlyRent: Number(current.monthlyRent) || 0,
        areaSqFt: Number(current.areaSqFt) || 0,
      } : null,
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
