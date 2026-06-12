// app/api/gs/saveFeedback/route.ts
//
// Collect beta feedback / suggestions from any signed-in user. Appends one row
// per submission to the Feedback tab (created on first save). Schema:
//   id | submittedAt | email | role | page | category | message | status
//
// Body: { message, category?, page? }
//   - message  (required) the free-text feedback
//   - category (optional) 'bug' | 'idea' | 'question' | 'other'
//   - page     (optional) where they were when submitting (e.g. 'AM Bonus')
//
// Gated to any signed-in user via requireSignedIn() — testers submit feedback,
// we capture who/where automatically. 'status' starts blank for your triage.

import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { requireSignedIn } from '@/lib/require-role'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'
const TAB = 'Feedback'
const HEADER = ['id', 'submittedAt', 'email', 'role', 'page', 'category', 'message', 'status']

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

async function ensureTabWithHeader(sheets: any) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  const exists = (meta.data.sheets || []).some((s: any) => s.properties?.title === TAB)
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    })
  }
  // Make sure row 1 has the header (only write it if the sheet is empty).
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:H1` })
  const firstRow = (res.data.values && res.data.values[0]) || []
  if (firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    })
  }
}

export async function POST(req: Request) {
  // Any signed-in user may submit feedback.
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const body = await req.json()
    const message = String(body.message || '').trim()
    if (!message) {
      return NextResponse.json({ success: false, error: 'message is required' }, { status: 400 })
    }
    // Light guard against runaway payloads.
    const safeMessage = message.slice(0, 4000)
    const category = String(body.category || 'other').slice(0, 40)
    const page = String(body.page || '').slice(0, 120)

    const sheets = client()
    await ensureTabWithHeader(sheets)

    const row = [
      'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      new Date().toISOString(),
      gate.email,
      gate.access.role,
      page,
      category,
      safeMessage,
      '', // status — for your triage (e.g. new / reviewed / done)
    ]

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: TAB,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    })

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
