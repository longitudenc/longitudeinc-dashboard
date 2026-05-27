// scripts/test-sd3-auth.ts
// Tests the sheets.ts write functions against a THROWAWAY tab called "_TEST_SCRAPER".
// Safe to run repeatedly. Creates the tab if missing, writes/updates rows, deletes it at the end.

import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: '.env.local' })

import {
  listTabs,
  tabExists,
  ensureTab,
  writeSheet,
  appendSheet,
  upsertSheet,
  readSheet,
} from '../sheets'
import { google } from 'googleapis'

const TEST_TAB = '_TEST_SCRAPER'
const SHEET_ID = '1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE'

async function deleteTab(tabName: string) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  const sheets = google.sheets({ version: 'v4', auth })
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  const sheet = meta.data.sheets?.find(s => s.properties?.title === tabName)
  if (!sheet?.properties?.sheetId) return
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }],
    },
  })
}

async function main() {
  console.log('=== Sheets Write Test ===\n')

  // Clean slate: delete the test tab if it exists from a prior run
  if (await tabExists(TEST_TAB)) {
    console.log(`Found existing ${TEST_TAB} from prior run — deleting...`)
    await deleteTab(TEST_TAB)
    console.log('  ✓ Deleted\n')
  }

  // Step 1: listTabs
  console.log('Step 1: List existing tabs')
  const tabs = await listTabs()
  console.log(`  ✓ Found ${tabs.length} tabs: ${tabs.slice(0, 5).join(', ')}${tabs.length > 5 ? '…' : ''}\n`)

  // Step 2: ensureTab — creates new tab
  console.log(`Step 2: ensureTab('${TEST_TAB}')`)
  const created = await ensureTab(TEST_TAB)
  console.log(`  ✓ ${created ? 'Created new tab' : 'Tab already existed'}\n`)

  // Step 3: writeSheet — overwrite with initial data
  console.log('Step 3: writeSheet — write 3 initial rows')
  const initialRows = [
    ['date', 'storeId', 'cc', 'sales'],
    ['2026-05-16', 3923, 56, 1063.96],
    ['2026-05-17', 3923, 40, 822.00],
    ['2026-05-18', 3923, 52, 977.98],
  ]
  await writeSheet(TEST_TAB, initialRows)
  console.log('  ✓ Wrote 3 rows + header\n')

  // Step 4: appendSheet — add more rows
  console.log('Step 4: appendSheet — append 2 more rows')
  await appendSheet(TEST_TAB, [
    ['2026-05-19', 3923, 48, 931.00],
    ['2026-05-20', 3923, 53, 1019.98],
  ])
  console.log('  ✓ Appended 2 rows\n')

  // Step 5: Read back & verify
  console.log('Step 5: readSheet — verify content')
  const readBack = await readSheet(TEST_TAB)
  console.log(`  ✓ Read ${readBack.length} rows (expected 6 = 1 header + 5 data)`)
  if (readBack.length !== 6) {
    throw new Error(`Expected 6 rows, got ${readBack.length}`)
  }
  console.log()

  // Step 6: upsertSheet — update one existing row, add one new row
  console.log('Step 6: upsertSheet — update 5/16 row, insert 5/21 row')
  const result = await upsertSheet(
    TEST_TAB,
    ['date', 'storeId', 'cc', 'sales'],
    ['date', 'storeId'],
    [
      { date: '2026-05-16', storeId: 3923, cc: 999, sales: 9999.99 }, // existing → update
      { date: '2026-05-21', storeId: 3923, cc: 54, sales: 995.95 },   // new → insert
    ]
  )
  console.log(`  ✓ Updated: ${result.updated}, Inserted: ${result.inserted}`)
  if (result.updated !== 1 || result.inserted !== 1) {
    throw new Error(`Expected 1 updated + 1 inserted, got ${result.updated}+${result.inserted}`)
  }
  console.log()

  // Step 7: Re-read & verify upsert worked
  console.log('Step 7: Verify upsert results')
  const finalRows = await readSheet(TEST_TAB)
  console.log(`  Total rows: ${finalRows.length} (header + ${finalRows.length - 1} data)`)

  const row516 = finalRows.find(r => r[0] === '2026-05-16')
  if (!row516 || Number(row516[2]) !== 999) {
    throw new Error(`5/16 row not updated correctly: ${JSON.stringify(row516)}`)
  }
  console.log(`  ✓ 5/16 row was updated (cc now 999)`)

  const row521 = finalRows.find(r => r[0] === '2026-05-21')
  if (!row521) {
    throw new Error('5/21 row was not inserted')
  }
  console.log(`  ✓ 5/21 row was inserted`)
  console.log()

  // Step 8: Cleanup
  console.log(`Step 8: Cleanup — delete ${TEST_TAB}`)
  await deleteTab(TEST_TAB)
  console.log('  ✓ Tab deleted\n')

  console.log('=== All sheets write tests PASSED ✓ ===')
}

main().catch(err => {
  console.error('\n=== Test FAILED ✗ ===')
  console.error(err)
  process.exit(1)
})