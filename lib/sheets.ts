import { google, sheets_v4 } from 'googleapis'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'

// Read+write scope. Bumped from spreadsheets.readonly to support scraper writes.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

function getAuth() {
  const credentials = {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }

  if (credentials.client_email && credentials.private_key) {
    return new google.auth.GoogleAuth({
      credentials,
      scopes: SCOPES,
    })
  }

  return new google.auth.GoogleAuth({ scopes: SCOPES })
}

function sheetsClient(): sheets_v4.Sheets {
  return google.sheets({ version: 'v4', auth: getAuth() })
}

// ── Reads ─────────────────────────────────────────────────────

// Retry transient Google Sheets rate-limit errors (429) and brief 503s with
// exponential backoff. Per-minute read/write quotas reset within 60s, so the
// later delays are long enough to clear the window before giving up.
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [2000, 5000, 12000, 30000] // ms — up to 4 retries (~49s total)
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const status = err?.code ?? err?.status ?? err?.response?.status
      if ((status !== 429 && status !== 503) || attempt >= delays.length) throw err
      const wait = delays[attempt]
      console.warn(`[sheets] ${label} rate-limited (${status}); retry ${attempt + 1}/${delays.length} in ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

export async function readSheet(sheetName: string, range?: string) {
  try {
    const sheets = sheetsClient()
    const fullRange = range ? `${sheetName}!${range}` : sheetName
    const response = await withRetry(`read ${sheetName}`, () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: fullRange,
      })
    )
    return response.data.values || []
  } catch (error) {
    console.error(`Error reading sheet ${sheetName}:`, error)
    return []
  }
}

export function rowsToObjects(rows: any[][]): Record<string, any>[] {
  if (!rows.length) return []
  const headers = rows[0].map((h: string) => h?.toString().trim())
  return rows.slice(1).map(row => {
    const obj: Record<string, any> = {}
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? ''
    })
    return obj
  })
}

export async function getSalonWeeks() {
  return rowsToObjects(await readSheet('SalonData'))
}
export async function getEmployeeWeeks() {
  // Live weekly employee metrics written by the SD3 scraper. (Was the legacy
  // 'EmpData' tab, which the current scrapers no longer populate — that stale
  // pointer is why recent weeks showed "No employee data".)
  return rowsToObjects(await readSheet('SD_EMP_WEEKLY'))
}
export async function getBonusPeriods() {
  return rowsToObjects(await readSheet('BonusData'))
}
// Weekly CONSOLIDATED per-employee rows (merged across float). Resilient: returns
// [] if the tab doesn't exist yet (before the first weekly-consolidated scrape),
// so getAllData never hard-fails on a fresh deploy.
export async function getEmployeeWeeklyConsolidated() {
  try { return rowsToObjects(await readSheet('SD_EMP_WEEKLY_CONS')) }
  catch { return [] }
}
export async function getSalonSummaries() {
  return rowsToObjects(await readSheet('SalonSummaryData'))
}
export async function getPayrollConsolidated() {
  return rowsToObjects(await readSheet('PayrollConsolidatedData'))
}
// Weekly payroll (SD_PAYROLL) — carries per-employee base wage, which the
// consolidated table drops during aggregation. Used to surface current wage.
export async function getPayrollWeekly() {
  return rowsToObjects(await readSheet('SD_PAYROLL'))
}
export async function getManagerTable() {
  return rowsToObjects(await readSheet('ManagerTable'))
}
export async function getPenaltyWaivers() {
  return rowsToObjects(await readSheet('PenaltyWaivers'))
}
export async function getAMAssignments() {
  // Effective-dated salon→AM assignments. Tab may not exist yet — treat
  // missing/unreadable as "no overrides" so the dashboard falls back to the
  // current SalonRoster mapping.
  try {
    return rowsToObjects(await readSheet('AMAssignments'))
  } catch {
    return []
  }
}
export async function getSalonRoster() {
  // SalonRoster maps each salon → its AM (the `am` column) + status. Used as
  // the baseline salon→AM mapping when AMAssignments has no override rows for
  // an AM. Tolerant of a missing tab.
  try {
    return rowsToObjects(await readSheet('SalonRoster'))
  } catch {
    return []
  }
}
export async function getAreaManagers() {
  // AM identity (key, name, init, color, globalId, payId). Editable source of
  // truth that replaces the hardcoded AMS constant. Salons are NOT stored here
  // — those live in AMAssignments (effective-dated). Tolerant of a missing tab.
  try {
    return rowsToObjects(await readSheet('AreaManagers'))
  } catch {
    return []
  }
}
export async function getEmployeeProfiles() {
  // SD3-sourced employee profiles incl. login email (globalId, email, ...).
  // SERVER-ONLY: email is PII + an auth credential — never include this in any
  // payload sent to the browser. Tolerant of a missing tab.
  try {
    return rowsToObjects(await readSheet('EmployeeProfile'))
  } catch {
    return []
  }
}
export async function getHomeData() {
  return rowsToObjects(await readSheet('HomeData'))
}
export async function getUsers() {
  return rowsToObjects(await readSheet('Users'))
}
export async function getTrackerData() {
  // Legacy tracker tab — may not exist (the Apps Script workflow it came from
  // is being retired). Treat missing/unreadable as "no tracker rows" so
  // getAllData never errors on its absence.
  try {
    return rowsToObjects(await readSheet('TrackerData'))
  } catch {
    return []
  }
}

/**
 * On-demand daily reader for the Daily view. Reads salon-level (SD_DAILY) and
 * per-stylist (SD_EMP_DAILY) rows for the [start, end] date window (inclusive,
 * YYYY-MM-DD — lexicographic compare == chronological). Deliberately NOT part
 * of getAllDashboardData: these tabs grow every day and are only needed when
 * the Daily tab is opened.
 *
 * SD_DAILY is keyed by storeId only, so we join SalonRoster to attach salonNum
 * to each salon-day row, making the response self-contained for the UI.
 */
export async function getDailyRange(start: string, end: string, opts?: { skipEmp?: boolean }) {
  const skipEmp = !!opts?.skipEmp
  const [salonRaw, empRaw, rosterRaw] = await Promise.all([
    readSheet('SD_DAILY'),
    skipEmp ? Promise.resolve([] as any[]) : readSheet('SD_EMP_DAILY'),
    readSheet('SalonRoster'),
  ])
  const inRange = (d: string) => d >= start && d <= end

  const salonNumByStore: Record<string, string> = {}
  for (const r of rowsToObjects(rosterRaw)) {
    const sid = String(r.storeId || '').trim()
    if (sid) salonNumByStore[sid] = String(r.salonNum || '').trim()
  }

  const salonDaily = rowsToObjects(salonRaw)
    .filter(r => inRange(String(r.date || '')))
    .map(r => ({ ...r, salonNum: salonNumByStore[String(r.storeId || '').trim()] || '' }))
  const empDaily = skipEmp ? [] : rowsToObjects(empRaw).filter(r => inRange(String(r.date || '')))

  return { salonDaily, empDaily }
}

/**
 * Read SD_SHIFTS rows in a date window. salonNum is already stored on each row
 * (tagged at scrape time), so no roster join is needed here.
 */
export async function getShiftsRange(start: string, end: string) {
  const raw = await readSheet('SD_SHIFTS')
  const inRange = (d: string) => d >= start && d <= end
  const shifts = rowsToObjects(raw).filter(r => inRange(String(r.date || '')))
  return { shifts }
}

/** Read SD_HALFHOUR rows in a date window. salonNum is stored on each row. */
export async function getHalfHourRange(start: string, end: string) {
  const raw = await readSheet('SD_HALFHOUR')
  const inRange = (d: string) => d >= start && d <= end
  const halfHour = rowsToObjects(raw).filter(r => inRange(String(r.date || '')))
  return { halfHour }
}

/** Read SD_DEMAND rows (real per-half-hour arrivals/waits) in a date window. */
export async function getDemandRange(start: string, end: string) {
  const raw = await readSheet('SD_DEMAND')
  const inRange = (d: string) => d >= start && d <= end
  const demand = rowsToObjects(raw).filter(r => inRange(String(r.date || '')))
  return { demand }
}

/** Read SD_CHKINOUT rows (actual clock punches) in a date window. */
export async function getChkInOutRange(start: string, end: string) {
  const raw = await readSheet('SD_CHKINOUT')
  const inRange = (d: string) => d >= start && d <= end
  const chkinout = rowsToObjects(raw).filter(r => inRange(String(r.date || '')))
  return { chkinout }
}

export async function getAllDashboardData() {
  const [
    salonRows,
    empRows,
    bonusRows,
    salonSummaryRows,
    payrollRows,
    managerRows,
    waiverRows,
    amAssignmentRows,
    homeRows,
    trackerRows,
    payrollWeeklyRows,
    empWeeklyConsRows,
  ] = await Promise.all([
    getSalonWeeks(),
    getEmployeeWeeks(),
    getBonusPeriods(),
    getSalonSummaries(),
    getPayrollConsolidated(),
    getManagerTable(),
    getPenaltyWaivers(),
    getAMAssignments(),
    getHomeData(),
    getTrackerData(),
    getPayrollWeekly(),
    getEmployeeWeeklyConsolidated(),
  ])

  return {
    salonRows,
    empRows,
    bonusRows,
    salonSummaryRows,
    payrollRows,
    managerRows,
    waiverRows,
    amAssignmentRows,
    homeRows,
    trackerRows,
    payrollWeeklyRows,
    empWeeklyConsRows,
  }
}

// ── Writes ────────────────────────────────────────────────────

export async function listTabs(): Promise<string[]> {
  const sheets = sheetsClient()
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  return (meta.data.sheets ?? [])
    .map(s => s.properties?.title ?? '')
    .filter(Boolean)
}

export async function tabExists(tabName: string): Promise<boolean> {
  const tabs = await listTabs()
  return tabs.includes(tabName)
}

export async function createTab(tabName: string): Promise<void> {
  const sheets = sheetsClient()
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  })
}

export async function ensureTab(tabName: string): Promise<boolean> {
  if (await tabExists(tabName)) return false
  await createTab(tabName)
  return true
}

export async function writeSheet(
  tabName: string,
  rows: any[][]
): Promise<void> {
  const sheets = sheetsClient()
  await ensureTab(tabName)

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: tabName,
  })

  if (rows.length === 0) return

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  })
}

export async function appendSheet(
  tabName: string,
  rows: any[][]
): Promise<void> {
  if (rows.length === 0) return
  const sheets = sheetsClient()
  await ensureTab(tabName)

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: tabName,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  })
}

export async function upsertSheet(
  tabName: string,
  headers: string[],
  keyColumns: string[],
  rowsAsObjects: Record<string, any>[]
): Promise<{ updated: number; inserted: number }> {
  if (rowsAsObjects.length === 0) return { updated: 0, inserted: 0 }

  const sheets = sheetsClient()
  await ensureTab(tabName)

  const existing = await readSheet(tabName)

  let existingHeaders: string[]
  let existingRows: any[][]

  if (existing.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    })
    existingHeaders = headers
    existingRows = []
  } else {
    existingHeaders = existing[0].map((h: any) => String(h).trim())
    existingRows = existing.slice(1)
  }

  // Reconcile header: if the caller passes columns the sheet doesn't have yet
  // (e.g. new fields added to a COLUMNS list), append them to the header row so
  // their values have somewhere to land. Without this, new columns are silently
  // dropped on an existing tab. Existing data rows keep their length; the new
  // trailing cells read as '' until rewritten below.
  const missingCols = headers.filter(h => !existingHeaders.includes(h))
  if (missingCols.length > 0) {
    existingHeaders = [...existingHeaders, ...missingCols]
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [existingHeaders] },
    })
  }

  const keyIdxs = keyColumns.map(k => existingHeaders.indexOf(k))
  if (keyIdxs.some(i => i === -1)) {
    throw new Error(
      `upsertSheet(${tabName}): one or more keyColumns not found in headers. ` +
        `Need: ${keyColumns.join(', ')}. Have: ${existingHeaders.join(', ')}`
    )
  }

  const existingByKey = new Map<string, number>()
  existingRows.forEach((row, i) => {
    const key = keyIdxs.map(idx => String(row[idx] ?? '')).join('||')
    existingByKey.set(key, i + 2)
  })

  const updates: { range: string; values: any[][] }[] = []
  const insertRows: any[][] = []
  let updatedCount = 0

  // De-dupe the incoming batch by key (last occurrence wins). Without this, two
  // rows sharing a key that aren't yet in the sheet would BOTH be inserted,
  // creating duplicates — this was doubling SD_EMP_DAILY rows whenever a daily
  // CSV listed a person more than once for the same day.
  const dedupedByKey = new Map<string, Record<string, any>>()
  for (const obj of rowsAsObjects) {
    const key = keyColumns.map(k => String(obj[k] ?? '')).join('||')
    dedupedByKey.set(key, obj)
  }

  for (const obj of dedupedByKey.values()) {
    const newRow = existingHeaders.map(h => obj[h] ?? '')
    const key = keyColumns.map(k => String(obj[k] ?? '')).join('||')
    const existingRowNum = existingByKey.get(key)

    if (existingRowNum) {
      updates.push({
        range: `${tabName}!A${existingRowNum}`,
        values: [newRow],
      })
      updatedCount++
    } else {
      insertRows.push(newRow)
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    })
  }

  if (insertRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: tabName,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: insertRows },
    })
  }

  return { updated: updatedCount, inserted: insertRows.length }
}