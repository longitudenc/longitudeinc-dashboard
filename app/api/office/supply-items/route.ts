// app/api/office/supply-items/route.ts
//
// SUPPLY-ITEMS-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET   -> the catalogue, plus every option the supply order form offers
//   POST  { items: [...] } -> replace the catalogue
//
// Office and up, matching the rest of /api/office. Mapping a form option to an
// ASIN decides what actually gets bought when somebody ticks a box, so it sits
// with the people who place the orders rather than with everyone who can read
// one.
//
// GET returns formOptions as well as items because the two only mean anything
// together: the catalogue is a set of answers to the questions the form asks,
// and an entry whose name no longer matches an option is dead weight the
// editor needs to be able to show.

import { NextResponse } from 'next/server'
import { requireOffice } from '@/lib/require-role'
import { getFormDefs } from '@/lib/forms'
import { listSupplyItems, saveSupplyItems, type SupplyItem } from '@/lib/supply-order'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown) => String(v ?? '').trim()
const FORM_ID = 'supplyorder'

/** Every option on the supply order form's multiselects, in the form's own order. */
async function formOptions(): Promise<{ group: string; options: string[] }[]> {
  const def = (await getFormDefs()).find(d => d.formId === FORM_ID)
  return (def?.fields || [])
    .filter(f => f.type === 'multiselect' && f.options.length)
    .map(f => ({ group: f.label || f.fieldKey, options: f.options.slice() }))
}

export async function GET() {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response
  try {
    const [items, groups] = await Promise.all([listSupplyItems(true), formOptions()])
    return NextResponse.json({ success: true, items, groups })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response
  try {
    const body = await req.json().catch(() => ({}))
    if (!Array.isArray(body?.items)) {
      return NextResponse.json({ success: false, error: 'items[] is required' }, { status: 400 })
    }

    // A whole-tab replace with an empty array would wipe the catalogue, and no
    // legitimate edit does that from this screen. Refuse rather than obey.
    if (!body.items.length) {
      return NextResponse.json(
        { success: false, error: 'refusing to save an empty catalogue' }, { status: 400 })
    }

    const items: SupplyItem[] = body.items.map((r: any) => ({
      item: S(r?.item),
      category: S(r?.category),
      vendor: S(r?.vendor),
      // Accept either the array the editor sends or a raw comma-separated cell.
      asins: (Array.isArray(r?.asins) ? r.asins : S(r?.asin).split(/[,;]/))
        .map((a: any) => S(a).toUpperCase()).filter(Boolean),
      url: S(r?.url),
      packSize: S(r?.packSize),
      notes: S(r?.notes),
      status: S(r?.status) || 'active',
      // CATALOGUE-MEDIA-v1. body.items is `any`, so nothing here is
      // type-checked against SupplyItem -- a field left out is silently
      // blanked on save, not a compile error. Every column the editor shows
      // must be listed.
      image: S(r?.image),
      imageUrl: '',                       // resolved on read, never stored
    })).filter((i: SupplyItem) => i.item)

    if (!items.length) {
      return NextResponse.json({ success: false, error: 'every row was blank' }, { status: 400 })
    }

    const saved = await saveSupplyItems(items, gate.effectiveEmail || gate.email)
    return NextResponse.json({ success: true, saved, items: await listSupplyItems(true) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message }, { status: 500 })
  }
}
