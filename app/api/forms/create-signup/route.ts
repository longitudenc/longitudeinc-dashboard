// app/api/forms/create-signup/route.ts
//
// One-click volunteer / RSVP sign-up sheet for an Important Date.
//
// The Forms engine already does everything a sign-up needs — audience gating,
// a submission queue, comments, CSV export — so this does NOT invent a new
// kind of object. It writes one FormDefs row and three FormFields rows, and
// hands back the link the event's `signupUrl` should point at. Responses land
// in the same Requests queue as everything else, so there is no second place
// to check.
//
// Owner/admin only, matching /api/home/save: creating a form that everyone can
// see is an edit to shared content.
//
// POST { eventId, title, date?, time?, audience? }
//   -> { success, formId, url, created }
//
// Idempotent: an event that already has a sign-up form gets the existing one
// back rather than a duplicate, so double-clicking the button is harmless.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { readSheet, appendSheet, rowsToObjects } from '@/lib/sheets'
import { TAB_DEFS, TAB_FIELDS, DEFS_COLUMNS, FIELDS_COLUMNS } from '@/lib/forms'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const str = (v: unknown) => String(v ?? '').trim()

/** A stable, readable formId from the event id. */
function signupIdFor(eventId: string): string {
  const slug = str(eventId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return 'signup-' + (slug || 'event')
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const eventId = str(body?.eventId)
    const title = str(body?.title)
    if (!eventId || !title) {
      return NextResponse.json({ success: false, error: 'eventId and title are required' }, { status: 400 })
    }

    const formId = signupIdFor(eventId)
    // /dashboard.html, NOT "/" — "/" is the public marketing page, which drops
    // the query string and never reaches the ?form= handler.
    const url = `/dashboard.html?form=${encodeURIComponent(formId)}`

    // Already exists? Hand back the same link. Read fresh: FormDefs is in
    // NO_CACHE_TABS, but being explicit costs nothing and this is a
    // read-then-write.
    const existing = rowsToObjects((await readSheet(TAB_DEFS, undefined, { fresh: true })) || [])
    if (existing.some(r => str(r.formId) === formId)) {
      return NextResponse.json({ success: true, formId, url, created: false })
    }

    const when = [str(body?.date), str(body?.time)].filter(Boolean).join(' · ')
    // The event's own note is the description people actually need ("3
    // volunteers needed to hand out..."). Falling back to a generic line only
    // when there is no note means the form never says less than the event did.
    const note = str(body?.note)
    const described = [when, note].filter(Boolean).join(' — ')
    const def: Record<string, string> = {
      formId,
      title: `Sign up: ${title}`,
      description: described || 'Let us know if you can make it.',
      icon: '🙋',
      // Blank audience = everyone. A volunteer sheet nobody can see is useless;
      // narrow it afterwards in Manage access if the event is not for all staff.
      audience: str(body?.audience),
      status: 'active',
      sortOrder: '900',
      // `record` = collect responses, no approval chain. An RSVP is not a ticket.
      workflow: 'record',
    }

    // NOTE: option lists must not contain commas — the engine splits options on
    // '|', ';' AND ',', so a comma inside a label would silently become two
    // options. Pipes only.
    const fields = [
      { formId, fieldKey: 'attending', label: 'Can you make it?', type: 'select', required: 'yes',
        options: 'Yes|No|Maybe', placeholder: '', help: '', sortOrder: '10' },
      { formId, fieldKey: 'guests', label: 'How many people are you bringing?', type: 'number', required: 'no',
        options: '', placeholder: '0', help: 'Including yourself.', sortOrder: '20' },
      { formId, fieldKey: 'note', label: 'Anything we should know?', type: 'textarea', required: 'no',
        options: '', placeholder: '', help: '', sortOrder: '30' },
    ]

    await appendSheet(TAB_DEFS, [DEFS_COLUMNS.map(c => def[c] ?? '')])
    await appendSheet(TAB_FIELDS, fields.map(f => FIELDS_COLUMNS.map(c => (f as any)[c] ?? '')))

    return NextResponse.json({ success: true, formId, url, created: true })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
