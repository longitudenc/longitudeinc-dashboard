// lib/sd3.ts
// Salondata 3 API client — auth, salon mapping, and report fetchers
// Endpoint reconnaissance documented in session memory.

const SD3_BASE = 'https://reports.salondata.com'

// ── Types ─────────────────────────────────────────────────────

export interface SD3Salon {
  /** Public salon number (e.g. "1304") */
  salonNum: string
  /** Internal SD3 store ID / primary key (e.g. 19436) */
  storeId: number
  /** Plaza/location name (e.g. "Hilltop Plaza") */
  name: string
  city: string
  state: string
  market: string
  /** District manager / owner */
  district: string
  /** Entity name (e.g. "Longitude, Inc.") */
  entity: string
  openedOn: string | null
  /** Active flag (best-guess from SD3 schema) */
  isOpen: boolean
}

export interface SD3Session {
  token: string
  /** Unix timestamp (seconds) when the JWT expires */
  expiresAt: number
}

/**
 * Raw daily summary row from SD3's /rest/storeconfig/dailystoresummary endpoint.
 * SD3 returns ~100 fields; we keep the full shape so the scraper can persist everything.
 */
export interface SD3DailyStoreSummary {
  date: string
  storeId: number
  [key: string]: unknown
}

/**
 * Pre-aggregated summary row returned by the `grouped` endpoint.
 * Same shape as SD3DailyStoreSummary but represents a date range, not a single day.
 * The `date` field in the response will be the last day of the range.
 */
export interface SD3GroupedSummary {
  /** Last date in the aggregated range */
  date: string
  storeId: number
  [key: string]: unknown
}

// ── Auth ──────────────────────────────────────────────────────

/**
 * Authenticate against SD3 and return a Bearer JWT.
 * Token typically valid ~8 hours.
 */
export async function authenticate(): Promise<SD3Session> {
  const username = process.env.SD3_USERNAME
  const password = process.env.SD3_PASSWORD
  const app = process.env.SD3_APP || 'SALONDATA'

  if (!username || !password) {
    throw new Error(
      'SD3_USERNAME and SD3_PASSWORD must be set in environment variables.'
    )
  }

  const res = await fetch(`${SD3_BASE}/public/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app, username, password }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `SD3 auth failed: ${res.status} ${res.statusText}. Response: ${text.slice(0, 500)}`
    )
  }

  const payload = await res.json() as { token?: string }
  const token = payload.token?.trim()

  if (!token || !token.startsWith('eyJ')) {
    throw new Error(
      `SD3 auth returned unexpected payload: ${JSON.stringify(payload).slice(0, 200)}`
    )
  }

  const expiresAt = jwtExpiry(token)
  return { token, expiresAt }
}

/** Decode the `exp` claim from a JWT (no signature verification — we trust SD3). */
function jwtExpiry(token: string): number {
  try {
    const payloadB64 = token.split('.')[1]
    const b64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(b64, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { exp?: number }
    return parsed.exp ?? 0
  } catch {
    return 0
  }
}

// ── Salon list / mapping ─────────────────────────────────────

/**
 * Fetch the salon list (listx) and return a normalized array.
 * Uses the freshest mapping each call — never trust position-based lookups.
 */
export async function fetchSalons(session: SD3Session): Promise<SD3Salon[]> {
  const res = await fetch(`${SD3_BASE}/rest/storeconfig/listx`, {
    headers: jsonHeaders(session.token),
  })

  if (!res.ok) {
    throw new Error(`SD3 listx failed: ${res.status} ${res.statusText}`)
  }

  const raw = (await res.json()) as Array<Record<string, unknown>>

  return raw.map(r => ({
    salonNum: String(r.n ?? '').trim(),
    storeId: Number(r.pk),
    name: String(r.a ?? ''),
    city: String(r.c ?? ''),
    state: String(r.st ?? ''),
    market: String(r.m ?? ''),
    district: String(r.d ?? ''),
    entity: String(r.e ?? ''),
    openedOn: r.o ? String(r.o) : null,
    isOpen: Boolean(r.i),
  })).filter(s => s.salonNum && s.storeId)
}

/**
 * Build a salon# → storeId lookup map from the salon list.
 * Call this once per scraper run — never hardcode the mapping.
 */
export function buildStoreIdMap(salons: SD3Salon[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const s of salons) {
    map[s.salonNum] = s.storeId
  }
  return map
}

// ── Report fetchers ──────────────────────────────────────────

/**
 * Pull daily store summary JSON for one salon over a date range (inclusive).
 * Dates are YYYY-MM-DD. SD3 returns one object per day, with date as a string field.
 */
export async function fetchDailyStoreSummary(
  session: SD3Session,
  storeId: number,
  startDate: string,
  endDate: string
): Promise<SD3DailyStoreSummary[]> {
  const url = `${SD3_BASE}/rest/storeconfig/dailystoresummary?storeConfig=${storeId}&date>=${startDate}&date<=${endDate}`

  const res = await fetch(url, { headers: jsonHeaders(session.token) })

  if (!res.ok) {
    throw new Error(
      `dailystoresummary failed for storeId=${storeId}: ${res.status} ${res.statusText}`
    )
  }

  const raw = (await res.json()) as Array<Record<string, unknown>>

  return raw.map(row => ({
    ...row,
    date: String(row.date ?? ''),
    storeId: extractStoreId(row) ?? storeId,
  })) as SD3DailyStoreSummary[]
}

/**
 * Pull a pre-aggregated grouped summary for a salon over a date range.
 * Returns a SINGLE record summarizing the entire range (week, month, etc.).
 *
 * Verified against the live Salon Summary Report — fields match exactly:
 *   CC, serviceSales, productSales, floorHours, payrollAmount, NR/RR counts,
 *   waits, MBC inputs, etc. all pre-summed by SD3.
 *
 * groupbymask=1 → group/aggregate over the entire date range
 */
export async function fetchGroupedSummary(
  session: SD3Session,
  storeId: number,
  startDate: string,
  endDate: string
): Promise<SD3GroupedSummary | null> {
  const url = `${SD3_BASE}/rest/storeconfig/${storeId}/dailystoresummary/grouped?date>=${startDate}&date<=${endDate}&groupbymask=1`

  const res = await fetch(url, { headers: jsonHeaders(session.token) })

  if (!res.ok) {
    throw new Error(
      `groupedSummary failed for storeId=${storeId}: ${res.status} ${res.statusText}`
    )
  }

  const raw = (await res.json()) as Array<Record<string, unknown>>
  if (raw.length === 0) return null

  const row = raw[0]
  return {
    ...row,
    date: String(row.date ?? endDate),
    storeId: extractStoreId(row) ?? storeId,
  } as SD3GroupedSummary
}

function extractStoreId(row: Record<string, unknown>): number | undefined {
  const sc = row.storeConfig as Record<string, unknown> | undefined
  const obj = sc?.objectId as Record<string, unknown> | undefined
  const snap = obj?.idSnapshot as Record<string, unknown> | undefined
  const id = snap?.store_id
  return typeof id === 'number' ? id : undefined
}

/**
 * Pull employee performance CSV (Detail mode — one row per emp/salon/week).
 * Returns raw CSV text; CSV parsing happens in the scraper route.
 */
export async function fetchEmployeePerformanceCsv(
  session: SD3Session,
  storeIds: number[],
  startDate: string,
  endDate: string
): Promise<string> {
  const stores = storeIds.join(',')
  const url =
    `${SD3_BASE}/rest/dailyemployeesummary/consolidated.csv` +
    `?stores=${stores}` +
    `&start=${startDate}&end=${endDate}` +
    `&selectEmployees=true&isDetail=true` +
    `&token=${encodeURIComponent(session.token)}` +
    `&app=salondata`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Employee CSV fetch failed: ${res.status} ${res.statusText}`)
  }
  return res.text()
}

/**
 * Pull payroll consolidated CSV for the week (Sat→Fri).
 */
export async function fetchPayrollCsv(
  session: SD3Session,
  storeIds: number[],
  startDate: string,
  endDate: string
): Promise<string> {
  const stores = storeIds.join(',')
  const url =
    `${SD3_BASE}/rest/payrollweekresult/consolidated.csv` +
    `?stores=${stores}` +
    `&start=${startDate}&end=${endDate}` +
    `&token=${encodeURIComponent(session.token)}` +
    `&app=salondata`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Payroll CSV fetch failed: ${res.status} ${res.statusText}`)
  }
  return res.text()
}

// ── Internals ────────────────────────────────────────────────

function jsonHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'X-App': 'SALONDATA',
    Accept: 'application/json',
  }
}