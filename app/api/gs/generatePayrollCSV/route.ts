import { NextResponse } from 'next/server'
import {requireCapability} from '@/lib/require-role'
export async function GET() {
  const gate = await requireCapability('run.dataops'); if (!gate.ok) return gate.response
  return NextResponse.json({ success: false, error: 'Coming in Session 4' })
}
