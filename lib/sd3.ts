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
 * One reconciled shift-variance record from /rest/schedule/variance.
 * Each record is per employee, per day, per shift, and carries BOTH the
 * scheduled times (starttimes/endtimes) and the actual worked times
 * (starttime/checktime…), plus SD3's pre-computed variance (minute diffs,
 * a variancetypemask bitmask, and a human-readable notes string).
 * The record has no store field — we tag it with the storeId we queried.
 */
export interface SD3ShiftVariance {
  date: string
  storeId: number
  [key: string]: unknown
}

/** Pull a response that's either a bare array or an object wrapping one. */
function asRowArray(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    // Known/likely wrappers, then any array-valued property as a fallback.
    for (const k of ['variances', 'detailedData', 'data', 'results', 'rows', 'shifts']) {
      if (Array.isArray(obj[k])) return obj[k] as Array<Record<string, unknown>>
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>
    }
  }
  return []
}

/**
 * Pull schedule-variance rows for ONE store over a date range (inclusive).
 * Dates are YYYY-MM-DD. Queried per-store so every row belongs to `storeId`.
 * includeDetailedData=true is what returns the rich per-shift fields.
 */
export async function fetchShifts(
  session: SD3Session,
  storeId: number,
  startDate: string,
  endDate: string
): Promise<SD3ShiftVariance[]> {
  const url =
    `${SD3_BASE}/rest/schedule/variance` +
    `?storeIds=${storeId}&start=${startDate}&end=${endDate}` +
    `&initial=true&employees=0&includeDetailedData=true`

  const res = await fetch(url, { headers: jsonHeaders(session.token) })
  if (!res.ok) {
    throw new Error(
      `schedule/variance failed for storeId=${storeId}: ${res.status} ${res.statusText}`
    )
  }

  const rows = asRowArray(await res.json())
  return rows.map(row => ({
    ...row,
    date: String(row.date ?? ''),
    storeId,
  })) as SD3ShiftVariance[]
}

/**
 * One half-hour optimal-staffing record from dailyhalfhouroptimal.
 * Per store/day/half-hour: demand (customerCount), the model's optimal
 * staffing (peakStylistNeeded), and who was actually on the floor
 * (peakStylistWorked). halfHour is the slot index from midnight (×30 min).
 */
export interface SD3HalfHourOptimal {
  date: string
  storeId: number
  halfHour: number
  [key: string]: unknown
}

/**
 * Pull half-hour optimal-vs-actual staffing for ONE store over a date range.
 * Sibling of dailystoresummary under /rest/storeconfig/{id}/… ; storeId comes
 * back nested in storeConfig, so we re-tag from extractStoreId with a fallback.
 */
export async function fetchHalfHourOptimal(
  session: SD3Session,
  storeId: number,
  startDate: string,
  endDate: string
): Promise<SD3HalfHourOptimal[]> {
  const url =
    `${SD3_BASE}/rest/storeconfig/dailyhalfhouroptimal` +
    `?storeConfig=${storeId}&date>=${startDate}&date<=${endDate}`

  const res = await fetch(url, { headers: jsonHeaders(session.token) })
  if (!res.ok) {
    throw new Error(
      `dailyhalfhouroptimal failed for storeId=${storeId}: ${res.status} ${res.statusText}`
    )
  }

  const rows = asRowArray(await res.json())
  return rows.map(row => ({
    ...row,
    date: String(row.date ?? ''),
    halfHour: Number(row.halfHour ?? -1),
    storeId: extractStoreId(row) ?? storeId,
  })) as SD3HalfHourOptimal[]
}

/**
 * A deliberately minimal, PII-FREE projection of an invoice. We read the raw
 * /rest/invoice rows (which carry customer identifiers, names, OCI profile ids,
 * etc.) but keep ONLY the operational timestamps needed to count demand and
 * waits. Every identifying field is dropped here at the boundary, so no customer
 * data ever leaves this function.
 */
export interface SD3InvoiceLite {
  storeId: number
  invoiceDate: string
  timeIn: string | null      // PHYSICAL in-store arrival (NOT origTimeIn/online check-in)
  timeServed: string | null  // when service started (null = never served)
  timeOut: string | null     // when service ended / customer left the chair
  estWait: number | null     // posted estimated wait at arrival
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

/**
 * Pull invoices for ONE store over a date range and return only the PII-free
 * lite projection. The caller aggregates these to per-half-hour counts; the raw
 * rows (with customer data) are discarded the moment this returns.
 */
export async function fetchInvoices(
  session: SD3Session,
  storeId: number,
  startDate: string,
  endDate: string
): Promise<SD3InvoiceLite[]> {
  const url =
    `${SD3_BASE}/rest/invoice` +
    `?storeConfig=${storeId}&invoiceDate>=${startDate}&invoiceDate<=${endDate}`

  const res = await fetch(url, { headers: jsonHeaders(session.token) })
  if (!res.ok) {
    throw new Error(
      `invoice failed for storeId=${storeId}: ${res.status} ${res.statusText}`
    )
  }

  const rows = asRowArray(await res.json())
  return rows.map(r => ({
    storeId,
    invoiceDate: String(r.invoiceDate ?? ''),
    // timeIn is the PHYSICAL in-store arrival. origTimeIn (the online check-in
    // click) is deliberately ignored so an OCI customer's at-home/in-transit
    // minutes never count toward the in-store line.
    timeIn: r.timeIn ? String(r.timeIn) : null,
    timeServed: r.timeServed ? String(r.timeServed) : null,
    timeOut: r.timeOut ? String(r.timeOut) : null,
    estWait: numOrNull(r.estimatedWaitMinutesAtArrival ?? r.originalEstWait),
  }))
}

/**
 * Actual employee clock punches (EmpChkInOut). This is the COMPLETE per-segment
 * record for every employee — unlike SD_SHIFTS (a schedule/variance feed that
 * was missing people). Each segment carries role flags (asStylist/asRecept/
 * asTraining/asAdmin) so we can count only floor-cutting time, plus breakTime so
 * we can net non-cutting minutes. checkInTime/checkOutTime are the punch window.
 */
export interface SD3ChkInOut {
  chkPk: number | null
  storeId: number
  date: string
  employeePk: number | null
  employeeId: number | null
  fname: string
  lname: string
  checkInTime: string | null
  checkOutTime: string | null
  hours: number | null
  breakTime: number | null            // minutes on break inside this segment
  asStylist: boolean
  asRecept: boolean
  asTraining: boolean
  asAdmin: boolean
  absent: boolean
  custsWaitingAtTimeOut: number | null
  estWaitAtTimeOut: number | null
}

function addOneDayIso(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Pull ALL employees' clock punches for one store over a date range. Endpoint is
 * per-store path-segment with a checkInTime window (end is exclusive, so we add a
 * day). NO employee= filter → every employee; the x= param is not a row cap.
 */
export async function fetchEmpChkInOut(
  session: SD3Session,
  storeId: number,
  startDate: string,
  endDate: string
): Promise<SD3ChkInOut[]> {
  const endExclusive = addOneDayIso(endDate)
  const url =
    `${SD3_BASE}/rest/storeconfig/${storeId}/empchkinout` +
    `?checkInTime>=${startDate}&checkInTime<${endExclusive}`

  const res = await fetch(url, { headers: jsonHeaders(session.token) })
  if (!res.ok) {
    throw new Error(
      `empchkinout failed for storeId=${storeId}: ${res.status} ${res.statusText}`
    )
  }

  const rows = asRowArray(await res.json())
  return rows.map(r => {
    const emp = ((r as any).employee?.objectId?.idSnapshot) || {}
    const chk = ((r as any).objectId?.idSnapshot) || {}
    return {
      chkPk: numOrNull(chk.employeecheckinoutpk),
      storeId: extractStoreId(r) ?? storeId,
      date: String(r.date ?? ''),
      employeePk: numOrNull(emp.employeepk),
      employeeId: numOrNull(r.employeeId),
      fname: String(r.fname ?? r.firstName ?? ''),
      lname: String(r.lname ?? r.lastName ?? ''),
      checkInTime: r.checkInTime ? String(r.checkInTime) : null,
      checkOutTime: (r.checkOutTime ?? r.checkOutTimeNonNull)
        ? String(r.checkOutTime ?? r.checkOutTimeNonNull) : null,
      hours: numOrNull(r.hours),
      breakTime: numOrNull(r.breakTime),
      asStylist: !!r.asStylist,
      asRecept: !!r.asRecept,
      asTraining: !!r.asTraining,
      asAdmin: !!r.asAdmin,
      absent: !!r.absent,
      custsWaitingAtTimeOut: numOrNull(r.custsWaitingAtTimeOut),
      estWaitAtTimeOut: numOrNull(r.estWaitAtTimeOut),
    }
  })
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

/**
 * Pull the employee `reporting` endpoint (JSON) for the given stores/range.
 * This is the ADP-replacement source: hire/rehire dates + home store. The
 * response carries PII (names, addresses, photo thumbnails) — the PROFILE
 * SCRAPER is responsible for discarding everything except an explicit
 * allow-list. This helper just returns the raw parsed JSON; it never logs it.
 *
 * Auth: Bearer header (same as listx), NOT a URL token like the CSV endpoints.
 */
export async function fetchEmployeeReporting(
  session: SD3Session,
  storeIds: number[],
  startDate: string,
  endDate: string
): Promise<unknown> {
  const stores = storeIds.join(',')
  const url =
    `${SD3_BASE}/rest/employee/reporting` +
    `?storeIds=${stores}&start=${startDate}&end=${endDate}`

  const res = await fetch(url, { headers: jsonHeaders(session.token) })
  if (!res.ok) {
    throw new Error(`Employee reporting fetch failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// ── Internals ────────────────────────────────────────────────

function jsonHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'X-App': 'SALONDATA',
    Accept: 'application/json',
  }
}
// ── Concurrency helper ───────────────────────────────────────

/**
 * Map an async function over an array with bounded concurrency.
 *
 * Unlike Promise.all(items.map(fn)) which fires ALL requests at once,
 * this processes `concurrency` items at a time, waiting for each batch
 * to complete before starting the next.
 *
 * Used to throttle SD3 calls so long-range fetches (like monthly) don't
 * overwhelm SD3 with 38+ simultaneous requests.
 *
 * @param items       — input array
 * @param concurrency — how many to run in parallel (e.g. 4)
 * @param fn          — async mapper
 * @returns           — results in the SAME ORDER as input items
 */
export async function batchMap<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}