// app/api/health/daily-check/route.ts
//
// DID THE DATA ACTUALLY LAND? Verifies the OUTCOME of the nightly scrape rather
// than trusting what the scrape reported about itself.
//
// This exists because of a real failure: SD_HALFHOUR went 70 days without a new
// row while its job kept answering {"ok":true}, because "every store returned an
// empty response" was treated as success. Every run looked green. A per-job
// status check cannot catch that; only looking at the data can.
//
//   /api/health/daily-check?secret=…                 checks yesterday (ET)
//   /api/health/daily-check?secret=…&date=YYYY-MM-DD checks that day
//
// Cheap by construction: reads ONLY column A (the date column) of each tab, not
// the whole tab, so it stays fast as history grows.
//
// Returns ok:false when a feed is missing the day, which turns the nightly
// workflow red. Also emails ALERT_EMAIL so it surfaces even if nobody is
// watching the Actions tab.

import { NextResponse } from 'next/server'
import { readSheet } from '@/lib/sheets'
import { sendAlert } from '@/lib/alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Feeds that must gain rows for every business day, with how many rows is
// plausible. `min` guards against a job that writes a token row or two and
// calls it a success.
const DAILY_FEEDS: { tab: string; label: string; min: number }[] = [
  { tab: 'SD_DAILY',     label: 'Salon daily',      min: 10 },
  { tab: 'SD_EMP_DAILY', label: 'Employee daily',   min: 30 },
  { tab: 'SD_DEMAND',    label: 'Demand (half-hour bins)', min: 100 },
  { tab: 'SD_SHIFTS',    label: 'Shifts',           min: 20 },
  { tab: 'SD_CHKINOUT',  label: 'Clock in/out',     min: 40 },
]

/** Yesterday in Eastern time — the day the nightly scrape targets. */
function yesterdayET(): string {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  et.setDate(et.getDate() - 1)
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  if (request.headers.get('authorization') === `Bearer ${expected}`) return true
  return new URL(request.url).searchParams.get('secret') === expected
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const url = new URL(request.url)
  const qDate = url.searchParams.get('date')
  const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : yesterdayET()

  const feeds = await Promise.all(DAILY_FEEDS.map(async f => {
    try {
      // Column A only. Every one of these tabs stores the date in column A;
      // if that ever changes this reports 0 rows and fails loudly, which is the
      // right way round for a health check.
      const col = (await readSheet(f.tab, 'A2:A', { fresh: true })) as any[][]
      const rows = col.reduce((n, r) => n + (String((r && r[0]) || '').slice(0, 10) === date ? 1 : 0), 0)
      return { ...f, rows, ok: rows >= f.min }
    } catch (e: any) {
      return { ...f, rows: 0, ok: false, error: String(e?.message || e).slice(0, 120) }
    }
  }))

  const missing = feeds.filter(f => !f.ok)
  const ok = missing.length === 0

  if (!ok) {
    const list = missing
      .map(f => `<li><b>${f.label}</b> (${f.tab}) — ${f.rows} rows, expected at least ${f.min}</li>`)
      .join('')
    await sendAlert(
      `[Longitude] Nightly data MISSING for ${date}`,
      `<p>${missing.length} feed(s) have no usable data for <b>${date}</b>:</p><ul>${list}</ul>` +
      `<p>Re-run a single day with:<br><code>/api/scrape/&lt;name&gt;?secret=…&amp;start=${date}&amp;end=${date}</code></p>`
    )
  }

  return NextResponse.json({
    ok,
    date,
    checked: feeds.length,
    missing: missing.map(f => f.tab),
    feeds: feeds.map(f => ({ tab: f.tab, label: f.label, rows: f.rows, ok: f.ok })),
    ...(ok ? {} : { error: `No data for ${date} in: ${missing.map(f => f.tab).join(', ')}` }),
  })
}
