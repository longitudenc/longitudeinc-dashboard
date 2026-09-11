// lib/usage.ts
//
// USAGE-v1 -- who opens the dashboard, how often, and which screens they use.
//
// The browser sends one small event per screen opened (and one "open" per
// page load, which is what a visit means here), in batches. They land in
// UsageLog, one row each, stamped on the server with who sent them -- never
// trusted from the client.
//
// Reading raw events for a year would get slow, so finished days are rolled
// up into UsageDaily (date x person x screen -> views) whenever the report is
// opened. Raw rows are kept for RAW_KEEP_DAYS so any day still inside that
// window can be recomputed exactly; the daily table keeps about a year.
//
// What is NOT recorded: anything typed or searched, clicks inside a screen,
// and anything done while an owner is viewing as someone else.

import { readSheet, rowsToObjects, writeSheet, appendSheet, tabExists, createTab, getUsers } from './sheets'
import { loadAccessTables, employeeAccessFor } from './auth-roles'

export const TAB_USAGE_RAW = 'UsageLog'
export const TAB_USAGE_DAILY = 'UsageDaily'
const RAW_COLS = ['at', 'date', 'email', 'role', 'salon', 'screen', 'detail'] as const
const DAILY_COLS = ['date', 'email', 'role', 'salon', 'screen', 'views'] as const
const RAW_KEEP_DAYS = 60
const DAILY_KEEP_DAYS = 400
const TZ = 'America/New_York'

const S = (v: any, n = 200) => String(v ?? '').trim().slice(0, n)
const norm = (v: any) => String(v ?? '').trim().toLowerCase()

/** The business day an instant falls on, as YYYY-MM-DD. */
export function localDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ })
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function readTable(tab: string, cols: readonly string[]): Promise<Record<string, any>[]> {
  let raw: any[][] = []
  try { raw = ((await readSheet(tab, undefined, { fresh: true })) || []) as any[][] } catch { return [] }
  if (!raw.length) return []
  const first = (raw[0] || []).map(h => String(h ?? '').trim())
  if (first[0] === cols[0]) return rowsToObjects(raw)
  return raw.map(r => { const o: Record<string, any> = {}; cols.forEach((c, i) => { o[c] = (r as any[])[i] ?? '' }); return o })
}

// Once per server instance: listing tabs on every event would cost a Sheets
// read per screen anybody opens.
let rawReady = false
async function ensureRawTab(): Promise<void> {
  if (rawReady) return
  if (!(await tabExists(TAB_USAGE_RAW))) {
    await createTab(TAB_USAGE_RAW)
    await appendSheet(TAB_USAGE_RAW, [[...RAW_COLS]])
  }
  rawReady = true
}

export interface UsageEvent { screen?: string; detail?: string; at?: string }
export interface UsageWho { email: string; role: string; salon: string }

/** Append a batch of events for one person. Returns how many were kept. */
export async function logEvents(who: UsageWho, events: UsageEvent[]): Promise<number> {
  const now = Date.now()
  const rows = (events || []).slice(0, 50).map(e => {
    // The client's clock is a hint: anything in the future or more than a day
    // old is replaced with now, so a wrong clock cannot file events elsewhere.
    let t = Date.parse(S(e?.at, 40))
    if (!isFinite(t) || t > now + 60_000 || t < now - 86_400_000) t = now
    const at = new Date(t).toISOString()
    return [at, localDate(at), norm(who.email), S(who.role, 30), S(who.salon, 60), S(e?.screen, 80), S(e?.detail, 80)]
  }).filter(r => r[5])
  if (!rows.length) return 0
  await ensureRawTab()
  await appendSheet(TAB_USAGE_RAW, rows)
  return rows.length
}

type DailyRow = { date: string; email: string; role: string; salon: string; screen: string; views: number }

function aggregate(raw: Record<string, any>[]): DailyRow[] {
  const m = new Map<string, DailyRow>()
  for (const r of raw) {
    const date = S(r.date, 10), email = norm(r.email), screen = S(r.screen, 80)
    if (!date || !email || !screen) continue
    const k = date + '|' + email + '|' + screen
    const cur = m.get(k)
    if (cur) cur.views++
    else m.set(k, { date, email, role: S(r.role, 30), salon: S(r.salon, 60), screen, views: 1 })
  }
  return [...m.values()]
}

/**
 * Fold every finished day still in the raw log into UsageDaily, then trim
 * both tables. Idempotent: a day is recomputed from its raw rows, never added
 * to, so running it twice changes nothing.
 */
export async function rollUp(): Promise<void> {
  const today = localDate(new Date().toISOString())
  const raw = await readTable(TAB_USAGE_RAW, RAW_COLS)
  const closed = raw.filter(r => S(r.date, 10) && S(r.date, 10) < today)
  if (!closed.length) return
  const daily = await readTable(TAB_USAGE_DAILY, DAILY_COLS)
  const have = new Set(daily.map(d => S(d.date, 10)))
  const dates = new Set(closed.map(r => S(r.date, 10)))
  const dailyCut = addDays(today, -DAILY_KEEP_DAYS)
  const needsWrite = [...dates].some(d => !have.has(d)) || daily.some(d => S(d.date, 10) < dailyCut)
  if (needsWrite) {
    const keep = daily.filter(d => !dates.has(S(d.date, 10)) && S(d.date, 10) >= dailyCut)
    const next = [...keep.map(d => ({ ...d, views: Number(d.views) || 0 }) as DailyRow), ...aggregate(closed)]
      .sort((a, b) => a.date.localeCompare(b.date) || a.email.localeCompare(b.email) || a.screen.localeCompare(b.screen))
    await writeSheet(TAB_USAGE_DAILY, [[...DAILY_COLS], ...next.map(d => DAILY_COLS.map(c => String((d as any)[c] ?? '')))])
  }
  // Trimming rewrites the raw tab, so it only happens when there is something
  // old enough to trim, and re-reads immediately before writing: an event
  // arriving in the second between the two can be lost, which for a usage
  // count is an acceptable price for not running a separate store.
  const rawCut = addDays(today, -RAW_KEEP_DAYS)
  if (raw.some(r => S(r.date, 10) && S(r.date, 10) < rawCut)) {
    const fresh = await readTable(TAB_USAGE_RAW, RAW_COLS)
    await writeSheet(TAB_USAGE_RAW, [[...RAW_COLS],
      ...fresh.filter(r => S(r.date, 10) >= rawCut).map(r => RAW_COLS.map(c => String(r[c] ?? '')))])
  }
}

/** Daily rows for the last `days` days, today's taken live from the raw log. */
export async function usageRows(days: number): Promise<{ since: string; today: string; rows: DailyRow[] }> {
  await rollUp()
  const today = localDate(new Date().toISOString())
  const since = addDays(today, -(Math.max(1, days) - 1))
  const [daily, raw] = await Promise.all([readTable(TAB_USAGE_DAILY, DAILY_COLS), readTable(TAB_USAGE_RAW, RAW_COLS)])
  const past = daily.filter(d => S(d.date, 10) >= since && S(d.date, 10) < today)
    .map(d => ({ date: S(d.date, 10), email: norm(d.email), role: S(d.role, 30), salon: S(d.salon, 60), screen: S(d.screen, 80), views: Number(d.views) || 0 }))
  return { since, today, rows: [...past, ...aggregate(raw.filter(r => S(r.date, 10) === today))] }
}

export interface ExpectedPerson { email: string; name: string; role: string; salon: string }

/**
 * Everyone who can sign in today, from the same rules that grant access:
 * the Users tab first, then every active employee through employeeAccessFor.
 * This is what lets the report say who has NEVER opened the dashboard.
 */
export async function expectedPeople(): Promise<ExpectedPerson[]> {
  const get = (o: any, ...keys: string[]) => {
    for (const k of Object.keys(o || {})) {
      if (keys.includes(k.toLowerCase().replace(/[\s_-]/g, ''))) return S(o[k])
    }
    return ''
  }
  const out = new Map<string, ExpectedPerson>()
  for (const u of ((await getUsers()) || []) as any[]) {
    const email = norm(get(u, 'email', 'emailaddress'))
    const role = norm(get(u, 'role', 'access', 'tier'))
    if (!email || !role || out.has(email)) continue
    out.set(email, { email, role, name: get(u, 'name', 'fullname', 'displayname'), salon: get(u, 'salons', 'salon') })
  }
  const t = await loadAccessTables()
  for (const p of t.profiles as any[]) {
    const email = norm(p?.email)
    if (!email || out.has(email)) continue
    const a = employeeAccessFor(email, t)
    if (!a) continue
    out.set(email, {
      email, role: a.role, salon: (a.salons || []).join('/'),
      name: S(p.payrollName || p.name || p.employeeName || p.fullName || ''),
    })
  }
  return [...out.values()]
}
