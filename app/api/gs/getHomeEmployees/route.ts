// app/api/gs/getHomeEmployees/route.ts
//
// The employee picker behind Manager Assignments.
//
// Sourced from EmployeeProfile, which the nightly profile scrape keeps current.
// It used to read the HomeData tab — a hand-loaded ADP export whose home salon
// was months stale (wrong for 3 active people, missing 18 more) and whose
// baseWage was 0 on all 130 rows. Nothing is lost by dropping it: the only
// records it held that EmployeeProfile does not are three long-departed people,
// who have no business in a dropdown used to name a CURRENT manager.
//
// ACTIVE only, for the same reason. A departed employee cannot be a salon's
// current manager, and past assignments are stored in AMAssignments, not here.

import { NextResponse } from 'next/server'
import { getEmployeeProfiles } from '@/lib/sheets'
import { AMS } from '@/lib/config'
import { requireSignedIn } from '@/lib/require-role'

const str = (v: unknown) => String(v ?? '').trim()

export async function GET() {
  const gate = await requireSignedIn(); if (!gate.ok) return gate.response
  try {
    const rows = await getEmployeeProfiles()
    const employees = rows
      .filter((r: any) => str(r.inactive).toLowerCase() !== 'true')
      .map((r: any) => ({
        name: str(r.name),
        globalId: str(r.globalId),
        salon: str(r.homeStoreNum),
      }))
      .filter((e: any) => e.name && e.globalId)

    // Area managers are Users-tab logins, not roster employees, so they are not
    // guaranteed a profile row — add any that are missing.
    Object.values(AMS).forEach((am: any) => {
      if (am.globalId && !employees.find((e: any) => e.globalId === am.globalId)) {
        employees.push({ name: am.name + ' (AM)', globalId: am.globalId, salon: 'AM' })
      }
    })
    employees.sort((a: any, b: any) => a.name.localeCompare(b.name))
    return NextResponse.json({ success: true, employees })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message, employees: [] })
  }
}
