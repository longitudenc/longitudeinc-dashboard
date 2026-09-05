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
import { requireCapability } from '@/lib/require-role'
import { SALON_NAMES } from '@/lib/config'
import { listFiles } from '@/lib/leases'
import {
  listLeases, listOptions, upsertLease, upsertOption, removeLease, removeOption,
  actionItems, portfolio, rentPerSfYr, termProgress, todayISO,
  monthsBetween, LEASE_STATUSES,
} from '@/lib/lease-records'
import {
  listContacts, listClauses, upsertContact, upsertClause,
  removeContact, removeClause, askClauses, CLAUSE_TOPICS, CONTACT_ROLES,
} from '@/lib/lease-detail'
import {
  listSteps, listCharges, upsertStep, upsertCharge, removeStep, removeCharge,
  currentStep, nextStep, chargeTotal, upcomingRentChanges, gaps,
} from '@/lib/lease-money'
import {
  readSettings, writeSettings, leaseAlertRecipients, maskEmail,
} from '@/lib/lease-settings'
import {
  listAsks, upsertAsk, removeAsk, renegotiationPlan, issueGroups,
  ASK_SEVERITIES,
} from '@/lib/lease-asks'
import { milestonesFor, sentLedger } from '@/lib/lease-notices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max)

/**
 * Salon order everywhere on this screen: by NUMBER, smallest first.
 *
 * Compared as numbers rather than as strings so the order does not quietly
 * break the day a salon number is not four digits — "982" sorts before "1304"
 * numerically and after it as text. The string compare is the tie-break, so
 * anything non-numeric still lands somewhere stable rather than at 0.
 */
const bySalonNum = (a: string, b: string) =>
  (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b)

export async function GET() {
  const gate = await requireCapability('view.leases')
  if (!gate.ok) return gate.response
  try {
    const today = todayISO()
    // Fresh: this screen is read straight after saving from it.
    const [leases, options, contacts, clauses, steps, charges, asks] = await Promise.all([
      listLeases(true), listOptions(true), listContacts(true), listClauses(true),
      listSteps(true), listCharges(true), listAsks(true),
    ])
    // Which salons have documents, for the gap report. Cheap: the tab is
    // metadata only, never the files themselves.
    const settings = await readSettings(true)
    const who = await leaseAlertRecipients(settings)
    let docSalons: string[] = []
    try {
      docSalons = [...new Set((await listFiles()).map(f => f.salonNum).filter(Boolean))]
    } catch { docSalons = [] }
    const salonNums = Object.keys(SALON_NAMES).sort(bySalonNum)
    // The sheet keeps whatever order rows were written in; the screen does not
    // inherit it. Sorted once here so every list built from `leases` agrees.
    leases.sort((a, b) => bySalonNum(a.salonNum, b.salonNum))

    // Fill the display name from the salon list when the record has none, so a
    // half-entered lease still reads as a place rather than a bare number.
    for (const l of leases) {
      if (!l.locationName) l.locationName = SALON_NAMES[l.salonNum] || ''
    }

    // By salon number, not by expiration date. What is coming at you soonest is
    // already the Action items card's job; this table is the one you scan to
    // find a salon you have in mind, and for that the number is the index.
    const timeline = leases
      .filter(l => l.status === 'active' || l.status === 'month-to-month')
      .sort((a, b) => bySalonNum(a.salonNum, b.salonNum))
      .map(l => {
        const cur = currentStep(steps, l.salonNum, today)
        const nxt = nextStep(steps, l.salonNum, today)
        const ch = charges.filter(c => c.salonNum === l.salonNum).slice(-1)[0] || null
        return {
          ...l,
          rentPerSfYr: rentPerSfYr(l),
          termProgress: termProgress(l, today),
          monthsLeft: l.expirationDate ? monthsBetween(today, l.expirationDate) : null,
          currentRent: cur ? cur.monthlyRent : null,
          nextRent: nxt ? { startDate: nxt.startDate, monthlyRent: nxt.monthlyRent } : null,
          camYear: ch ? ch.year : null,
          camMonthlyTotal: ch ? chargeTotal(ch) : null,
        }
      })

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
      steps,
      charges: charges.map(c => ({ ...c, total: chargeTotal(c) })),
      rentChanges: upcomingRentChanges(steps, salonNums, today, 60),
      gaps: gaps({
        leases, steps, charges, allSalons: salonNums, today,
        clauseSalons: [...new Set(clauses.map(c => c.salonNum))],
        docSalons,
      }),
      salons: salonNums.map(num => ({ num, name: SALON_NAMES[num] })),
      settings,
      // Masked, and with the layer that supplied them named, so "no email
      // arrived" can be told apart from "it went to the wrong list".
      alertRecipients: who.recipients.map(maskEmail),
      alertRecipientSource: who.source,
      clauseTopics: [...CLAUSE_TOPICS],
      contactRoles: [...CONTACT_ROLES],
      statuses: [...LEASE_STATUSES],
      // The renegotiation punch list, plus the two views that make it useful:
      // per salon in the order the conversations actually happen, and per
      // issue across the portfolio so a precedent elsewhere can be cited.
      asks,
      plan: renegotiationPlan(asks, leases, options, today),
      issues: issueGroups(asks),
      askSeverities: [...ASK_SEVERITIES],
      // Scheduled reminders. Anything whose deadline has already passed is
      // dropped — the Action items panel covers those, and a reminder about a
      // date behind you is noise.
      milestones: milestonesFor(leases, options, today, await sentLedger(true))
        .filter(m => m.daysUntilTarget >= 0)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response
  try {
    const body = await req.json()
    const kind = S(body?.kind, 20)

    if (kind === 'settings') {
      const saved = await writeSettings({
        alertEmail: body?.alertEmail !== undefined ? S(body.alertEmail, 500) : undefined,
        alertNote: body?.alertNote !== undefined ? S(body.alertNote, 300) : undefined,
      } as any)
      const now = await leaseAlertRecipients(saved)
      return NextResponse.json({
        success: true, settings: saved,
        alertRecipients: now.recipients.map(maskEmail),
        alertRecipientSource: now.source,
      })
    }

    if (kind === 'step') {
      const salonNum = S(body?.salonNum, 20)
      if (!salonNum) return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
      const step = await upsertStep({
        stepId: S(body?.stepId, 60) || undefined,
        salonNum,
        startDate: body?.startDate !== undefined ? S(body.startDate, 40) : undefined,
        endDate: body?.endDate !== undefined ? S(body.endDate, 40) : undefined,
        monthlyRent: body?.monthlyRent !== undefined ? Number(String(body.monthlyRent).replace(/[$,\s]/g, '')) || 0 : undefined,
        source: body?.source !== undefined ? S(body.source, 300) : undefined,
        note: body?.note !== undefined ? S(body.note, 500) : undefined,
      })
      return NextResponse.json({ success: true, step })
    }

    if (kind === 'charge') {
      const salonNum = S(body?.salonNum, 20)
      if (!salonNum) return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
      const money = (v: unknown) => Number(String(v ?? '').replace(/[$,\s]/g, '')) || 0
      const charge = await upsertCharge({
        chargeId: S(body?.chargeId, 60) || undefined,
        salonNum,
        year: body?.year !== undefined ? Number(body.year) || 0 : undefined,
        effectiveFrom: body?.effectiveFrom !== undefined ? S(body.effectiveFrom, 40) : undefined,
        cam: body?.cam !== undefined ? money(body.cam) : undefined,
        tax: body?.tax !== undefined ? money(body.tax) : undefined,
        insurance: body?.insurance !== undefined ? money(body.insurance) : undefined,
        waste: body?.waste !== undefined ? money(body.waste) : undefined,
        other: body?.other !== undefined ? money(body.other) : undefined,
        source: body?.source !== undefined ? S(body.source, 300) : undefined,
        note: body?.note !== undefined ? S(body.note, 500) : undefined,
      })
      return NextResponse.json({ success: true, charge })
    }

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

    // NOTE: 'ask' below is the question box. This one — the renegotiation
    // punch list — is deliberately called something else so the two cannot
    // be confused at the call site.
    if (kind === 'renegotiation') {
      const salonNum = S(body?.salonNum, 20)
      if (!salonNum) {
        return NextResponse.json({ success: false, error: 'salonNum is required' }, { status: 400 })
      }
      const saved = await upsertAsk({
        askId: S(body?.askId, 60) || undefined,
        salonNum,
        issue: body?.issue !== undefined ? S(body.issue, 120) : undefined,
        topic: body?.topic !== undefined ? S(body.topic, 60) : undefined,
        severity: body?.severity !== undefined ? S(body.severity, 20) : undefined,
        current: body?.current !== undefined ? S(body.current, 2000) : undefined,
        ask: body?.ask !== undefined ? S(body.ask, 2000) : undefined,
        precedent: body?.precedent !== undefined ? S(body.precedent, 200) : undefined,
        status: body?.status !== undefined ? S(body.status, 20) : undefined,
        note: body?.note !== undefined ? S(body.note, 2000) : undefined,
      })
      return NextResponse.json({ success: true, ask: saved })
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
  const gate = await requireCapability('edit.leases')
  if (!gate.ok) return gate.response
  try {
    const url = new URL(req.url)
    const stepId = S(url.searchParams.get('stepId'), 60)
    if (stepId) return NextResponse.json({ success: true, removed: await removeStep(stepId) })
    const chargeId = S(url.searchParams.get('chargeId'), 60)
    if (chargeId) return NextResponse.json({ success: true, removed: await removeCharge(chargeId) })
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
    const askId = S(url.searchParams.get('askId'), 60)
    if (askId) {
      return NextResponse.json({ success: true, removed: await removeAsk(askId) })
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
