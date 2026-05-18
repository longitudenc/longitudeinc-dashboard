import { google } from 'googleapis'

const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'

// Authenticate using service account or OAuth
function getAuth() {
  // During development/migration we use the service account
  // The private key comes from environment variables
  const credentials = {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }

  if (credentials.client_email && credentials.private_key) {
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
  }

  // Fallback: use application default credentials (for local dev)
  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
}

export async function readSheet(sheetName: string, range?: string) {
  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })
    const fullRange = range ? `${sheetName}!${range}` : sheetName
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: fullRange,
    })
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

// ── Sheet readers ─────────────────────────────────────────────

export async function getSalonWeeks() {
  const rows = await readSheet('SalonData')
  return rowsToObjects(rows)
}

export async function getEmployeeWeeks() {
  const rows = await readSheet('EmpData')
  return rowsToObjects(rows)
}

export async function getBonusPeriods() {
  const rows = await readSheet('BonusData')
  return rowsToObjects(rows)
}

export async function getSalonSummaries() {
  const rows = await readSheet('SalonSummaryData')
  return rowsToObjects(rows)
}

export async function getPayrollConsolidated() {
  const rows = await readSheet('PayrollConsolidatedData')
  return rowsToObjects(rows)
}

export async function getManagerTable() {
  const rows = await readSheet('ManagerTable')
  return rowsToObjects(rows)
}

export async function getPenaltyWaivers() {
  const rows = await readSheet('PenaltyWaivers')
  return rowsToObjects(rows)
}

export async function getHomeData() {
  const rows = await readSheet('HomeData')
  return rowsToObjects(rows)
}

export async function getUsers() {
  const rows = await readSheet('Users')
  return rowsToObjects(rows)
}

export async function getTrackerData() {
  const rows = await readSheet('TrackerData')
  return rowsToObjects(rows)
}

// ── Main data loader (mirrors getAllData in Apps Script) ──────

export async function getAllDashboardData() {
  const [
    salonRows,
    empRows,
    bonusRows,
    salonSummaryRows,
    payrollRows,
    managerRows,
    waiverRows,
    homeRows,
    trackerRows,
  ] = await Promise.all([
    getSalonWeeks(),
    getEmployeeWeeks(),
    getBonusPeriods(),
    getSalonSummaries(),
    getPayrollConsolidated(),
    getManagerTable(),
    getPenaltyWaivers(),
    getHomeData(),
    getTrackerData(),
  ])

  return {
    salonRows,
    empRows,
    bonusRows,
    salonSummaryRows,
    payrollRows,
    managerRows,
    waiverRows,
    homeRows,
    trackerRows,
  }
}
