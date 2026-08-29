// app/api/office/payroll/file/route.ts
//
// Stream back a payroll file that was previously sent to ADP.
//
// The archive is the evidence when ADP and SD3 disagree weeks later, so it has
// to be readable — but it is also every employee's name, wage and Payroll ID,
// so it lives in the PRIVATE blob store and comes back only through here.
//
// Two checks, both required:
//   • the caller holds an office/admin/owner role
//   • the pathname is one the ADP_HISTORY log actually references, so a valid
//     session cannot read arbitrary blobs by guessing pathnames
//
//   GET ?p=<blob pathname>

import { NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { requireOffice } from '@/lib/require-role'
import { readSheet, rowsToObjects } from '@/lib/sheets'
import { ADP_HISTORY_TAB } from '@/lib/adp-history'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const gate = await requireOffice()
  if (!gate.ok) return gate.response

  const pathname = (new URL(request.url).searchParams.get('p') || '').trim()
  if (!pathname) {
    return NextResponse.json({ success: false, error: 'missing p' }, { status: 400 })
  }

  try {
    let rows: Record<string, any>[] = []
    try {
      rows = rowsToObjects(await readSheet(ADP_HISTORY_TAB))
    } catch {
      rows = []
    }
    const hit = rows.find(r => String(r.filePath || '').trim() === pathname)
    // 404 rather than 403: a pathname that isn't in the log is not ours to
    // confirm the existence of.
    if (!hit) return new NextResponse('Not found', { status: 404 })

    const result = await get(pathname, { access: 'private' })
    if (!result) return new NextResponse('Not found', { status: 404 })

    const fileName = String(hit.fileName || 'payroll.csv')
    console.log(`[office/payroll/file] ${gate.email} re-downloaded ${fileName} (${pathname})`)

    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[office/payroll/file]', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
