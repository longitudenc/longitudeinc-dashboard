import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'

export async function POST(req: NextRequest) {
  try {
    const { managers } = await req.json()
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
    const sheets = google.sheets({ version: 'v4', auth })
    const values = [['salonNum', 'managerName', 'globalId', 'updatedAt']]
    managers.forEach((m: any) => {
      values.push([m.salonNum || '', m.name || '', m.globalId || '', new Date().toISOString()])
    })
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'ManagerTable!A1',
      valueInputOption: 'RAW',
      requestBody: { values },
    })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
