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
import { requireAdmin } from '@/lib/require-role'

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

/**
 * CLOSED-DAY-v1. Was the whole company shut that day?
 *
 * Labor Day 2026 turned the nightly run red: nobody worked, so employee-daily,
 * demand, shifts and clock-in all had zero rows, and a check that asserts
 * "yesterday has data" cannot tell that from a scrape that died quietly. That
 * is 14 red runs on this data set -- New Year's, July 4th, Thanksgiving,
 * Christmas, Easter, Mother's Day, two Labor Days and what look like three
 * snow days -- each one an email that trains you to ignore the next one.
 *
 * The tell is in the data rather than in a holiday list nobody would maintain:
 * SD_DAILY still gets its row per salon on a closed day, reporting zero. So
 * "every salon reported, and every one of them reported nothing" means closed.
 *
 * BOTH customers and floor hours must be zero. Staff on the floor with no
 * customers is a different thing entirely and should still fail loudly.
 *
 * SD_DAILY itself is never excused. If that is missing the scrape really did
 * fail, and this returns to being the check it was.
 */
async function closedDay(date: string): Promise<{ closed: boolean; salons: number; customers: number; floorHours: number }> {
  const raw = ((await readSheet('SD_DAILY', undefined, { fresh: true })) || []) as any[][]
  const header = (raw[0] || []).map((h: any) => String(h ?? '').trim())
  const iDate = header.indexOf('date')
  const iCust = header.indexOf('customerCount')
  const iHrs = header.indexOf('floorHours')
  if (iDate < 0 || iCust < 0 || iHrs < 0) return { closed: false, salons: 0, customers: 0, floorHours: 0 }

  let salons = 0, customers = 0, floorHours = 0
  for (const r of raw.slice(1)) {
    if (String(r?.[iDate] ?? '').slice(0, 10) !== date) continue
    salons++
    customers += Number(r[iCust]) || 0
    floorHours += Number(r[iHrs]) || 0
  }
  // The salon-daily minimum is the same one the feed list uses: a closed day
  // still has to prove every salon reported before its silence is excused.
  const min = DAILY_FEEDS.find(f => f.tab === 'SD_DAILY')?.min ?? 10
  return { closed: salons >= min && customers === 0 && floorHours === 0, salons, customers, floorHours }
}

/** Yesterday in Eastern time — the day the nightly scrape targets. */
function yesterdayET(): string {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  et.setDate(et.getDate() - 1)
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`
}

// Two callers, two rules. The nightly workflow authenticates with CRON_SECRET
// and MAY email an alert. The admin panel authenticates with an owner/admin
// session and MAY NOT -- otherwise simply opening Data Health would fire an
// alert email every time a feed happened to be behind.
type Auth = { ok: false } | { ok: true; mayAlert: boolean }

async function authorize(request: Request): Promise<Auth> {
  const expected = process.env.CRON_SECRET
  if (expected) {
    if (request.headers.get('authorization') === `Bearer ${expected}`) return { ok: true, mayAlert: true }
    if (new URL(request.url).searchParams.get('secret') === expected) return { ok: true, mayAlert: true }
  }
  const gate = await requireAdmin()
  if (gate.ok) return { ok: true, mayAlert: false }
  return { ok: false }
}

export async function GET(request: Request) {
  const auth = await authorize(request)
  if (!auth.ok) {
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

  const shut = await closedDay(date)
  // On a closed day only SD_DAILY has to be there. The rest are empty because
  // there was nothing to record, which is the correct state, not a fault.
  const missing = feeds.filter(f => !f.ok && !(shut.closed && f.tab !== 'SD_DAILY'))
  const ok = missing.length === 0
  // Surfaced in the response so a broken alerting path is visible rather than
  // silent. An alert nobody receives is indistinguishable from no problem.
  let alert: any = { sent: false, reason: 'not needed, nothing missing' }

  if (!ok && auth.mayAlert) {
    const list = missing
      .map(f => `<li><b>${f.label}</b> (${f.tab}) — ${f.rows} rows, expected at least ${f.min}</li>`)
      .join('')
    alert = await sendAlert(
      `[Longitude] Nightly data MISSING for ${date}`,
      `<p>${missing.length} feed(s) have no usable data for <b>${date}</b>:</p><ul>${list}</ul>` +
      `<p>Re-run a single day with:<br><code>/api/scrape/&lt;name&gt;?secret=…&amp;start=${date}&amp;end=${date}</code></p>`
    )
  } else if (!ok) {
    alert = { sent: false, reason: 'read-only check from the admin panel; the nightly run is what alerts' }
  }

  return NextResponse.json({
    ok,
    date,
    checked: feeds.length,
    alert,
    missing: missing.map(f => f.tab),
    // Reported whether or not it changed the outcome, so a green run on a
    // closed day says WHY it is green rather than just being green.
    closed: shut.closed,
    closedDetail: shut.closed
      ? `all ${shut.salons} salons reported ${date} with no customers and no floor hours`
      : undefined,
    feeds: feeds.map(f => ({
      tab: f.tab, label: f.label, rows: f.rows,
      ok: f.ok || (shut.closed && f.tab !== 'SD_DAILY'),
      empty: !f.ok && shut.closed && f.tab !== 'SD_DAILY' ? 'closed day' : undefined,
    })),
    ...(ok ? {} : { error: `No data for ${date} in: ${missing.map(f => f.tab).join(', ')}` }),
  })
}
