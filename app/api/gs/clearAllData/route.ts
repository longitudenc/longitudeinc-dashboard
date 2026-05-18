import { NextResponse } from 'next/server'
export async function POST() {
  return NextResponse.json({ success: true, message: 'Clear function - use Google Sheets directly for now' })
}
