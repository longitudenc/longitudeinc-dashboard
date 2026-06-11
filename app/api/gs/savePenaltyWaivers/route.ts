import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { requireAdmin } from '@/lib/require-role'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'

export async function POST(req: NextRequest) {
  // Only owner/admin may edit penalty waivers.
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  try {
    const { waivers } = await req.json()
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
    const sheets = google.sheets({ version: 'v4', auth })
    const values = [['salonNum', 'period', 'payroll', 'hours', 'notes']]
    Object.entries(waivers || {}).forEach(([key, w]: [string, any]) => {
      values.push([w.salonNum || '', w.period || '', w.payroll ? 'TRUE' : 'FALSE', w.hours ? 'TRUE' : 'FALSE', w.notes || ''])
    })
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'PenaltyWaivers!A1',
      valueInputOption: 'RAW', requestBody: { values },
    })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
