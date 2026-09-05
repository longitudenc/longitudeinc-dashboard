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
  // Microsoft will quietly refuse to progress the SSO hand-off for a browser it
  // reads as automated: the page renders, the redirect never fires, and nothing
  // says why -- which is exactly the symptom this script hit. A real user agent
  // and dropping the AutomationControlled flag is the usual remedy.
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  })
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
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

    // Also say what the page SAYS. The screenshots are uploaded as an artifact,
    // but an artifact you have to download and open is a diagnosis you do not
    // have when you are reading a failure email. Microsoft states the real
    // reason in text -- expired password, blocked sign-in, "we couldn't verify
    // this device" -- and one line of it in the log usually settles the matter.
    const seen = await page.evaluate(() => {
      const clean = t => String(t || '').replace(/[ ]+/g, ' ').replace(/[ ]*[ ]+/g, ' ').trim()
      const text = clean(document.body ? document.body.innerText : '').slice(0, 700)
      const controls = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'))
        .map(el => clean(el.innerText || el.value || el.getAttribute('aria-label')))
        .filter(Boolean).slice(0, 10)
      const inputs = Array.from(document.querySelectorAll('input'))
        .map(el => el.type + (el.name ? '[' + el.name + ']' : '')).slice(0, 10)
      return { text, controls, inputs }
    }).catch(() => null)
    if (seen) {
      if (seen.text) log(`  text: ${JSON.stringify(seen.text)}`)
      if (seen.controls.length) log(`  buttons: ${JSON.stringify(seen.controls)}`)
      if (seen.inputs.length) log(`  inputs: ${JSON.stringify(seen.inputs)}`)
    }
  } catch (_) {}
}

async function doLogin(page) {
  // Standard Azure AD (no MFA). Instrumented: screenshots + url/title at each
  // step so a failed run shows exactly where it stalled. Patient timeouts,
  // because the login SPA renders client-side after the OAuth redirect chain.
  const nextSel = '#idSIButton9, input[type="submit"], button[type="submit"]'

  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await shot(page, 'landing')

  // A cached session would have fired a query already — if a token is in hand, we're in.
  if (token) { log('token already captured — already signed in'); return }
  // Otherwise Power BI's singleSignOn hand-off page auto-redirects to the Microsoft
  // login; the email locator below auto-waits across that navigation. Do NOT bail on
  // the app.powerbi.com URL here — the SSO landing page is not the report.

  // "Pick an account" only appears if a session cookie exists (won't in CI, but
  // handle it): choose "Use another account".
  const pick = page.getByText(/use another account/i).first()
  if (await pick.isVisible({ timeout: 4000 }).catch(() => false)) {
    log('pick-an-account -> use another'); await pick.click().catch(() => {}); await page.waitForTimeout(1500)
  }

  // POWER BI'S OWN EMAIL GATE, which comes BEFORE the hand-off to Microsoft.
  //
  //   "Enter your work or school email, we'll check if you need to create a
  //    new account."  [Email]  [Submit]
  //
  // It lives on app.powerbi.com/singleSignOn and its box is input[type=text] --
  // no type=email, no name=loginfmt, no #i0116. The Azure AD selectors below
  // therefore never matched it, and the script sat waiting sixty seconds at a
  // form it could have filled in at once, then reported the missing field it
  // went on to look for rather than the one in front of it.
  if (/app\.powerbi\.com\/singleSignOn/i.test(page.url())) {
    // First try it the ordinary way.
    let filled = false
    const gate = page.locator('input[type="text"], input[type="email"]').first()
    if (await gate.isVisible({ timeout: 15000 }).catch(() => false)) {
      log('Power BI SSO gate - entering email')
      await gate.fill(PBI_USER).catch(() => {})
      filled = true
    }

    // Playwright called it invisible last run even though the page reported
    // inputs: ["text"], so do not take no for an answer. Report what the
    // element actually looks like, then set it through the native value setter
    // and fire input/change -- a React-controlled box ignores a plain
    // assignment, and this page is React.
    if (!filled) {
      const info = await page.evaluate(() => {
        const el = document.querySelector('input[type="text"], input[type="email"]')
        if (!el) return { found: false }
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          found: true, w: Math.round(r.width), h: Math.round(r.height),
          display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
          disabled: el.disabled, type: el.type, id: el.id || '', cls: (el.className || '').slice(0, 60),
        }
      }).catch(() => null)
      log('  gate not "visible" to Playwright; element is: ' + JSON.stringify(info))

      const ok = await page.evaluate((v) => {
        const el = document.querySelector('input[type="text"], input[type="email"]')
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }, PBI_USER).catch(() => false)
      log('  set the email directly: ' + ok)
      filled = ok
    }

    if (filled) {
      // Same treatment for Submit: click it properly if we can, otherwise
      // click the element itself.
      const submit = page.getByRole('button', { name: /^submit$/i }).first()
      if (await submit.isVisible({ timeout: 4000 }).catch(() => false)) {
        await submit.click().catch(() => {})
      } else {
        const clicked = await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button, input[type=submit]'))
            .find(x => /submit/i.test(x.innerText || x.value || ''))
          if (!b) return false
          b.click(); return true
        }).catch(() => false)
        log('  clicked Submit directly: ' + clicked)
      }
      await page.waitForURL(u => !/app\.powerbi\.com\/singleSignOn/i.test(String(u)),
        { timeout: 60000 }).catch(() => {})
      await page.waitForTimeout(2000)
      await shot(page, 'after-sso-gate')
    }
  }

  // Email — submit with Enter (posts the form directly; avoids clicking a hidden
  // or not-yet-enabled submit button).
  const email = page.locator('input[type="email"], input[name="loginfmt"], #i0116').first()
  if (await email.isVisible({ timeout: 60000 }).catch(() => false)) {
    log('entering username:', PBI_USER)
    await email.fill(PBI_USER)
    await email.press('Enter').catch(() => {})
    await page.waitForTimeout(2500)
  } else if (token) {
    log('signed in without an email prompt (token captured)'); return
  } else {
    log('WARNING: email field never appeared'); await shot(page, 'no-email')
    // Still sitting on Power BI's own hand-off page means the bounce to
    // login.microsoftonline.com never happened. That is a different failure
    // from "the login page loaded but the field moved", and worth saying so
    // plainly rather than pressing on to look for a password box.
    if (/app\.powerbi\.com\/singleSignOn/i.test(page.url())) {
      log('DIAGNOSIS: still on the Power BI singleSignOn hand-off.')
      log('  This page carries its own email box (input[type=text]) and a Submit button,')
      log('  handled above. If we are still here, that gate did not accept the address:')
      log('  check the page text logged above, then whether the account is disabled,')
      log('  its password expired, or a conditional-access policy now applies.')
      // A hand-off that stalls sometimes has a button waiting on a click.
      const go = page.getByRole('button', { name: /sign in|continue|next/i }).first()
      if (await go.isVisible({ timeout: 3000 }).catch(() => false)) {
        log('  a sign-in button is present - clicking it'); await go.click().catch(() => {})
        await page.waitForTimeout(4000); await shot(page, 'after-sso-click')
      }
    }
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
