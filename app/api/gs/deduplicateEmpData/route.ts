import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
import { readSheet, writeSheet } from '@/lib/sheets'

// Remove duplicate rows from SD_EMP_DAILY (and SD_EMP_WEEKLY), keeping the LAST
// occurrence of each key. SD_EMP_DAILY key = date|storeId|payId; SD_EMP_WEEKLY
// key = weekEnd|storeId|payId. Re-pulling does NOT clean existing dupes (the
// upsert only updates one of the two), so this rewrites the tab de-duped.
async function dedupeTab(tab: string, keyCols: string[]): Promise<{ tab: string; before: number; after: number; removed: number }> {
  const raw = await readSheet(tab)
  if (raw.length <= 1) return { tab, before: Math.max(0, raw.length - 1), after: Math.max(0, raw.length - 1), removed: 0 }
  const header: string[] = raw[0].map((h: any) => String(h).trim())
  const idxs = keyCols.map(k => header.indexOf(k))
  if (idxs.some(i => i === -1)) return { tab, before: raw.length - 1, after: raw.length - 1, removed: 0 }
  const body = raw.slice(1)
  const byKey = new Map<string, any[]>()
  for (const row of body) {
    const key = idxs.map(i => String(row[i] ?? '')).join('||')
    byKey.set(key, row) // last occurrence wins
  }
  const deduped = Array.from(byKey.values())
  const before = body.length, after = deduped.length
  if (after < before) await writeSheet(tab, [header, ...deduped])
  return { tab, before, after, removed: before - after }
}

export async function GET() {
  const gate = await requireAdmin(); if (!gate.ok) return gate.response
  try {
    const daily = await dedupeTab('SD_EMP_DAILY', ['date', 'storeId', 'payId'])
    const weekly = await dedupeTab('SD_EMP_WEEKLY', ['weekEnd', 'storeId', 'payId'])
    return NextResponse.json({ success: true, removed: daily.removed + weekly.removed, detail: [daily, weekly] })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
