// app/api/gs/saveDiscPoints/route.ts
//
// Add or remove disciplinary-point EVENTS. Each event is one dated record;
// the client computes rolling-12-month active totals from these.
//
// Body (one of):
//   { action: 'add',    event: { globalId, employeeName, points, date, reason } }
//   { action: 'remove', eventId }
//   { action: 'replace', events: [ ...full list... ] }   // bulk rewrite
//
// Writes the DiscPoints tab (creates it on first save). Schema:
//   eventId | globalId | employeeName | points | date | reason | addedAt
//
// NOTE: like the other gs/save* routes this currently has no endpoint auth —
// to be locked behind the role check in the Session 6 auth pass.

import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { requireAdmin } from '@/lib/require-role'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'
const TAB = 'DiscPoints'
const HEADER = ['eventId', 'globalId', 'employeeName', 'points', 'date', 'reason', 'addedAt']

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
  const exists = (meta.data.sheets || []).some((s: any) => s.properties?.title === TAB)
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    })
  }
}

async function readEvents(sheets: any): Promise<Record<string, string>[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:G`,
  })
  const rows: string[][] = res.data.values || []
  if (rows.length < 2) return []
  const header = rows[0].map((h) => String(h).trim())
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {}
    header.forEach((h, i) => (o[h] = r[i] != null ? String(r[i]) : ''))
    return o
  })
}

function writeAll(sheets: any, events: Record<string, any>[]) {
  const values = [HEADER, ...events.map((e) => HEADER.map((h) => String(e[h] ?? '')))]
  return sheets.spreadsheets.values
    .clear({ spreadsheetId: SHEET_ID, range: `${TAB}!A:G` })
    .then(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${TAB}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values },
      })
    )
}

export async function POST(req: Request) {
  // Only owner/admin may edit disciplinary points.
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const body = await req.json()
    const sheets = client()
    await ensureTab(sheets)

    let events = await readEvents(sheets)

    if (body.action === 'add') {
      const e = body.event || {}
      if (!e.globalId || !e.points || !e.date) {
        return NextResponse.json({ success: false, error: 'globalId, points, and date are required' }, { status: 400 })
      }
      events.push({
        eventId: 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        globalId: String(e.globalId),
        employeeName: String(e.employeeName || ''),
        points: String(Number(e.points) || 0),
        date: String(e.date),
        reason: String(e.reason || ''),
        addedAt: new Date().toISOString(),
      })
    } else if (body.action === 'remove') {
      const id = String(body.eventId || '')
      events = events.filter((r) => String(r.eventId) !== id)
    } else if (body.action === 'replace') {
      events = (body.events || []).map((e: any) => ({
        eventId: String(e.eventId || 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        globalId: String(e.globalId || ''),
        employeeName: String(e.employeeName || ''),
        points: String(Number(e.points) || 0),
        date: String(e.date || ''),
        reason: String(e.reason || ''),
        addedAt: String(e.addedAt || new Date().toISOString()),
      }))
    } else {
      return NextResponse.json({ success: false, error: 'unknown action' }, { status: 400 })
    }

    await writeAll(sheets, events)
    return NextResponse.json({ success: true, count: events.length })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
