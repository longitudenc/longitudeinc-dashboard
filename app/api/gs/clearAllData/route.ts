import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/require-role'
export async function POST() {
  const gate = await requireOwner(); if (!gate.ok) return gate.response
  return NextResponse.json({ success: true, message: 'Clear function - use Google Sheets directly for now' })
}
