import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
export async function GET() {
  const gate = await requireAdmin(); if (!gate.ok) return gate.response
  return NextResponse.json({ success: true, removed: 0 })
}
