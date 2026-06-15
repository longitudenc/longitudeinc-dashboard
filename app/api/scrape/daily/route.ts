// app/api/scrape/daily/route.ts
//
// Daily SD3 scraper — pulls yesterday's daily store summary for every salon.
//
// Schedule: 4 AM ET (set in vercel.json)
// Storage:  SD_DAILY tab in the Sheet, upserted by (date, storeId)
//
// Auth: requires a Bearer token matching env CRON_SECRET, or ?secret=... query param.
//       Vercel Cron sends an Authorization header; manual hits use the query param.

import { NextResponse } from 'next/server'
import {
  authenticate,
  fetchSalons,
  fetchDailyStoreSummary,
  type SD3DailyStoreSummary,
} from '@/lib/sd3'
import { upsertSheet } from '@/lib/sheets'
import { yesterdayET } from '@/lib/fiscal'

// Force Node.js runtime (not Edge) — googleapis needs Node
export const runtime = 'nodejs'
// Keep dynamic so cron always gets fresh data
export const dynamic = 'force-dynamic'
// Vercel function timeout — daily scrape of 19 salons takes ~20s
export const maxDuration = 60

const SD_DAILY_TAB = 'SD_DAILY'

// Columns we persist per daily row. Order matters — this is the sheet header order.
// Storing the most-used dashboard fields, plus everything needed to recompute weekly
// and to power the Daily tab. Full SD3 payload (~100 fields) is NOT all stored —
// only the ones we know we need. Easy to add more later.
const COLUMNS = [
  'date',
  'storeId',
  'customerCount',
  'newCustomerCount',
  'newCustomerVisitCount',
  'newCustomerReturnCount',
  'repeatCustomerVisitCount',
  'repeatCustomerReturnCount',
  'serviceSales',
  'productSales',
  'grossHaircutSales',
  'floorHours',
  'approximatePayrollAmount',
  'trainingPay',
  'haircutCount',
  'haircutOnlyInvoiceCount',
  'haircutOnlyServiceMinutes',
  'waitOver15MinsCount',
  'nonOciWaitOver15MinsCount',
  'nonOciCustomerCount',
  'ociCompletedInvoiceCount',
  'nonCutWithCustWaitingMinutes',
  'totalCustomerWaitMinutes',
  'longestWaitMinutes',
  'voidCount',
  'redoAmount',
  'serviceDiscounts',
  'productDiscounts',
  'scrapedAt',
] as const

function rowFromSummary(s: SD3DailyStoreSummary): Record<string, any> {
  const row: Record<string, any> = {}
  for (const col of COLUMNS) {
    row[col] = s[col] ?? ''
  }
  row.date = s.date
  row.storeId = s.storeId
  row.scrapedAt = new Date().toISOString()
  return row
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false

  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"
  const authHeader = request.headers.get('authorization')
  if (authHeader === `Bearer ${expected}`) return true

  // Manual invocation: ?secret=...
  const url = new URL(request.url)
  if (url.searchParams.get('secret') === expected) return true

  return false
}

export async function GET(request: Request) {
  const startedAt = Date.now()

  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Single day:  ?date=YYYY-MM-DD  (defaults to yesterday ET)
  // Range backfill: ?start=YYYY-MM-DD&end=YYYY-MM-DD  — one SD3 call per salon
  //   covers the whole window (dailystoresummary returns one row per day).
  //   Run on localhost (no 60s cap) for prior-year backfills.
  const url = new URL(request.url)
  const dateParam = url.searchParams.get('date')
  const startParam = url.searchParams.get('start')
  const endParam = url.searchParams.get('end')
  const isRange = !!(startParam && endParam)
  const qStart = isRange ? (startParam as string) : (dateParam || yesterdayET())
  const qEnd = isRange ? (endParam as string) : qStart
  const date = isRange ? `${qStart}..${qEnd}` : qStart

  const results = {
    date,
    salonsProcessed: 0,
    rowsUpserted: 0,
    updated: 0,
    inserted: 0,
    errors: [] as { salonNum: string; storeId: number; error: string }[],
  }

  try {
    // 1. Authenticate against SD3
    const session = await authenticate()

    // 2. Fetch fresh salon list (always — never cache the mapping)
    const salons = await fetchSalons(session)
    console.log(`[scrape/daily] ${date} — pulling ${salons.length} salons`)

    // 3. Fetch daily summary for each salon
    //    Run in parallel for speed, with reasonable concurrency.
    const allRows: Record<string, any>[] = []

    // Promise.all over all 19 — SD3 handled this fine during testing
    const fetches = salons.map(async salon => {
      try {
        const rows = await fetchDailyStoreSummary(session, salon.storeId, qStart, qEnd)
        if (rows.length === 0) {
          // Salon closed that day, or data not yet posted — not an error
          return { salon, rows: [] }
        }
        return { salon, rows }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.errors.push({
          salonNum: salon.salonNum,
          storeId: salon.storeId,
          error: msg,
        })
        console.error(`[scrape/daily] failed for ${salon.salonNum}:`, msg)
        return { salon, rows: [] }
      }
    })

    const fetched = await Promise.all(fetches)

    for (const { salon, rows } of fetched) {
      if (rows.length === 0) continue
      for (const row of rows) {
        allRows.push(rowFromSummary(row))
      }
      results.salonsProcessed++
    }

    // 4. Upsert to the Sheet by (date, storeId), chunked so large backfills
    //    don't push one massive write.
    if (allRows.length > 0) {
      const CHUNK = 2000
      for (let i = 0; i < allRows.length; i += CHUNK) {
        const slice = allRows.slice(i, i + CHUNK)
        const upsertResult = await upsertSheet(
          SD_DAILY_TAB,
          [...COLUMNS],
          ['date', 'storeId'],
          slice
        )
        results.rowsUpserted += slice.length
        results.updated += upsertResult.updated
        results.inserted += upsertResult.inserted
      }
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[scrape/daily] ✓ ${date} — ${results.salonsProcessed} salons, ` +
        `${results.inserted} inserted, ${results.updated} updated, ${results.errors.length} errors, ` +
        `${durationMs}ms`
    )

    return NextResponse.json({
      ok: results.errors.length === 0,
      durationMs,
      ...results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scrape/daily] fatal:', msg)
    return NextResponse.json(
      { ok: false, error: msg, ...results },
      { status: 500 }
    )
  }
}