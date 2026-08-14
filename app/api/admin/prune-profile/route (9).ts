// app/api/admin/prune-profile/route.ts
//
// One-shot cleanup for the EmployeeProfile tab. Removes stale "ghost" rows left
// over from before the employeepk column existed — rows that are inactive
// (termed) AND have a blank employeepk — and drops any stray empty trailing
// column. Active employees are NEVER touched: they all carry an employeepk now,
// and the filter requires `inactive` anyway.
//
// SAFE BY DEFAULT — dry run unless you pass &apply=true. The dry run reports
// exactly what it would remove and changes nothing.
//
//   /api/admin/prune-profile?secret=...              -> preview (no changes)
//   /api/admin/prune-profile?secret=...&apply=true   -> execute the prune
//
// Even in the worst case the nightly profile scrape re-adds every ACTIVE
// employee, so this can only ever remove termed ghosts.

import { NextResponse } from 'next/server'
import { readSheet, writeSheet } from '@/lib/sheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TAB = 'EmployeeProfile'
// Refuse to write if we'd keep fewer than this — guards against a logic bug
// wiping the tab. Post-prune we expect ~167 rows, so 100 is a safe floor.
const MIN_KEEP = 100

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const url = new URL(request.url)
  return url.searchParams.get('secret') === expected
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const url = new URL(request.url)
  const apply = url.searchParams.get('apply') === 'true'

  try {
    const raw = (await readSheet(TAB)) as any[][]
    if (!raw || raw.length === 0) {
      return NextResponse.json({ ok: false, error: 'EmployeeProfile is empty' }, { status: 500 })
    }

    const header: string[] = (raw[0] || []).map((h) => String(h ?? ''))
    // Keep only columns whose header has a name — this drops the stray empty column.
    const keepCols: number[] = header.map((h, i) => (h.trim() === '' ? -1 : i)).filter((i) => i >= 0)
    const emptyColumnsDropped = header.length - keepCols.length

    const colOf = (name: string) => header.findIndex((h) => h.trim() === name)
    const iInactive = colOf('inactive')
    const iPk = colOf('employeepk')
    const iName = colOf('name')
    if (iInactive < 0 || iPk < 0) {
      return NextResponse.json(
        { ok: false, error: "missing 'inactive' or 'employeepk' column" },
        { status: 500 },
      )
    }

    const cell = (row: any[], i: number) => String(row[i] ?? '').trim()
    const dataRows = raw.slice(1)

    // A ghost = termed AND never got an employeepk (pre-column stale row).
    const isGhost = (row: any[]) =>
      cell(row, iInactive).toLowerCase() === 'true' && cell(row, iPk) === ''

    const pruned = dataRows.filter(isGhost)
    const kept = dataRows.filter((r) => !isGhost(r))
    const sample = pruned
      .slice(0, 15)
      .map((r) => (iName >= 0 ? cell(r, iName) : '') || '(blank name)')

    if (!apply) {
      return NextResponse.json({
        ok: true,
        mode: 'dry-run',
        wouldPrune: pruned.length,
        wouldKeep: kept.length,
        emptyColumnsDropped,
        sample,
        hint: 'add &apply=true to execute',
      })
    }

    if (kept.length < MIN_KEEP) {
      return NextResponse.json(
        {
          ok: false,
          error: `refusing to write: would keep only ${kept.length} rows (< ${MIN_KEEP}). Aborting to avoid data loss.`,
        },
        { status: 400 },
      )
    }

    // Rebuild: named header + kept rows, projected onto the non-empty columns.
    const newHeader = keepCols.map((i) => header[i])
    const newRows = kept.map((r) => keepCols.map((i) => r[i] ?? ''))
    await writeSheet(TAB, [newHeader, ...newRows])

    return NextResponse.json({
      ok: true,
      mode: 'applied',
      pruned: pruned.length,
      kept: kept.length,
      emptyColumnsDropped,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
