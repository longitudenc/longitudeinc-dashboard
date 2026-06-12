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
import { Resend } from 'resend'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'
const TAB = 'Feedback'
const HEADER = ['id', 'submittedAt', 'email', 'role', 'page', 'category', 'message', 'status']

// Email notification settings. FROM must be the Resend-verified sender (same as
// the login emails). NOTIFY_TO is where feedback alerts go — defaults to the
// owner address, overridable via the FEEDBACK_NOTIFY_EMAIL env var.
const FROM = 'Longitude Dashboard <noreply@mail.longitudenc.com>'
const NOTIFY_TO = process.env.FEEDBACK_NOTIFY_EMAIL || 'tbullard1013@gmail.com'

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

    // Email a notification (best-effort — never fail the submission if mail
    // hiccups; the row is already safely in the sheet).
    if (process.env.RESEND_API_KEY) {
      try {
        const catLabel: Record<string, string> = { idea: '💡 Idea', bug: '🐞 Bug', question: '❓ Question', other: '💬 Other' }
        const esc = (t: string) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: FROM,
          to: NOTIFY_TO,
          replyTo: gate.email, // reply goes straight to the submitter
          subject: `Dashboard feedback (${catLabel[category] || category}) from ${gate.email}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;color:#222;">
              <h2 style="color:#03654e;margin-bottom:2px;">New Dashboard Feedback</h2>
              <p style="color:#777;font-size:13px;margin-top:0;">A tester submitted feedback from the dashboard.</p>
              <table style="border-collapse:collapse;font-size:14px;margin:12px 0;">
                <tr><td style="padding:3px 10px 3px 0;color:#888;">Type</td><td style="padding:3px 0;font-weight:600;">${catLabel[category] || esc(category)}</td></tr>
                <tr><td style="padding:3px 10px 3px 0;color:#888;">From</td><td style="padding:3px 0;">${esc(gate.email)} <span style="color:#999;">(${esc(gate.access.role)})</span></td></tr>
                <tr><td style="padding:3px 10px 3px 0;color:#888;">Page</td><td style="padding:3px 0;">${esc(page) || '—'}</td></tr>
              </table>
              <div style="background:#eef6f2;border-radius:10px;padding:14px 16px;font-size:15px;line-height:1.5;white-space:pre-wrap;">${esc(safeMessage)}</div>
              <p style="color:#999;font-size:12px;margin-top:16px;">Reply to this email to respond directly to ${esc(gate.email)}. All feedback is also logged in the Feedback tab of your dashboard sheet.</p>
            </div>
          `,
        })
      } catch (mailErr) {
        console.error('feedback email notify failed (row still saved):', mailErr)
      }
    }

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
