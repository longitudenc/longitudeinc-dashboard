// app/api/auth/logout/route.ts
//
// Clears the session cookie (signs the person out).

import { NextResponse } from 'next/server'
import { clearSession } from '@/lib/session'

export async function POST() {
  await clearSession()
  return NextResponse.json({ ok: true })
}
