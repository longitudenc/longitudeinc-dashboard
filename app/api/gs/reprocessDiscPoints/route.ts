import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
export async function POST() {
  const gate = await requireAdmin(); if (!gate.ok) return gate.response
  return NextResponse.json({ success: true })
}
