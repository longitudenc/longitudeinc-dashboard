// lib/home.ts
//
// HOMEPAGE CONTENT — announcements, important dates, and quick links.
//
// All three are spreadsheet-driven so the content can change without a deploy:
//
//   Announcements  — id, title, body, pinned, startDate, endDate, audience, ...
//   ImportantDates — id, title, date, endDate, category, note, audience
//   HomeLinks      — id, label, url, icon, category, sortOrder, audience
//
// Every row carries an `audience` cell (comma-separated roles, or blank/'all')
// so a notice can be aimed at just AMs, just stylists, or everyone. The gating
// helper is shared with the forms engine.

import { readSheet, rowsToObjects, getEmployeeProfiles } from './sheets'
import { audienceAllows } from './forms'
import type { Role } from './auth-roles'

export const TAB_ANNOUNCEMENTS = 'Announcements'
export const TAB_DATES = 'ImportantDates'
export const TAB_LINKS = 'HomeLinks'

export const ANNOUNCEMENT_COLUMNS = [
  'id', 'title', 'body', 'imageUrl', 'pinned', 'startDate', 'endDate', 'audience', 'createdBy', 'createdAt',
] as const

export const DATE_COLUMNS = [
  'id', 'title', 'date', 'endDate', 'category', 'note', 'audience',
] as const

export const LINK_COLUMNS = [
  'id', 'label', 'url', 'icon', 'category', 'sortOrder', 'audience',
] as const

const norm = (s: unknown) => String(s ?? '').trim()
const num = (s: unknown) => { const n = Number(norm(s)); return Number.isFinite(n) ? n : 0 }

function truthy(v: unknown): boolean {
  const s = norm(v).toLowerCase()
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'x'
}

// Today in Charlotte time. Vercel runs UTC, so a naive new Date() rolls over to
// tomorrow at 8pm ET and would expire an announcement early.
export function todayIsoET(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

// Sheets may hand back a real date cell ("8/21/2026") or a typed string.
// Normalize both to YYYY-MM-DD; return '' when unparseable.
export function normalizeDate(v: unknown): string {
  const s = norm(v)
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const [, mo, d, y] = m
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
  }
  return ''
}

// Only http(s) and same-origin paths are allowed anywhere a URL from the sheet
// becomes an href or an img src. Blocks `javascript:` and keeps `data:` blobs
// (which would bloat a cell and dodge review) out of the page.
export function isSafeUrl(url: unknown): boolean {
  const s = norm(url)
  return !!s && (/^https?:\/\//i.test(s) || s.startsWith('/'))
}

export interface Announcement {
  id: string
  title: string
  body: string
  imageUrl: string
  pinned: boolean
  startDate: string
  endDate: string
  audience: string[]
  createdBy: string
  createdAt: string
}

export interface ImportantDate {
  auto?: boolean            // true = generated celebration (no edit controls)
  id: string
  title: string
  date: string
  endDate: string
  category: string
  note: string
  audience: string[]
  daysAway: number
}

export interface HomeLink {
  id: string
  label: string
  url: string
  icon: string
  category: string
  sortOrder: number
  audience: string[]
}

const splitList = (v: unknown) => norm(v).split(/[|;,]/).map(s => s.trim()).filter(Boolean)

// Whole-day difference between two YYYY-MM-DD strings, parsed as UTC midnight
// so DST transitions can't produce an off-by-one.
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z')
  const b = Date.parse(toIso + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86400000)
}

// ── Announcements ─────────────────────────────────────────────
// Live = started (or no start) and not yet ended (or no end). Pinned first,
// then newest start date.
export async function getAnnouncements(role: Role | string): Promise<Announcement[]> {
  const rows = rowsToObjects(await readSheet(TAB_ANNOUNCEMENTS))
  const today = todayIsoET()

  return rows
    .map(r => ({
      id: norm(r.id),
      title: norm(r.title),
      body: norm(r.body),
      // Dropped rather than rendered if it isn't a safe URL.
      imageUrl: isSafeUrl(r.imageUrl) ? norm(r.imageUrl) : '',
      pinned: truthy(r.pinned),
      startDate: normalizeDate(r.startDate),
      endDate: normalizeDate(r.endDate),
      audience: splitList(r.audience),
      createdBy: norm(r.createdBy),
      createdAt: norm(r.createdAt),
    }))
    .filter(a => a.id && a.title)
    .filter(a => audienceAllows(a.audience, role))
    .filter(a => (!a.startDate || a.startDate <= today) && (!a.endDate || a.endDate >= today))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.startDate || '').localeCompare(a.startDate || '')
    })
}

// ── Important dates ───────────────────────────────────────────
// Anything still ahead, or a multi-day window we're currently inside. Limited
// to the next `horizonDays` so the strip doesn't fill with next year's items.
export async function getImportantDates(role: Role | string, horizonDays = 120): Promise<ImportantDate[]> {
  const rows = rowsToObjects(await readSheet(TAB_DATES))
  const today = todayIsoET()

  return rows
    .map(r => {
      const date = normalizeDate(r.date)
      const endDate = normalizeDate(r.endDate)
      return {
        id: norm(r.id),
        title: norm(r.title),
        date,
        endDate,
        category: norm(r.category),
        note: norm(r.note),
        audience: splitList(r.audience),
        daysAway: date ? daysBetween(today, date) : 0,
      }
    })
    .filter(d => d.id && d.title && d.date)
    .filter(d => audienceAllows(d.audience, role))
    .filter(d => {
      const effectiveEnd = d.endDate || d.date
      if (effectiveEnd < today) return false          // fully past
      return d.daysAway <= horizonDays
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ── Quick links ───────────────────────────────────────────────
export async function getHomeLinks(role: Role | string): Promise<HomeLink[]> {
  const rows = rowsToObjects(await readSheet(TAB_LINKS))

  return rows
    .map(r => ({
      id: norm(r.id),
      label: norm(r.label),
      url: norm(r.url),
      icon: norm(r.icon) || '🔗',
      category: norm(r.category) || 'General',
      sortOrder: num(r.sortOrder),
      audience: splitList(r.audience),
    }))
    .filter(l => l.id && l.label && l.url)
    .filter(l => audienceAllows(l.audience, role))
    .filter(l => isSafeUrl(l.url))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
}

export function newId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// ── Auto celebrations (CELEBRATIONS-v1) ───────────────────────
// Upcoming work anniversaries & birthdays (next `horizon` days) and recent new
// hires (last `newHireDays`), generated from EmployeeProfile — no manual entry.
// Scoped to the viewer's salons when they have them (area managers); company-
// wide for owner/admin. Birthday is stored month-day only, so no age is exposed.
function displayName(name: string): string {
  const n = String(name || '').trim()
  if (n.includes(',')) { const [l, f] = n.split(',').map(x => x.trim()); return `${f} ${l}`.trim() }
  return n
}
function monthDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[2]}-${m[3]}` : ''
}
export async function getCelebrations(
  salons?: string[],
  opts: { horizon?: number; newHireDays?: number; cap?: number } = {}
): Promise<ImportantDate[]> {
  const horizon = opts.horizon ?? 14
  const newHireDays = opts.newHireDays ?? 14
  const cap = opts.cap ?? 16
  const today = todayIsoET()
  const y = Number(today.slice(0, 4))
  const scope = salons && salons.length ? new Set(salons.map(x => String(x).trim())) : null

  const nextOccurrence = (md: string): { date: string; daysAway: number } | null => {
    if (!/^\d{2}-\d{2}$/.test(md)) return null
    let cand = `${y}-${md}`
    if (cand < today) cand = `${y + 1}-${md}`
    return { date: cand, daysAway: daysBetween(today, cand) }
  }

  let profs: any[] = []
  try { profs = await getEmployeeProfiles() } catch { return [] }
  const out: ImportantDate[] = []

  for (const p of profs) {
    if (String(p.inactive || '').toLowerCase() === 'true') continue
    const home = String(p.homeStoreNum || '').trim()
    if (scope && !scope.has(home)) continue
    const nm = displayName(String(p.name || ''))
    if (!nm) continue
    const gid = String(p.globalId || '').trim()

    const hire = String(p.dateOfHire || '').trim().slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(hire)) {
      const sinceHire = daysBetween(hire, today)
      if (sinceHire >= 0 && sinceHire <= newHireDays) {
        out.push({ id: 'auto-hire-' + gid, title: `Welcome ${nm}`, date: hire, endDate: '', category: '', note: 'New team member', audience: [], daysAway: 0, auto: true })
      }
      const occ = nextOccurrence(monthDay(hire))
      if (occ && occ.daysAway <= horizon) {
        const years = Number(occ.date.slice(0, 4)) - Number(hire.slice(0, 4))
        if (years >= 1) out.push({ id: 'auto-anniv-' + gid, title: `${nm} — ${years}-year work anniversary`, date: occ.date, endDate: '', category: '', note: '', audience: [], daysAway: occ.daysAway, auto: true })
      }
    }

    const bocc = nextOccurrence(String(p.birthday || '').trim())
    if (bocc && bocc.daysAway <= horizon) {
      out.push({ id: 'auto-bday-' + gid, title: `${nm} — Birthday`, date: bocc.date, endDate: '', category: '', note: '', audience: [], daysAway: bocc.daysAway, auto: true })
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, cap)
}
