// app/api/leases/records/route.ts
//
// LEASE-RECORDS-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
// The lease records themselves, and everything the dashboard derives from them.
//
//   GET                          leases, options, action items, portfolio
//   POST { kind:'lease',  ... }  save one lease   (keyed on salonNum)
//   POST { kind:'option', ... }  save one option  (keyed on optionId)
//   DELETE ?salonNum=…           remove a lease
//   DELETE ?optionId=…           remove an option
//
// The derived figures — action items, portfolio totals, $/SF, term progress —
// are computed HERE rather than in the browser. Two reasons: a missed notice
// deadline is the one failure this feature exists to prevent, so the rule that
// finds it belongs somewhere testable; and a reminder job will need exactly the
// same list, which must not mean a second implementation that can disagree.
//
// Owner/admin, like the rest of /api/leases.

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { SALON_NAMES } from '@/lib/config'
import {
  listLeases, listOptions, upsertLease, upsertOption, removeLease, removeOption,
  actionItems, portfolio, rentPerSfYr, termProgress, todayISO,
  monthsBetween, LEASE_STATUSES,
} from '@/lib/lease-records'
import {
  listContacts, listClauses, upsertContact, upsertClause,
  removeContact, removeClause, askClauses, CLAUSE_TOPICS, CONTACT_ROLES,
} from '@/lib/lease-detail'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max)

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const today = todayISO()
    // Fresh: this screen is read straight after saving from it.
    const [leases, options, contacts, clauses] = await Promise.all([
      listLeases(true), listOptions(true), listContacts(true), listClauses(true),
    ])
    const salonNums = Object.keys(SALON_NAMES).sort()

    // Fill the display name from the salon list when the record has none, so a
    // half-entered lease still reads as a place rather than a bare number.
    for (const l of leases) {
      if (!l.locationName) l.locationName = SALON_NAMES[l.salonNum] || ''
    }

    const timeline = leases
      .filter(l => l.status === 'active' || l.status === 'month-to-month')
      .sort((a, b) => (a.expirationDate || '9999').localeCompare(b.expirationDate || '9999'))
      .map(l => ({
        ...l,
        rentPerSfYr: rentPerSfYr(l),
        termProgress: termProgress(l, today),
        monthsLeft: l.expirationDate ? monthsBetween(today, l.expirationDate) : null,
      }))

    return NextResponse.json({
      success: true,
      today,
      leases,
      options,
      timeline,
      actions: actionItems(leases, options, today),
      portfolio: portfolio(leases, today, salonNums),
      contacts,
      clauses,
      salons: salonNums.map(num => ({ num, name: SALON_NAMES[num] })),
      clauseTopics: [...CLAUSE_TOPICS],
      contactRoles: [...CONTACT_ROLES],
      statuses: [...LEASE_STATUSES],
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const body = await req.json()
    const kind = S(body?.kind, 20)

    if (kind === 'contact') {
      const salonNum = S(body?.salonNum, 20)
      if (!salonNum) {
        return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
      }
      const contact = await upsertContact({
        contactId: S(body?.contactId, 60) || undefined,
        salonNum,
        role: body?.role !== undefined ? S(body.role, 60) : undefined,
        org: body?.org !== undefined ? S(body.org, 200) : undefined,
        name: body?.name !== undefined ? S(body.name, 120) : undefined,
        email: body?.email !== undefined ? S(body.email, 200) : undefined,
        phone: body?.phone !== undefined ? S(body.phone, 60) : undefined,
        address: body?.address !== undefined ? S(body.address, 300) : undefined,
        note: body?.note !== undefined ? S(body.note, 500) : undefined,
      })
      return NextResponse.json({ success: true, contact })
    }

    if (kind === 'clause') {
      const salonNum = S(body?.salonNum, 20)
      if (!salonNum) {
        return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
      }
      const clause = await upsertClause({
        clauseId: S(body?.clauseId, 60) || undefined,
        salonNum,
        topic: body?.topic !== undefined ? S(body.topic, 60) : undefined,
        summary: body?.summary !== undefined ? S(body.summary, 1000) : undefined,
        // The lease’s own words. Generous, because a clause quoted in
        // part is a clause that can mislead.
        text: body?.text !== undefined ? S(body.text, 8000) : undefined,
        sourceDoc: body?.sourceDoc !== undefined ? S(body.sourceDoc, 300) : undefined,
        section: body?.section !== undefined ? S(body.section, 80) : undefined,
        note: body?.note !== undefined ? S(body.note, 1000) : undefined,
      })
      return NextResponse.json({ success: true, clause })
    }

    if (kind === 'ask') {
      // Retrieval over recorded clauses — see askClauses() for why this is
      // not a language model.
      const clauses = await listClauses()
      const answer = askClauses(S(body?.question, 500), clauses, Object.keys(SALON_NAMES))
      return NextResponse.json({ success: true, ...answer })
    }

    if (kind === 'option') {
      const salonNum = S(body?.salonNum, 20)
      if (!salonNum) {
        return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
      }
      const option = await upsertOption({
        optionId: S(body?.optionId, 60) || undefined,
        salonNum,
        optionNo: body?.optionNo !== undefined ? Number(body.optionNo) || 1 : undefined,
        noticeBy: body?.noticeBy !== undefined ? S(body.noticeBy, 40) : undefined,
        effectiveFrom: body?.effectiveFrom !== undefined ? S(body.effectiveFrom, 40) : undefined,
        effectiveTo: body?.effectiveTo !== undefined ? S(body.effectiveTo, 40) : undefined,
        exercised: body?.exercised !== undefined ? S(body.exercised, 10) : undefined,
        note: body?.note !== undefined ? S(body.note, 500) : undefined,
      })
      return NextResponse.json({ success: true, option })
    }

    const salonNum = S(body?.salonNum, 20)
    if (!salonNum) {
      return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
    }
    if (!Object.prototype.hasOwnProperty.call(SALON_NAMES, salonNum)) {
      return NextResponse.json({ success: false, error: `${salonNum} is not one of our salons` }, { status: 400 })
    }
    const lease = await upsertLease({
      salonNum,
      locationName: body?.locationName !== undefined ? S(body.locationName, 120) : undefined,
      landlord: body?.landlord !== undefined ? S(body.landlord, 200) : undefined,
      address: body?.address !== undefined ? S(body.address, 300) : undefined,
      areaSqFt: body?.areaSqFt !== undefined ? Number(String(body.areaSqFt).replace(/[,\s]/g, '')) || 0 : undefined,
      commencementDate: body?.commencementDate !== undefined ? S(body.commencementDate, 40) : undefined,
      expirationDate: body?.expirationDate !== undefined ? S(body.expirationDate, 40) : undefined,
      monthlyRent: body?.monthlyRent !== undefined ? Number(String(body.monthlyRent).replace(/[$,\s]/g, '')) || 0 : undefined,
      camMonthly: body?.camMonthly !== undefined ? Number(String(body.camMonthly).replace(/[$,\s]/g, '')) || 0 : undefined,
      securityDeposit: body?.securityDeposit !== undefined ? Number(String(body.securityDeposit).replace(/[$,\s]/g, '')) || 0 : undefined,
      status: body?.status !== undefined ? S(body.status, 30) : undefined,
      note: body?.note !== undefined ? S(body.note, 2000) : undefined,
    }, gate.email)
    return NextResponse.json({ success: true, lease })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const url = new URL(req.url)
    const contactId = S(url.searchParams.get('contactId'), 60)
    if (contactId) {
      return NextResponse.json({ success: true, removed: await removeContact(contactId) })
    }
    const clauseId = S(url.searchParams.get('clauseId'), 60)
    if (clauseId) {
      return NextResponse.json({ success: true, removed: await removeClause(clauseId) })
    }
    const optionId = S(url.searchParams.get('optionId'), 60)
    if (optionId) {
      return NextResponse.json({ success: true, removed: await removeOption(optionId) })
    }
    const salonNum = S(url.searchParams.get('salonNum'), 20)
    if (!salonNum) {
      return NextResponse.json({ success: false, error: 'salonNum or optionId is required' }, { status: 400 })
    }
    return NextResponse.json({ success: true, removed: await removeLease(salonNum) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
