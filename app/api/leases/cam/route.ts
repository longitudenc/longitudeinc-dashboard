// app/api/leases/cam/route.ts
//
// LEASE-CAM-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET  [?salonNum=9489]        rows + one summary line per salon per year
//   POST { salonNum, expenseYear, rows[], camMonthly? }   save a reconciliation
//   DELETE ?salonNum=&expenseYear=                        remove one
//
// Reading is view.leases and writing is edit.leases, matching the rest of the
// feature: a reconciliation is rent information, and rent is company-level.
//
// A SAVE REPLACES THAT SALON'S YEAR. Re-importing the same letter must produce
// the same state rather than a second copy of every pool, which is why the
// write is keyed on salon + expense year rather than appended.
//
// UPDATING camMonthly IS OPTIONAL AND EXPLICIT. The reconciliation says what
// the year actually cost; what the landlord will bill monthly NEXT year is a
// separate decision they make, and quietly overwriting the record with
// last year's twelfth would be a guess wearing a fact's clothes.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
import { listCam, saveRecon, removeRecon, summarise, type CamRow } from '@/lib/lease-cam'
import { listLeases, upsertLease } from '@/lib/lease-records'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max)
const N = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export async function GET(req: Request) {
  const gate = await requireCapability('view.leases')
  if (!gate.ok) return gate.response
  try {
    const salonNum = S(new URL(req.url).searchParams.get('salonNum'), 20)
    const all = await listCam()
    const rows = salonNum ? all.filter(r => r.salonNum === salonNum) : all
    return NextResponse.json({ success: true, rows, summaries: summarise(rows) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }

  const salonNum = S(body?.salonNum, 20)
  const expenseYear = S(body?.expenseYear, 4)
  if (!salonNum) return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
  if (!/^\d{4}$/.test(expenseYear)) {
    return NextResponse.json({ success: false, error: 'expenseYear must be four digits' }, { status: 400 })
  }
  const input = Array.isArray(body?.rows) ? body.rows : []
  if (!input.length) {
    return NextResponse.json({ success: false, error: 'no rows to save' }, { status: 400 })
  }
  if (input.length > 40) {
    return NextResponse.json({ success: false, error: 'too many rows for one reconciliation' }, { status: 400 })
  }
  // The salon must be one we actually hold a lease for. Without this a typo in
  // the picker files a landlord's numbers under a salon number that does not
  // exist, and nothing ever shows it again.
  const leases = await listLeases()
  const lease = leases.find(l => String(l.salonNum) === salonNum)
  if (!lease) {
    return NextResponse.json({ success: false, error: `no lease record for salon ${salonNum}` }, { status: 400 })
  }

  try {
    const rows: Partial<CamRow>[] = input.map((r: any) => ({
      pool: S(r?.pool, 40) || 'other',
      poolLabel: S(r?.poolLabel, 80),
      poolTotal: N(r?.poolTotal), deduction: N(r?.deduction), poolNet: N(r?.poolNet),
      tenantSf: N(r?.tenantSf), denominatorSf: N(r?.denominatorSf), sharePct: N(r?.sharePct),
      netShare: N(r?.netShare), adminFee: N(r?.adminFee),
      totalShare: N(r?.totalShare), billed: N(r?.billed), due: N(r?.due),
      landlord: S(r?.landlord, 200) || S(body?.landlord, 200),
      invoiceDate: S(r?.invoiceDate, 10) || S(body?.invoiceDate, 10),
      sourceFile: S(body?.sourceFile, 200),
      note: S(r?.note, 300),
    }))
    const saved = await saveRecon(salonNum, expenseYear, rows, gate.email)

    // Only when asked, and only ever the CAM estimate — never rent.
    let leaseUpdated = null as null | { camMonthly: number; was: number }
    if (body?.camMonthly !== undefined && body?.camMonthly !== null && body?.camMonthly !== '') {
      const was = Number(lease.camMonthly) || 0
      const now = Math.round(N(body.camMonthly) * 100) / 100
      if (now >= 0 && Math.abs(now - was) > 0.004) {
        await upsertLease({ salonNum, camMonthly: now }, gate.email)
        leaseUpdated = { camMonthly: now, was }
      }
    }

    const all = await listCam(true)
    return NextResponse.json({
      success: true, saved: saved.length, rows: saved, leaseUpdated,
      summaries: summarise(all.filter(r => r.salonNum === salonNum)),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response
  try {
    const q = new URL(req.url).searchParams
    const salonNum = S(q.get('salonNum'), 20), expenseYear = S(q.get('expenseYear'), 4)
    if (!salonNum || !/^\d{4}$/.test(expenseYear)) {
      return NextResponse.json({ success: false, error: 'salonNum and expenseYear are required' }, { status: 400 })
    }
    const removed = await removeRecon(salonNum, expenseYear)
    return NextResponse.json({ success: true, removed })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
