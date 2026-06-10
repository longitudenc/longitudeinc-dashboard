// app/api/gs/saveAMAssignments/route.ts
//
// Persists the effective-dated salon→AM assignment history AND keeps the
// SalonRoster `am` column in sync — one POST updates both, so the two sources
// can never drift apart.
//
// Body: {
//   assignments: [{salonNum, amKey, startPeriod, endPeriod, notes}, ...],  // FULL list (tab is rewritten)
//   rosterUpdates: [{salonNum, am}, ...]                                   // optional current-state changes
// }
//
// Notes:
// - Creates the AMAssignments tab on first save (no manual tab setup needed).
// - Clears the tab range before writing, so removed rows don't leave stale tails.

import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'
const TAB = 'AMAssignments'
const ROSTER_TAB = 'SalonRoster'

function client() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

async function ensureTab(sheets: any) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  const exists = (meta.data.sheets || []).some(
    (s: any) => s.properties?.title === TAB
  )
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { assignments, rosterUpdates } = await req.json()
    const sheets = client()

    // ── 1) Rewrite the AMAssignments tab (full replace) ──────────
    await ensureTab(sheets)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!A:E`,
    })
    const values: string[][] = [
      ['salonNum', 'amKey', 'startPeriod', 'endPeriod', 'notes'],
    ]
    ;(assignments || []).forEach((a: any) => {
      values.push([
        String(a.salonNum || ''),
        String(a.amKey || ''),
        String(a.startPeriod || ''),
        String(a.endPeriod || ''),
        String(a.notes || ''),
      ])
    })
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    })

    // ── 2) Sync SalonRoster.am for affected salons ────────────────
    let rosterUpdated = 0
    const updates = (rosterUpdates || []).filter((u: any) => u && u.salonNum)
    if (updates.length) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${ROSTER_TAB}!A1:Z`,
      })
      const rows: string[][] = res.data.values || []
      if (rows.length) {
        const header = rows[0].map((h) => String(h).trim())
        const snCol = header.indexOf('salonNum')
        const amCol = header.indexOf('am')
        if (snCol === -1 || amCol === -1) {
          throw new Error(`SalonRoster missing salonNum/am columns`)
        }
        const amColLetter = String.fromCharCode(65 + amCol) // A..Z (roster is well under 26 cols)
        const data: { range: string; values: string[][] }[] = []
        for (const u of updates) {
          const idx = rows.findIndex(
            (r, i) => i > 0 && String(r[snCol] || '').trim() === String(u.salonNum)
          )
          if (idx === -1) continue
          data.push({
            range: `${ROSTER_TAB}!${amColLetter}${idx + 1}`,
            values: [[String(u.am || '')]],
          })
          rosterUpdated++
        }
        if (data.length) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: { valueInputOption: 'RAW', data },
          })
        }
      }
    }

    return NextResponse.json({
      success: true,
      assignmentRows: (assignments || []).length,
      rosterUpdated,
    })
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500 }
    )
  }
}
