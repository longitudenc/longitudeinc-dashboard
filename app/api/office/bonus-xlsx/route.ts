// app/api/office/bonus-xlsx/route.ts
//
// BONUS-XLSX-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   POST { rows: string[][], textColumns?: number[], sheetName?, fileName? }
//     -> the same table as an .xlsx
//
// WHY THIS EXISTS. The ADP bonus file carries two identifiers that are digits
// but are not numbers: the File # and the Temp Dept, where an area manager is
// 000004 and Kayla is 000001. A CSV cannot defend them. Quoting the field does
// not help — Excel reads "000004" as the number four and writes back a 4 — so
// anyone who opens the file to check it before uploading silently destroys the
// codes, and ADP rejects the import.
//
// An xlsx can say what a cell IS. Those columns are written as text, so they
// arrive at ADP the way they left.
//
// The browser already has these rows on screen; this route only changes their
// container. Gated on view.company, the same capability as the bonus screen
// the numbers come from.

import { NextResponse } from 'next/server'
import { requireCapability } from '@/lib/require-role'
import { sheetToXlsx } from '@/lib/xlsx-min'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ROWS = 5000
const MAX_COLS = 60

export async function POST(req: Request) {
  const gate = await requireCapability('view.company')
  if (!gate.ok) return gate.response

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 })
  }

  const raw = Array.isArray(body?.rows) ? body.rows : []
  if (!raw.length) return NextResponse.json({ success: false, error: 'no rows' }, { status: 400 })
  if (raw.length > MAX_ROWS) {
    return NextResponse.json({ success: false, error: 'too many rows' }, { status: 400 })
  }

  const rows: (string | number)[][] = raw.map((r: any) =>
    (Array.isArray(r) ? r : []).slice(0, MAX_COLS).map((c: any) =>
      typeof c === 'number' ? c : String(c ?? '').slice(0, 500)))

  const textColumns = (Array.isArray(body?.textColumns) ? body.textColumns : [])
    .map((n: any) => Number(n))
    .filter((n: number) => Number.isInteger(n) && n >= 0 && n < MAX_COLS)

  try {
    const buf = sheetToXlsx(rows, String(body?.sheetName || 'Sheet1').slice(0, 31), { textColumns })
    const name = String(body?.fileName || 'export.xlsx').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
      || 'export.xlsx'
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
