// app/api/forms/fields/route.ts
//
// Edit the QUESTIONS on a form.
//
// The sign-up sheets created from an event ship with a fixed set of questions,
// and "How many people are you bringing?" is wrong for a volunteer shift. Until
// now the only way to change that was editing the FormFields tab by hand, which
// is exactly the sort of thing this dashboard exists to avoid.
//
//   GET  ?formId=…            -> that form's fields, in order
//   POST { formId, fields }   -> replace that form's fields
//
// Owner/admin only. A form's questions are shared content, same as the audience
// settings next to them.
//
// Rewrites the whole FormFields tab, preserving every OTHER form's rows
// untouched. The tab is small (a few hundred rows) and a full rewrite keeps
// column alignment guaranteed — the same approach /api/home/save takes.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'
import { TAB_FIELDS, FIELDS_COLUMNS, FIELD_TYPES } from '@/lib/forms'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max)

/** A stable key from a label, so a new question does not need one typed. */
function keyFrom(label: string, taken: Set<string>): string {
  let base = str(label, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field'
  let k = base, n = 2
  while (taken.has(k)) { k = base + '_' + n; n++ }
  taken.add(k)
  return k
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const formId = str(new URL(req.url).searchParams.get('formId'))
    if (!formId) return NextResponse.json({ success: false, error: 'formId required' }, { status: 400 })
    const rows = rowsToObjects((await readSheet(TAB_FIELDS, undefined, { fresh: true })) || [])
    const fields = rows
      .filter(r => str(r.formId) === formId)
      .sort((a, b) => (parseInt(str(a.sortOrder), 10) || 0) - (parseInt(str(b.sortOrder), 10) || 0))
    return NextResponse.json({ success: true, formId, fields, fieldTypes: FIELD_TYPES })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const formId = str(body?.formId)
    if (!formId) return NextResponse.json({ success: false, error: 'formId required' }, { status: 400 })

    const incoming: any[] = Array.isArray(body?.fields) ? body.fields : []
    const taken = new Set<string>()
    const clean: Record<string, string>[] = []

    for (let i = 0; i < incoming.length; i++) {
      const r = incoming[i]
      const label = str(r?.label, 200)
      if (!label) continue                       // a blank row the editor left behind
      const type = str(r?.type).toLowerCase()
      if (!(FIELD_TYPES as readonly string[]).includes(type)) {
        return NextResponse.json({ success: false, error: `"${str(r?.type)}" is not a field type. Valid: ${FIELD_TYPES.join(', ')}` }, { status: 400 })
      }
      // An existing key is kept so answers already submitted still line up with
      // their question; only new rows get a generated one.
      const existingKey = str(r?.fieldKey, 60)
      const fieldKey = existingKey && !taken.has(existingKey)
        ? (taken.add(existingKey), existingKey)
        : keyFrom(label, taken)

      // Option lists must not contain commas: the engine splits on '|', ';' AND
      // ',', so a comma inside a label silently becomes two options. Normalise
      // whatever separator was typed onto pipes and strip commas.
      const options = str(r?.options, 1000)
        .split(/[|;,]/).map(s => s.trim()).filter(Boolean).join('|')

      clean.push({
        formId, fieldKey, label, type,
        required: r?.required ? 'yes' : '',
        options,
        placeholder: str(r?.placeholder, 200),
        help: str(r?.help, 500),
        sortOrder: String((i + 1) * 10),
      })
    }

    if (!clean.length) {
      return NextResponse.json({ success: false, error: 'A form needs at least one question.' }, { status: 400 })
    }

    // Read fresh: this is a read-modify-write over a tab other forms share.
    const existing = (await readSheet(TAB_FIELDS, undefined, { fresh: true })) as any[][]
    const header: string[] = (existing?.[0] || []).map((h: any) => str(h))
    const finalHeader = header.length ? header : [...FIELDS_COLUMNS]
    const idx = (name: string) => finalHeader.findIndex(h => h.toLowerCase() === name.toLowerCase())
    const formIdIdx = idx('formId')

    const kept: any[][] = []
    if (formIdIdx >= 0) {
      for (const row of (existing || []).slice(1)) {
        if (str(row?.[formIdIdx]) !== formId) kept.push(row)
      }
    }

    const added = clean.map(f => finalHeader.map(h => {
      const i = FIELDS_COLUMNS.findIndex(c => c.toLowerCase() === h.toLowerCase())
      return i >= 0 ? (f[FIELDS_COLUMNS[i]] ?? '') : ''
    }))

    await writeSheet(TAB_FIELDS, [finalHeader, ...kept, ...added])
    return NextResponse.json({ success: true, formId, saved: clean.length })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
