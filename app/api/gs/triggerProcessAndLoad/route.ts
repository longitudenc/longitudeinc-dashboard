import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/require-role'
export async function POST() {
  const gate = await requireAdmin(); if (!gate.ok) return gate.response
  return NextResponse.json({ success: true, processResult: { message: 'File processing will be handled by scrapers in Session 4', remaining: 0 } })
}
