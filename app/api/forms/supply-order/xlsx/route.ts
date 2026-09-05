// app/api/forms/supply-order/xlsx/route.ts
//
// SUPPLY-ORDER-XLSX-v1  (Ctrl+F this string to confirm the file saved)
//
//   POST { submissionId, lines?: [{item, qty}] }  -> an .xlsx download
//
// Amazon Business will not import a CSV, so the file is built as a real
// spreadsheet by lib/xlsx-min.ts. Columns match the template Amazon itself
// exports -- Line number / ASIN or ISBN / Quantity / Comment / Priority -- so
// the file goes back in through the same importer.
//
// POST rather than GET because the quantities on screen may not have been
// saved yet, and a file that quietly disagrees with what the person is looking
// at is worse than one that made them click Save first. Send the lines and the
// download matches the screen; omit them and it falls back to what was saved.
//
// Readable by anyone who can see the submission: downloading the order is not
// the same act as deciding it, and the office manager is not always the person
// who fetches the file.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { getSubmissions, getFormDefs, canViewSubmission } from '@/lib/forms'
import { listSupplyItems, getOrderLines } from '@/lib/supply-order'
import { sheetToXlsx } from '@/lib/xlsx-min'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown) => String(v ?? '').trim()

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  try {
    const body = await req.json().catch(() => ({}))
    const submissionId = S(body?.submissionId)
    if (!submissionId) {
      return NextResponse.json({ success: false, error: 'submissionId is required' }, { status: 400 })
    }

    const subs = await getSubmissions()
    const sub = subs.find(s => s.submissionId === submissionId)
    if (!sub) return NextResponse.json({ success: false, error: 'submission not found' }, { status: 404 })
    const defs = await getFormDefs()
    const def = defs.find(d => d.formId === sub.formId)
    const rv = def?.responseView || []
    if (!canViewSubmission(sub, gate.access, gate.effectiveEmail, rv)) {
      return NextResponse.json({ success: false, error: 'not allowed' }, { status: 403 })
    }

    // Everything ticked, read back off the form's own multiselect fields so the
    // order cannot drift from the request.
    const requested: string[] = []
    for (const f of def?.fields || []) {
      if (f.type !== 'multiselect') continue
      const v = sub.data?.[f.fieldKey]
      const arr = Array.isArray(v) ? v : (v ? [v] : [])
      for (const x of arr) { const t = S(x); if (t) requested.push(t) }
    }

    const [items, saved] = await Promise.all([listSupplyItems(), getOrderLines(submissionId)])
    const byItem = new Map(items.map(i => [i.item.toLowerCase(), i]))

    const sent: Record<string, number> = {}
    if (Array.isArray(body?.lines)) {
      for (const l of body.lines) {
        const item = S(l?.item)
        if (item) sent[item] = Math.max(0, Math.round(Number(l?.qty) || 0))
      }
    }
    const qtyOf = (name: string) =>
      Object.prototype.hasOwnProperty.call(sent, name) ? sent[name]
      : Object.prototype.hasOwnProperty.call(saved, name) ? saved[name]
      : 1

    const rows: (string | number)[][] = [
      ['Line number', 'ASIN or ISBN', 'Quantity', 'Comment', 'Priority'],
    ]
    let line = 0
    for (const name of requested) {
      const cat = byItem.get(name.toLowerCase())
      const asin = cat?.asins?.[0] || ''
      const qty = qtyOf(name)
      // Only mapped items with a quantity: a row without an ASIN is a row
      // Amazon rejects, and one bad line fails the whole upload. The panel
      // keeps the unmapped ones visible on screen so they are not forgotten.
      if (!asin || qty <= 0) continue
      rows.push([++line, asin, qty, name, 'Medium'])
    }

    const salon = S(sub.salonNum) || 'order'
    const name = `amazon-list-${salon}-${submissionId.slice(-6)}.xlsx`
    const buf = sheetToXlsx(rows, 'Amazon list')

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
        // So the client can tell "nothing was mapped" from "the download failed".
        'X-Order-Lines': String(rows.length - 1),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message }, { status: 500 })
  }
}
