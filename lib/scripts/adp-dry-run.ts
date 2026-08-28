// lib/scripts/adp-dry-run.ts
// ---------------------------------------------------------------------------
// Run the payroll engine WITHOUT deploying anything.
//
// Nothing here touches Google Sheets, the dashboard, or the Office Tools page.
// It reads SD3 (or a CSV you already downloaded), runs the same engine the site
// would, writes the ADP file to a local folder, and prints a reconciliation you
// can hold next to the macro workbook's output.
//
// Use it to parallel-run for a few weeks before anyone relies on it.
//
// ── Modes ──────────────────────────────────────────────────────────────────
//
//   Pull everything live from SD3 (needs SD3_USERNAME / SD3_PASSWORD):
//     npx tsx lib/scripts/adp-dry-run.ts --week 2026-08-21
//
//   Use a Payroll Consolidated CSV you already downloaded (no credentials at
//   all — but 6-day pay and short breaks need punches, so add --punches or
//   accept that they'll be reported as un-evaluated):
//     npx tsx lib/scripts/adp-dry-run.ts --csv ~/Downloads/payroll.csv --week 2026-08-21
//
//   Compare against the file your macro workbook produced for the same week:
//     ... --compare ~/Downloads/EPIBSP34.csv
//
// ── Options ────────────────────────────────────────────────────────────────
//   --week YYYY-MM-DD   week-ending Friday (default: last completed week)
//   --csv PATH          Payroll Consolidated CSV instead of pulling from SD3
//   --punches PATH      punches JSON (as saved by a previous --save run)
//   --detail PATH       SD3 "Payroll Detail Report - Weekly" CSV. BEST source:
//                       gives floor hours per DAY and SD3's own "Six Day" line,
//                       so nothing about SD3's rule has to be inferred.
//   --daily PATH        Employee Performance CSV covering the week, one row per
//                       employee PER DAY. This is the 6-day day-count source and
//                       joins on Pay ID, so no name matching is involved.
//   --compare PATH      an ADP upload CSV to diff this run against
//   --codes k=v,k=v     assign earnings codes for this run, e.g. sixDay=11
//   --out DIR           output folder (default ./payroll-dryrun)
//   --save              also save the raw inputs, so later runs can replay offline
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { config as loadEnv } from 'dotenv'
import { defaultSettings } from '../adp-settings'
import { parseCsv, rowsToObjectsAt } from '../csv'
import { fiscalWeekContaining, lastCompletedFiscalWeek, todayET } from '../fiscal'
import { parsePayrollDetail, type Sd3SixDayRow } from '../adp-payroll-detail'
import {
  buildPayroll,
  toPayConsolRows,
  payDateFor,
  occurrenceInMonth,
  round2,
  type DailyFloorRow,
  type PunchSegment,
} from '../adp-payroll'

loadEnv()

// ── Args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const flag = (name: string) => argv.includes('--' + name)

const weekEnd = arg('week') || lastCompletedFiscalWeek(todayET()).end
const weekStart = fiscalWeekContaining(weekEnd).start
const outDir = arg('out') || './payroll-dryrun'
const csvPath = arg('csv')
const punchPath = arg('punches')
const dailyPath = arg('daily')
const detailPath = arg('detail')
const comparePath = arg('compare')

if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
  console.error(`--week must be YYYY-MM-DD (got "${weekEnd}")`)
  process.exit(1)
}

// Earnings codes for this run. The workbook never assigned one for 6-day pay,
// so without --codes the run reports it as blocking rather than guessing.
const settings = defaultSettings()
for (const pair of (arg('codes') || '').split(',')) {
  const [k, v] = pair.split('=')
  if (k && v !== undefined) settings.codes[k.trim()] = v.trim()
}

const money = (n: number) => '$' + n.toFixed(2)
const pad = (s: string | number, n: number) => String(s).padEnd(n)
const padL = (s: string | number, n: number) => String(s).padStart(n)

/** Add N days to a YYYY-MM-DD string (UTC, so the weekday never shifts). */
function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Read DailyFloorRows out of an SD3 Employee Performance CSV.
 *
 * That report has a 4-line title/filter preamble before the header and a few
 * footnote lines after the data, so rows without a Pay ID are skipped. `date`
 * is taken from the file's own Date column when it has one, otherwise from the
 * caller (SD3's per-day pull produces one file per date, with no date column).
 */
function dailyRowsFromCsv(csvText: string, date?: string): DailyFloorRow[] {
  const rows = parseCsv(csvText)
  // Locate the header line rather than assuming index 4 — a combined export
  // saved by hand may not carry the same preamble.
  let headerIdx = rows.findIndex(r => r.some(c => c.trim() === 'Pay ID'))
  if (headerIdx < 0) headerIdx = 4
  const objects = rowsToObjectsAt(rows, headerIdx)
  const out: DailyFloorRow[] = []
  for (const o of objects) {
    const payId = (o['Pay ID'] || '').trim()
    if (!payId) continue
    const floorHours = parseFloat((o['Floor Hours'] || '').replace(/[$,%]/g, ''))
    if (!Number.isFinite(floorHours) || floorHours <= 0) continue
    const rowDate = (o['Date'] || o['Business Date'] || '').trim() || date || ''
    if (!rowDate) continue
    out.push({
      date: normalizeIso(rowDate),
      payId,
      salonNum: (o['Salon #'] || '').trim(),
      floorHours,
    })
  }
  return out
}

function normalizeIso(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3]
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  return s
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  console.log(`\nPayroll dry run — week ${weekStart} → ${weekEnd}`)
  console.log('='.repeat(74))

  // ── Inputs ──
  let csvText: string
  let punches: PunchSegment[] = []
  let dailyFloor: DailyFloorRow[] = []
  let sd3SixDay: Sd3SixDayRow[] | undefined
  let punchNote = ''

  if (csvPath) {
    csvText = readFileSync(csvPath, 'utf8')
    console.log(`Payroll report : ${csvPath}`)
  } else {
    // Imported lazily so the offline path needs no credentials at all.
    const { authenticate, fetchSalons, fetchPayrollCsv, fetchEmpChkInOut,
            fetchEmployeePerformanceCsv, batchMap } = await import('../sd3')
    if (!process.env.SD3_USERNAME || !process.env.SD3_PASSWORD) {
      console.error(
        '\nSD3_USERNAME / SD3_PASSWORD are not set.\n' +
        'Put them in a local .env, or run offline with --csv <downloaded report>.\n'
      )
      process.exit(1)
    }
    console.log('Payroll report : pulling live from SD3…')
    const session = await authenticate()
    const salons = await fetchSalons(session)
    csvText = await fetchPayrollCsv(session, salons.map(s => s.storeId), weekStart, weekEnd)

    console.log(`Clock punches  : pulling ${salons.length} salons live from SD3…`)
    const perStore = await batchMap(salons, 4, async s => {
      try {
        const segs = await fetchEmpChkInOut(session, s.storeId, weekStart, weekEnd)
        return segs.map(seg => ({
          date: seg.date, salonNum: s.salonNum, fname: seg.fname, lname: seg.lname,
          checkInTime: seg.checkInTime, checkOutTime: seg.checkOutTime,
          hours: seg.hours, breakTime: seg.breakTime,
          asStylist: seg.asStylist, asRecept: seg.asRecept,
          asTraining: seg.asTraining, asAdmin: seg.asAdmin, absent: seg.absent,
        })) as PunchSegment[]
      } catch (e) {
        console.warn(`  ! salon ${s.salonNum}: ${e instanceof Error ? e.message : e}`)
        return [] as PunchSegment[]
      }
    })
    punches = perStore.flat()

    // Per-day floor hours: SD3's employee report, pulled one day at a time so
    // each row is a single date. Keyed by Pay ID, so it joins to payroll exactly.
    console.log('Daily hours    : pulling 7 days live from SD3…')
    const days: string[] = []
    for (let d = weekStart; d <= weekEnd; d = addDaysIso(d, 1)) days.push(d)
    const perDay = await batchMap(days, 3, async (d: string) => {
      try {
        const csv = await fetchEmployeePerformanceCsv(session, salons.map(s => s.storeId), d, d)
        return dailyRowsFromCsv(csv, d)
      } catch (e) {
        console.warn(`  ! ${d}: ${e instanceof Error ? e.message : e}`)
        return [] as DailyFloorRow[]
      }
    })
    dailyFloor = perDay.flat()
  }

  if (punchPath) {
    punches = JSON.parse(readFileSync(punchPath, 'utf8'))
    console.log(`Clock punches  : ${punchPath}`)
  }
  if (detailPath) {
    const parsed = parsePayrollDetail(readFileSync(detailPath, 'utf8'), weekStart)
    dailyFloor = parsed.dailyFloor
    sd3SixDay = parsed.sd3SixDay
    console.log(`Payroll detail : ${detailPath}`)
    console.log(`                 ${parsed.blocks} employee-salon blocks across ` +
      `${parsed.salons.length} salons · ${parsed.dailyFloor.length} employee-days · ` +
      `${parsed.sd3SixDay.length} with an SD3 "Six Day" line`)
    parsed.warnings.forEach(w => console.log(`  ! ${w}`))
  }

  if (dailyPath) {
    // One Employee Performance CSV covering the week, in Detail mode. Each row
    // must carry a date; SD3's per-day pull is one file per day, so a combined
    // export is read here by its "Date" column when present.
    dailyFloor = dailyRowsFromCsv(readFileSync(dailyPath, 'utf8'))
    console.log(`Daily hours    : ${dailyPath} (${dailyFloor.length} employee-days)`)
  }

  if (dailyFloor.length === 0 && punches.length === 0) {
    punchNote =
      '\n  ⚠ No day-level hours. 6-day pay and short breaks CANNOT be evaluated —\n' +
      '    every employee will show as not qualifying. Run without --csv to pull\n' +
      '    everything live, or pass --daily (6-day) and --punches (breaks).'
  } else if (dailyFloor.length === 0) {
    punchNote = '\n  Note: 6-day days counted from CLOCK PUNCHES (matched on name).\n' +
      '    Pass --daily for the exact Payroll ID join.'
  } else if (punches.length === 0) {
    punchNote = '\n  Note: no clock punches, so paid short breaks cannot be evaluated.\n' +
      '    6-day pay is unaffected — it uses the daily hours.'
  }

  if (flag('save')) {
    writeFileSync(join(outDir, `payroll-${weekEnd}.csv`), csvText)
    writeFileSync(join(outDir, `punches-${weekEnd}.json`), JSON.stringify(punches))
    writeFileSync(join(outDir, `daily-${weekEnd}.json`), JSON.stringify(dailyFloor))
    console.log(`Saved raw inputs to ${outDir}/ for offline replay`)
  }

  // ── Run ──
  const rows = toPayConsolRows(rowsToObjectsAt(parseCsv(csvText), 0))
  const result = buildPayroll({ rows, punches, settings, weekStart, weekEnd, dailyFloor, sd3SixDay })

  console.log(`\nRows ${rows.length} · employees ${result.totals.employees} ` +
    `(${result.totals.floaters} across multiple salons) · punch segments ${punches.length}`)
  console.log(`Pay date ${result.payDate} — the ${occurrenceInMonth(result.payDate)}` +
    `${['th','st','nd','rd'][occurrenceInMonth(result.payDate)] || 'th'} paycheck of the month` +
    (result.isBonusWeek ? '  ← BONUS WEEK' : ''))
  if (punchNote) console.log(punchNote)

  // ── Does the punch feed line up with the payroll report? ──
  // The two have no shared id, so they're joined on LAST|FIRST. If that join is
  // weak, 6-day pay silently under-pays — so it gets reported every run.
  const withFloor = result.sixDay.filter(s => s.weekFloorHours > 0)
  const matched = withFloor.filter(s => s.punchFloorHours > 0)
  const bySource = new Map<string, number>()
  for (const s of result.sixDay) bySource.set(s.source, (bySource.get(s.source) || 0) + 1)
  console.log(`\nDay-count source: ` +
    [...bySource].map(([k, v]) => `${k} ${v}`).join(' · ') +
    `   (daily = exact Payroll ID join, punch = name match)`)

  if (withFloor.length > 0) {
    console.log(`Matched        : ${matched.length}/${withFloor.length} employees with floor hours ` +
      `have day-level hours`)
    const unmatched = withFloor.filter(s => s.punchFloorHours === 0)
    if (unmatched.length) {
      console.log('  No day-level hours (6-day pay cannot be evaluated for these):')
      unmatched.slice(0, 15).forEach(s =>
        console.log(`    ${pad(s.employeeName, 30)} ${padL(s.weekFloorHours, 6)} floor hrs`))
      if (unmatched.length > 15) console.log(`    …and ${unmatched.length - 15} more`)
    }
    // Hours agreeing loosely is the second half of the check — a match on name
    // with wildly different hours means the wrong person got joined.
    const drift = matched
      .map(s => ({ n: s.employeeName, d: round2(s.punchFloorHours - s.weekFloorHours), r: s.weekFloorHours }))
      .filter(x => Math.abs(x.d) > 2)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    if (drift.length) {
      console.log(`  Day hours differ from the weekly report by >2h for ${drift.length}:`)
      drift.slice(0, 10).forEach(x =>
        console.log(`    ${pad(x.n, 30)} weekly ${padL(x.r, 6)}  daily ${padL(round2(x.r + x.d), 6)}  (${x.d > 0 ? '+' : ''}${x.d})`))
    }
  }

  // ── Totals ──
  console.log('\nTotals')
  console.log(`  Floor hours        ${padL(result.totals.floorHours, 10)}`)
  console.log(`  Overtime           ${padL(money(result.totals.overtimePay), 10)}`)
  console.log(`  6-day owed         ${padL(money(result.totals.sixDayPay), 10)}   ` +
    `${result.sixDay.filter(s => s.qualifies).length} qualified`)
  console.log(`  6-day SD3 paid     ${padL(money(result.totals.sixDaySd3Paid), 10)}   ` +
    `already inside All Other Incentives`)
  console.log(`  6-day NET change   ${padL(money(result.totals.sixDayDelta), 10)}   ` +
    `what this file moves`)
  console.log(`  Paid short breaks  ${padL(result.totals.breakMinutes + ' min', 10)}   ` +
    `${round2(result.totals.breakPayHours)} hrs added`)
  console.log(`  Bonuses + manual   ${padL(money(result.totals.extraEarnings), 10)}`)

  // ── Per-salon, for holding next to the weekly summary sheet ──
  console.log('\nPer salon (compare with the "Payroll Total" / "Tips" rows in your summary sheet)')
  console.log(`  ${pad('Salon', 8)}${padL('Payroll Total', 15)}${padL('Tips', 12)}` +
    `${padL('Vac', 10)}${padL('Hol', 10)}${padL('OT', 10)}${padL('6-day', 10)}`)
  const bySalon = new Map<string, any>()
  for (const r of rows) {
    const k = r.salonNum
    const cur = bySalon.get(k) || { pay: 0, tips: 0, vac: 0, hol: 0, ot: 0, six: 0 }
    cur.pay += r.subTotalPay + r.productivityIncentive + r.productIncentive +
      r.newReturnIncentive + r.shiftIncentive + r.allOtherIncentives
    cur.tips += r.cashCheckTips + r.chargeTips
    cur.vac += r.vacationHours * r.baseWage
    cur.hol += r.holidayHours * r.baseWage
    cur.ot += r.overtimePay
    bySalon.set(k, cur)
  }
  // 6-day dollars land per salon in proportion to floor hours; recover that split.
  for (const d of result.sixDay) {
    if (!d.qualifies) continue
    const emp = rows.filter(r => r.payId === d.payId)
    const total = emp.reduce((s, r) => s + r.floorHours, 0) || 1
    for (const r of emp) {
      const c = bySalon.get(r.salonNum)
      if (c) c.six += d.amount * (r.floorHours / total)
    }
  }
  const tot = { pay: 0, tips: 0, vac: 0, hol: 0, ot: 0, six: 0 }
  for (const k of [...bySalon.keys()].sort()) {
    const c = bySalon.get(k)
    for (const f of Object.keys(tot) as (keyof typeof tot)[]) tot[f] += c[f]
    console.log(`  ${pad(k, 8)}${padL(money(round2(c.pay)), 15)}${padL(money(round2(c.tips)), 12)}` +
      `${padL(money(round2(c.vac)), 10)}${padL(money(round2(c.hol)), 10)}` +
      `${padL(money(round2(c.ot)), 10)}${padL(money(round2(c.six)), 10)}`)
  }
  console.log(`  ${pad('TOTAL', 8)}${padL(money(round2(tot.pay)), 15)}${padL(money(round2(tot.tips)), 12)}` +
    `${padL(money(round2(tot.vac)), 10)}${padL(money(round2(tot.hol)), 10)}` +
    `${padL(money(round2(tot.ot)), 10)}${padL(money(round2(tot.six)), 10)}`)

  // ── 6-day detail ──
  // The corrections — the rows the office used to find and key by hand.
  const moved = result.sixDay.filter(s => Math.abs(s.delta) >= 0.005)
    .sort((a, b) => a.delta - b.delta)
  if (moved.length) {
    console.log('\n6-day corrections (compare with the "6 Day" rows in your summary sheet)')
    console.log(`  (SD3's side is ${moved[0].sd3Source === 'stated'
      ? 'taken from its own "Six Day" line' : 'MODELLED from its rule — supply --detail to use SD3\'s stated figure'})`)
    console.log(`  ${pad('Employee', 30)}${padL('owed', 10)}${padL('SD3 paid', 11)}${padL('NET', 10)}  why`)
    for (const s of moved) {
      const why = s.delta < 0
        ? `SD3 paid but ${s.reason || 'does not qualify'}`
        : (s.sd3Paid === 0 ? 'qualifies but SD3 paid nothing (floater)' : 'SD3 underpaid')
      console.log(`  ${pad(s.employeeName, 30)}${padL(money(s.amount), 10)}` +
        `${padL(money(s.sd3Paid), 11)}${padL(money(s.delta), 10)}  ${why}`)
    }
  }

  const qualified = result.sixDay.filter(s => s.qualifies)
  if (qualified.length) {
    console.log('\n6-day pay — who qualified')
    for (const s of qualified) {
      console.log(`  ${pad(s.employeeName, 30)} ${s.qualifyingDays} days  ` +
        `${padL(s.weekFloorHours, 6)} floor hrs  → ${padL(money(s.amount), 9)}`)
      console.log(`      ${s.days.map(d => `${d.date.slice(5)}:${d.floorHours}${d.counted ? '' : '*'}`).join('  ')}`)
    }
    console.log('      (* day under the minimum shift length — did not count)')
  }
  // The near-misses are where a rule misunderstanding would show up first.
  const near = result.sixDay
    .filter(s => !s.qualifies && s.qualifyingDays >= 5 && s.weekFloorHours >= 30)
    .sort((a, b) => b.weekFloorHours - a.weekFloorHours)
  if (near.length) {
    console.log('\n6-day pay — near misses (check these against how you paid it by hand)')
    for (const s of near.slice(0, 15)) {
      console.log(`  ${pad(s.employeeName, 30)} ${s.qualifyingDays} days  ` +
        `${padL(s.weekFloorHours, 6)} floor hrs  — ${s.reason}`)
      console.log(`      ${s.days.map(d => `${d.date.slice(5)}:${d.floorHours}${d.counted ? '' : '*'}`).join('  ')}`)
    }
  }

  // ── Breaks ──
  if (result.breaks.length) {
    console.log(`\nPaid short breaks — under ${settings.rules.breakMaxMinutes} minutes`)
    for (const b of result.breaks.slice(0, 20)) {
      console.log(`  ${pad(b.employeeName, 30)} ${padL(b.totalMinutes + ' min', 9)}  ` +
        b.breaks.map(x => `${x.date.slice(5)}:${x.minutes}m@${x.salonNum}`).join('  '))
    }
    if (result.breaks.length > 20) console.log(`  …and ${result.breaks.length - 20} more`)
  }

  // ── Exceptions ──
  const blocking = result.exceptions.filter(e => e.severity === 'blocking')
  const warnings = result.exceptions.filter(e => e.severity !== 'blocking')
  console.log(`\nExceptions — ${blocking.length} blocking, ${warnings.length} to check`)
  for (const e of blocking) console.log(`  BLOCKING  ${e.message}`)
  for (const e of warnings.slice(0, 20)) console.log(`  check     ${e.message}`)
  if (warnings.length > 20) console.log(`  …and ${warnings.length - 20} more`)

  // ── Write the file ──
  const outFile = join(outDir, result.upload.fileName)
  writeFileSync(outFile, result.upload.csv)
  console.log(`\nWrote ${outFile}  (${result.upload.rows.length} rows, ${result.upload.header.length} columns)`)

  // ── Compare against the macro's own output ──
  if (comparePath) compareUploads(result, comparePath)

  console.log('')
}

/**
 * Diff this run against an ADP file the old workbook produced. Rows are keyed by
 * File # + Temp Dept (employee + salon) rather than position, so a difference in
 * row order isn't reported as a difference in pay.
 */
function compareUploads(result: any, path: string) {
  console.log(`\nComparing with ${path}`)
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  if (rows.length < 2) { console.log('  file has no data rows'); return }

  const theirHeader = rows[0].map(h => h.trim())
  const ourHeader = result.upload.header as string[]
  if (theirHeader.length !== ourHeader.length) {
    console.log(`  ! column count differs — theirs ${theirHeader.length}, ours ${ourHeader.length}`)
  }

  const keyOf = (r: string[] | (string | number)[], h: string[]) => {
    const file = String(r[h.indexOf('File #')] ?? '').trim()
    const dept = String(r[h.length - 1] ?? '').trim()
    return `${file}|${dept}`
  }
  const theirs = new Map<string, string[]>()
  for (const r of rows.slice(1)) {
    if (r.every(c => !String(c).trim())) continue
    theirs.set(keyOf(r, theirHeader), r)
  }
  const ours = new Map<string, (string | number)[]>()
  for (const r of result.upload.rows) ours.set(keyOf(r, ourHeader), r)

  const same = (a: any, b: any) => {
    const x = a === '' || a == null ? '' : a
    const y = b === '' || b == null ? '' : b
    if (x === '' && y === '') return true
    const nx = parseFloat(String(x)), ny = parseFloat(String(y))
    if (Number.isFinite(nx) && Number.isFinite(ny)) return Math.abs(nx - ny) < 0.005
    return String(x).trim() === String(y).trim()
  }

  let diffCells = 0, diffRows = 0
  const notes: string[] = []
  for (const [k, our] of ours) {
    const their = theirs.get(k)
    if (!their) { notes.push(`  only in ours:   ${k}`); diffRows++; continue }
    const cells: string[] = []
    for (let c = 0; c < Math.max(our.length, their.length); c++) {
      if (!same(our[c], their[c])) {
        cells.push(`${ourHeader[c] ?? 'col' + (c + 1)}: ours ${JSON.stringify(our[c])} vs theirs ${JSON.stringify(their[c])}`)
        diffCells++
      }
    }
    if (cells.length) notes.push(`  ${k}\n      ` + cells.join('\n      '))
  }
  for (const k of theirs.keys()) if (!ours.has(k)) { notes.push(`  only in theirs: ${k}`); diffRows++ }

  if (!notes.length) {
    console.log(`  IDENTICAL — ${ours.size} rows match cell for cell.`)
  } else {
    console.log(`  ${diffCells} differing cells across ${notes.length} rows ` +
      `(${diffRows} rows present on only one side)`)
    notes.slice(0, 25).forEach(n => console.log(n))
    if (notes.length > 25) console.log(`  …and ${notes.length - 25} more`)
    console.log('\n  Differences are EXPECTED where this tool adds pay the macro never did:\n' +
      '  6-day pay, paid short breaks (folded into Floor Hours), and bonuses.\n' +
      '  Anything else is worth a look.')
  }
}

main().catch(e => { console.error('\n' + (e instanceof Error ? e.stack : String(e))); process.exit(1) })
