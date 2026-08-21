// app/api/forms/defs/route.ts
//
// Returns the form definitions the signed-in person is allowed to open, with
// their fields attached. Definitions live in the FormDefs / FormFields tabs —
// see lib/forms.ts. Served from a dedicated endpoint rather than bundled into
// getAllData, per the project rule about keeping that payload lean.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import { getFormDefsForRole } from '@/lib/forms'

export async function GET() {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response

  try {
    const forms = await getFormDefsForRole(gate.access.role)
    return NextResponse.json({ success: true, forms, role: gate.access.role })
  } catch (e: any) {
    // A missing tab is normal before the first seed — never hard-fail the tab.
    return NextResponse.json({ success: true, forms: [], role: gate.access.role, warning: e.message })
  }
}
