// app/api/home/save/route.ts
//
// Admin editor for homepage content — announcements, important dates, links.
//
// Body: { kind: 'announcement'|'date'|'link',
//         action: 'add'|'update'|'remove',
//         item: { ... },        // add/update
//         id: '...' }           // remove
//
// Owner/admin only. Rewrites the target tab in full (these are small tabs, a
// few dozen rows), which keeps column alignment guaranteed.

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { readSheet, rowsToObjects, writeSheet } from '@/lib/sheets'
import {
  TAB_ANNOUNCEMENTS, TAB_DATES, TAB_LINKS,
  ANNOUNCEMENT_COLUMNS, DATE_COLUMNS, LINK_COLUMNS,
  normalizeDate, newId, isSafeUrl,
} from '@/lib/home'

const KINDS = {
  announcement: { tab: TAB_ANNOUNCEMENTS, columns: ANNOUNCEMENT_COLUMNS, prefix: 'ann' },
  date:         { tab: TAB_DATES,         columns: DATE_COLUMNS,         prefix: 'dt'  },
  link:         { tab: TAB_LINKS,         columns: LINK_COLUMNS,         prefix: 'lnk' },
} as const

type Kind = keyof typeof KINDS

const str = (v: unknown, max = 5000) => String(v ?? '').trim().slice(0, max)

// Normalize an incoming item to the tab's column set. Date-ish cells are run
// through normalizeDate so a picker value and a typed value store identically.
function shapeItem(kind: Kind, raw: any, existing: Record<string, any> | null, email: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of KINDS[kind].columns) out[c] = existing ? String(existing[c] ?? '') : ''

  const set = (k: string, v: string) => { if (raw[k] !== undefined) out[k] = v }

  if (kind === 'announcement') {
    set('title', str(raw.title, 300))
    set('body', str(raw.body, 4000))
    set('imageUrl', str(raw.imageUrl, 1000))
    set('pinned', raw.pinned ? 'yes' : '')
    set('startDate', normalizeDate(raw.startDate))
    set('endDate', normalizeDate(raw.endDate))
    set('audience', str(raw.audience, 300))
    if (!existing) {
      out.createdBy = email
      out.createdAt = new Date().toISOString()
    }
  } else if (kind === 'date') {
    set('title', str(raw.title, 300))
    set('date', normalizeDate(raw.date))
    // Free text, deliberately NOT normalised: "morning" and "after close" are
    // real answers and a time parser would throw them away.
    set('time', str(raw.time, 60))
    set('endDate', normalizeDate(raw.endDate))
    set('category', str(raw.category, 100))
    set('note', str(raw.note, 2000))
    // Same http(s)-or-site-relative rule the quick links use, so a sign-up
    // link cannot smuggle in a javascript: URL.
    set('signupUrl', isSafeUrl(raw.signupUrl) ? str(raw.signupUrl, 1000) : '')
    set('audience', str(raw.audience, 300))
  } else {
    set('label', str(raw.label, 200))
    set('url', str(raw.url, 1000))
    set('icon', str(raw.icon, 16))
    set('category', str(raw.category, 100))
    set('sortOrder', str(raw.sortOrder, 10))
    set('audience', str(raw.audience, 300))
  }
  return out
}


export async function POST(req: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const kind = String(body?.kind || '').trim() as Kind
    const action = String(body?.action || '').trim()

    if (!KINDS[kind]) {
      return NextResponse.json({ success: false, error: 'kind must be announcement, date, or link' }, { status: 400 })
    }
    if (!['add', 'update', 'remove'].includes(action)) {
      return NextResponse.json({ success: false, error: 'action must be add, update, or remove' }, { status: 400 })
    }

    const { tab, columns, prefix } = KINDS[kind]
    let rows = rowsToObjects(await readSheet(tab))

    if (action === 'remove') {
      const id = str(body?.id, 100)
      if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 })
      const before = rows.length
      rows = rows.filter(r => String(r.id || '').trim() !== id)
      if (rows.length === before) {
        return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
      }
    } else {
      const raw = body?.item
      if (!raw || typeof raw !== 'object') {
        return NextResponse.json({ success: false, error: 'item is required' }, { status: 400 })
      }

      // Reject unsafe URLs up front so a bad value never reaches the sheet.
      if (kind === 'link' && raw.url !== undefined && !isSafeUrl(str(raw.url, 1000))) {
        return NextResponse.json({ success: false, error: 'url must start with http://, https://, or /' }, { status: 400 })
      }
      if (kind === 'announcement' && str(raw.imageUrl, 1000) && !isSafeUrl(str(raw.imageUrl, 1000))) {
        return NextResponse.json({ success: false, error: 'image URL must start with http://, https://, or /' }, { status: 400 })
      }

      if (action === 'add') {
        const item = shapeItem(kind, raw, null, gate.email)
        item.id = newId(prefix)
        const titleKey = kind === 'link' ? 'label' : 'title'
        if (!item[titleKey]) {
          return NextResponse.json({ success: false, error: `${titleKey} is required` }, { status: 400 })
        }
        if (kind === 'date' && !item.date) {
          return NextResponse.json({ success: false, error: 'date is required' }, { status: 400 })
        }
        rows.push(item)
      } else {
        const id = str(raw.id || body?.id, 100)
        if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 })
        const idx = rows.findIndex(r => String(r.id || '').trim() === id)
        if (idx === -1) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
        rows[idx] = { ...shapeItem(kind, raw, rows[idx], gate.email), id }
      }
    }

    await writeSheet(tab, [
      [...columns],
      ...rows.map(r => columns.map(c => String((r as any)[c] ?? ''))),
    ])

    return NextResponse.json({ success: true, kind, action, count: rows.length })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
