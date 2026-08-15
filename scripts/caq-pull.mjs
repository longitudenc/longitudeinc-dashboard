/* ============================================================================
 * scripts/caq-pull.mjs  —  Headless monthly CAQ (Address Quality) pull.
 *
 * Logs into the Great Clips Power BI report with a plain username/password
 * (no MFA), captures the short-lived query token from the report's own network
 * traffic, replays the per-salon "% Good/Improve/Bad" query for the target
 * month(s) IN THE PAGE (same origin as the working console snippet), decodes the
 * result, and POSTs it to the dashboard's /api/ingest/address-quality route.
 *
 * Runs in GitHub Actions (see .github/workflows/caq.yml). Everything is driven
 * by env vars / repo secrets — nothing sensitive is hard-coded.
 *
 * ENV (all required except MONTHS_BACK):
 *   PBI_USER         Great Clips login email        (secret)
 *   PBI_PASS         Great Clips password           (secret — the 90-day rotation)
 *   PBI_REPORT_URL   the app.powerbi.com report URL you open in the browser (secret/var)
 *   INGEST_BASE      dashboard origin, e.g. https://longitudenc.com            (var)
 *   CRON_SECRET      same secret the SD3 scrape uses                           (secret)
 *   MONTHS_BACK      how many completed months back to pull (default 1)        (optional)
 *
 * On any failure it saves a screenshot to caq-error.png (uploaded as a workflow
 * artifact) and exits non-zero, so the Action fails and GitHub emails you.
 * ========================================================================== */

import { chromium } from 'playwright'

const {
  PBI_USER, PBI_PASS, PBI_REPORT_URL,
  INGEST_BASE, CRON_SECRET,
  MONTHS_BACK = '1',
} = process.env

for (const [k, v] of Object.entries({ PBI_USER, PBI_PASS, PBI_REPORT_URL, INGEST_BASE, CRON_SECRET })) {
  if (!v) { console.error(`[CAQ] missing required env: ${k}`); process.exit(2) }
}
const monthsBack = Math.max(1, parseInt(MONTHS_BACK, 10) || 1)

// Power BI query coordinates (captured from the report — stable per report).
const PBI = {
  ENDPOINT:
    'https://68853fc149b74058b1c21bddce1809cb.pbidedicated.windows.net' +
    '/webapi/capacities/68853fc1-49b7-4058-b1c2-1bddce1809cb' +
    '/workloads/QES/QueryExecutionService/automatic/public/query',
  DATASET_ID: '72a60a73-5aaf-4ead-85ca-c155672c610a',
  REPORT_ID: 'c31d50ca-edab-4111-8755-8fe02eb156d6',
  VISUAL_ID: '93d90e7ad79c0d34a709',
  MODEL_ID: 164088,
}

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function log(...a) { console.log('[CAQ]', ...a) }

let token = null   // captured MWCToken (module scope so waitForToken sees it)

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // Capture the MWCToken off any /public/query request the report fires.
  page.on('request', (req) => {
    if (token) return
    if (!/\/public\/query(\?|$)/.test(req.url())) return
    const a = req.headers()['authorization']
    if (a && /^\s*MWCToken\s/i.test(a)) { token = a.trim(); log('token captured') }
  })

  try {
    log('opening report…')
    await page.goto(PBI_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await doLogin(page)
    log('waiting for report + token…')
    await waitForToken(page)
  } catch (e) {
    await page.screenshot({ path: 'caq-error.png', fullPage: true }).catch(() => {})
    console.error('[CAQ] login/token failed:', e && e.message ? e.message : e)
    await browser.close()
    process.exit(1)
  }

  // Run the query IN THE PAGE (same origin as the console snippet that works),
  // for each target month, and decode to [{ salon, good, improve, bad }].
  const results = []
  for (let m = 1; m <= monthsBack; m++) {
    const now = new Date()
    const startD = new Date(now.getFullYear(), now.getMonth() - m, 1)
    const periodKey = `${MONTH_ABBR[startD.getMonth()]} ${String(startD.getFullYear()).slice(2)}`
    const periodLabel = startD.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    log(`querying ${periodLabel} (${periodKey})…`)
    let decoded
    try {
      decoded = await page.evaluate(runQueryInPage, { token, monthsBack: m, PBI })
    } catch (e) {
      await page.screenshot({ path: 'caq-error.png', fullPage: true }).catch(() => {})
      console.error('[CAQ] query failed:', e && e.message ? e.message : e)
      await browser.close(); process.exit(1)
    }
    if (decoded && decoded.error) {
      console.error(`[CAQ] query error for ${periodLabel}:`, decoded.error)
      await browser.close(); process.exit(1)
    }
    results.push({ periodKey, periodLabel, rows: decoded.rows || [] })
    log(`  ${decoded.rows.length} salons`)
  }

  await browser.close()

  // Flatten → ingest rows (split "1304 Hilltop Plaza" into num + name).
  const ingestRows = []
  for (const r of results) {
    for (const s of r.rows) {
      const m = String(s.salon || '').match(/^\s*(\d+)\s*[-\u2013]?\s*(.*)$/)
      if (!m) continue
      ingestRows.push({
        periodKey: r.periodKey,
        periodLabel: r.periodLabel,
        salonNum: m[1],
        salonName: (m[2] || '').trim(),
        caqGood: s.good,
        caqImprove: s.improve,
        caqBad: s.bad,
      })
    }
  }

  if (!ingestRows.length) { console.error('[CAQ] no rows decoded — aborting write'); process.exit(1) }

  // Sanity print so a failed month is visible in the Action log.
  for (const r of results) {
    const g = r.rows.map(x => x.good).filter(x => typeof x === 'number')
    const avg = g.length ? (g.reduce((a, b) => a + b, 0) / g.length * 100).toFixed(1) : '—'
    log(`${r.periodKey}: ${r.rows.length} salons, avg %Good ${avg}%`)
  }

  const url = `${INGEST_BASE.replace(/\/$/, '')}/api/ingest/address-quality?secret=${encodeURIComponent(CRON_SECRET)}`
  log(`POSTing ${ingestRows.length} rows → ${INGEST_BASE}/api/ingest/address-quality`)
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: ingestRows }),
  })
  const text = await resp.text()
  if (!resp.ok) { console.error(`[CAQ] ingest failed HTTP ${resp.status}: ${text}`); process.exit(1) }
  log('ingest response:', text)
  log('done.')
}

async function shot(page, tag) {
  try {
    const url = page.url(); const title = await page.title().catch(() => '')
    log(`step[${tag}] url=${url} title=${JSON.stringify(title)}`)
    await page.screenshot({ path: `caq-${tag}.png`, fullPage: true }).catch(() => {})
  } catch (_) {}
}

async function doLogin(page) {
  // Standard Azure AD (no MFA). Instrumented: screenshots + url/title at each
  // step so a failed run shows exactly where it stalled. Patient timeouts,
  // because the login SPA renders client-side after the OAuth redirect chain.
  const nextSel = '#idSIButton9, input[type="submit"], button[type="submit"]'

  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {})
  await shot(page, 'landing')

  // Already on the report (cached session)? Nothing to do.
  if (/app\.powerbi\.com/i.test(page.url()) && !/login|signin/i.test(page.url())) { log('already on report'); return }

  // "Pick an account" only appears if a session cookie exists (won't in CI, but
  // handle it): choose "Use another account".
  const pick = page.getByText(/use another account/i).first()
  if (await pick.isVisible({ timeout: 4000 }).catch(() => false)) {
    log('pick-an-account -> use another'); await pick.click().catch(() => {}); await page.waitForTimeout(1500)
  }

  // Email — submit with Enter (posts the form directly; avoids clicking a hidden
  // or not-yet-enabled submit button).
  const email = page.locator('input[type="email"], input[name="loginfmt"], #i0116').first()
  if (await email.isVisible({ timeout: 45000 }).catch(() => false)) {
    log('entering username:', PBI_USER)
    await email.fill(PBI_USER)
    await email.press('Enter').catch(() => {})
    await page.waitForTimeout(2500)
  } else {
    log('WARNING: email field never appeared'); await shot(page, 'no-email')
  }

  // Password — submit with Enter; if still on the page, click the visible "Sign in".
  const pass = page.locator('input[type="password"], input[name="passwd"], #i0118').first()
  if (await pass.isVisible({ timeout: 45000 }).catch(() => false)) {
    log('entering password')
    await pass.fill(PBI_PASS)
    await pass.press('Enter').catch(() => {})
    await page.waitForTimeout(1800)
    if (await pass.isVisible({ timeout: 2500 }).catch(() => false)) {
      log('Enter did not submit — clicking Sign in')
      await page.getByRole('button', { name: /sign in/i }).first().click().catch(() => {})
    }
    await page.waitForTimeout(2500)
  } else {
    log('WARNING: password field never appeared'); await shot(page, 'no-password')
  }

  // "Stay signed in?" -> Yes (harmless if absent). Detect by heading so we don't
  // collide with the password page's own Sign in button.
  if (await page.getByText(/stay signed in/i).first().isVisible({ timeout: 12000 }).catch(() => false)) {
    log('KMSI -> Yes')
    await page.getByRole('button', { name: /^yes$/i }).first().click().catch(() => {})
    await page.waitForTimeout(2000)
  }

  await page.waitForTimeout(3000)
  await shot(page, 'post-login')
}

async function waitForToken(page) {
  // The report fires queries on load; give it time. If nothing after a while,
  // a reload nudges it. Fail loudly if still no token.
  const deadline = Date.now() + 120000
  let reloaded = false
  while (Date.now() < deadline) {
    if (token) return
    await page.waitForTimeout(1000)
    if (!reloaded && Date.now() > deadline - 75000) { reloaded = true; await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}) }
  }
  throw new Error('no MWCToken seen — the report never fired a query (login may have failed)')
}

// ---- runs INSIDE the report page (browser context) -------------------------
// Mirrors the proven console snippet: builds the SemanticQuery for the month,
// POSTs with the captured token, decodes the DSR, returns rows.
function runQueryInPage({ token, monthsBack, PBI }) {
  const now = new Date()
  const startD = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1)
  const endD = new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 1)
  const dt = d => `datetime'${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01T00:00:00'`

  const payload = {
    version: '1.0.0',
    queries: [{
      Query: { Commands: [{ SemanticQueryDataShapeCommand: {
        Query: {
          Version: 2,
          From: [
            { Name: 'c1', Entity: 'CAQ Measures', Type: 0 },
            { Name: 'd', Entity: 'Dates', Type: 0 },
            { Name: 's', Entity: 'Salon', Type: 0 },
          ],
          Select: [
            { Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Salon' }, Name: 'Salon.Salon' },
            { Measure: { Expression: { SourceRef: { Source: 'c1' } }, Property: '% Good' }, Name: 'CAQ Measures.% Good' },
            { Measure: { Expression: { SourceRef: { Source: 'c1' } }, Property: '% Improve' }, Name: 'CAQ Measures.% Improve' },
            { Measure: { Expression: { SourceRef: { Source: 'c1' } }, Property: '% Bad' }, Name: 'CAQ Measures.% Bad' },
          ],
          Where: [
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Designated Operator' } }],
              Values: [[{ Literal: { Value: "'Bullard James'" } }], [{ Literal: { Value: "'Bullard III Jess'" } }]] } } },
            { Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Active Status' } }],
              Values: [[{ Literal: { Value: "'Closed - Pending Relocation'" } }], [{ Literal: { Value: "'Opened'" } }]] } } },
            { Condition: { Not: { Expression: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'DMA Name' } }],
              Values: [[{ Literal: { Value: 'null' } }]] } } } } },
            { Condition: { Comparison: { ComparisonKind: 2,
              Left: { Column: { Expression: { SourceRef: { Source: 'd' } }, Property: 'Week End Date' } }, Right: { Literal: { Value: dt(startD) } } } } },
            { Condition: { Comparison: { ComparisonKind: 3,
              Left: { Column: { Expression: { SourceRef: { Source: 'd' } }, Property: 'Week End Date' } }, Right: { Literal: { Value: dt(endD) } } } } },
          ],
          OrderBy: [{ Direction: 1, Expression: { Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Salon' } } }],
        },
        Binding: { Primary: { Groupings: [{ Projections: [0, 1, 2, 3] }] },
          DataReduction: { DataVolume: 4, Primary: { Window: { Count: 1000 } } }, Version: 1 },
        ExecutionMetricsKind: 1,
      } }] },
      QueryId: '',
      ApplicationContext: { DatasetId: PBI.DATASET_ID, Sources: [{ ReportId: PBI.REPORT_ID, VisualId: PBI.VISUAL_ID, HostProperties: { ConsumptionMethod: 'Power BI Web App' } }] },
    }],
    cancelQueries: [], modelId: PBI.MODEL_ID, userPreferredLocale: 'en-US', allowLongRunningQueries: true,
  }

  return fetch(PBI.ENDPOINT, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json;charset=UTF-8', accept: 'application/json, text/plain, */*' },
    body: JSON.stringify(payload),
  }).then(async r => {
    if (!r.ok) return { error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` }
    const resp = await r.json()
    try {
      const data = resp.results[0].result.data
      const nameByVal = {}; data.descriptor.Select.forEach(s => (nameByVal[s.Value] = s.Name))
      const ds = data.dsr.DS[0]; const dicts = ds.ValueDicts || {}
      const ph = ds.PH[0]; const rowsR = ph[Object.keys(ph)[0]] || []
      let cols = null
      for (const row of rowsR) if (row.S) { cols = row.S.map(c => ({ N: c.N, dn: c.DN || null, name: nameByVal[c.N] || c.N })); break }
      if (!cols) return { error: 'no schema (S) in DSR' }
      const salonIdx = cols.findIndex(c => c.dn)
      const idxOf = re => cols.findIndex(c => re.test(c.name))
      const goodIdx = idxOf(/%\s*good/i), impIdx = idxOf(/%\s*improve/i), badIdx = idxOf(/%\s*bad/i)
      const out = []; let prev = null
      for (const row of rowsR) {
        const R = row.R || 0; const nulls = new Set(row['\u00d8'] || []); const C = row.C || []; let ci = 0; const v = []
        for (let i = 0; i < cols.length; i++) {
          if (nulls.has(i)) v[i] = null
          else if (R & (1 << i)) v[i] = prev ? prev[i] : null
          else v[i] = C[ci++]
        }
        prev = v
        const sr = v[salonIdx]
        const salon = cols[salonIdx].dn && typeof sr === 'number' ? dicts[cols[salonIdx].dn][sr] : sr
        if (salon == null) continue
        out.push({ salon, good: v[goodIdx], improve: impIdx >= 0 ? v[impIdx] : '', bad: badIdx >= 0 ? v[badIdx] : '' })
      }
      return { rows: out }
    } catch (e) { return { error: 'decode failed: ' + (e && e.message ? e.message : e) } }
  }).catch(e => ({ error: 'request failed: ' + (e && e.message ? e.message : e) }))
}

main().catch(e => { console.error('[CAQ] fatal:', e); process.exit(1) })
