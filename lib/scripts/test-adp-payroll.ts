// lib/scripts/test-adp-payroll.ts
//
// Proves the TypeScript engine reproduces the Excel program it replaces.
//
// adp-fixture.json holds a real week (ending 2026-08-21, 140 employee rows)
// lifted straight out of "Payroll Import Program v241119Client.xlsm": the
// `Pay Consol` sheet as the input, and the `Pay Upload` sheet the VBA produced
// from it as the expected output.
//
// The overtime the workbook itself computed (CheckOT, for employees split
// across salons) is stripped from the input before the run, so the engine has
// to re-derive it. Single-salon overtime is left alone — SD3 supplies that.
//
//   npx tsx lib/scripts/test-adp-payroll.ts
//
// Exits non-zero on any mismatch.

import { readFileSync } from 'fs'
import { join } from 'path'
import { defaultSettings } from '../adp-settings'
import {
  buildPayroll,
  toPayConsolRows,
  computeSixDay,
  computeShortBreaks,
  isBonusPayWeek,
  payDateFor,
  occurrenceInMonth,
  allocate,
  round2,
  type DailyFloorRow,
  type PunchSegment,
} from '../adp-payroll'

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'adp-fixture.json'), 'utf8')
) as { payConsol: any[][]; payUpload: any[][] }

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

// ── Input: Pay Consol rows → the CSV-object shape the parser expects ──
const header: string[] = fixture.payConsol[0].map((h: any) => String(h ?? '').trim())
const dataRows = fixture.payConsol.slice(1)

const objects = dataRows.map(r => {
  const o: Record<string, string> = {}
  header.forEach((h, i) => { o[h] = r[i] == null ? '' : String(r[i]) })
  return o
})

// Strip the workbook's own cross-salon overtime so the engine re-derives it.
const payIdCounts = new Map<string, number>()
for (const o of objects) {
  const id = o['Payroll ID']
  payIdCounts.set(id, (payIdCounts.get(id) || 0) + 1)
}
let strippedOt = 0
for (const o of objects) {
  if ((payIdCounts.get(o['Payroll ID']) || 0) > 1 && parseFloat(o['Overtime Hours Pay'] || '0') !== 0) {
    o['Overtime Hours Pay'] = '0'
    strippedOt++
  }
}

console.log('\nADP payroll engine — verification against the Excel program')
console.log('='.repeat(62))
console.log(`Input: ${objects.length} payroll rows, week ending 2026-08-21`)
console.log(`Stripped ${strippedOt} workbook-computed floater overtime values\n`)

// ── Run ──
const rows = toPayConsolRows(objects)
const settings = defaultSettings()
const result = buildPayroll({
  rows,
  punches: [],
  settings,
  weekStart: '2026-08-15',
  weekEnd: '2026-08-21',
})

// ── 1) The upload must match the workbook's Pay Upload, cell for cell ──
console.log('Upload file vs. the workbook\'s Pay Upload sheet')

const expectedHeader: string[] = fixture.payUpload[0].map((h: any) => String(h ?? '').trim())
const expectedRows = fixture.payUpload.slice(1)

check(
  `header — ${result.upload.header.length} columns`,
  JSON.stringify(result.upload.header) === JSON.stringify(expectedHeader),
  `got:      ${result.upload.header.join(',')}\n      expected: ${expectedHeader.join(',')}`
)
check(
  `row count — ${result.upload.rows.length}`,
  result.upload.rows.length === expectedRows.length,
  `got ${result.upload.rows.length}, expected ${expectedRows.length}`
)

// Normalize for comparison: the workbook stores blanks as empty cells and
// numbers as numbers, so compare numerically where both sides are numeric.
function cellsMatch(got: any, want: any): boolean {
  const g = got === '' || got == null ? '' : got
  const w = want === '' || want == null ? '' : want
  if (g === '' && w === '') return true
  const gn = typeof g === 'number' ? g : parseFloat(String(g))
  const wn = typeof w === 'number' ? w : parseFloat(String(w))
  if (Number.isFinite(gn) && Number.isFinite(wn)) return Math.abs(gn - wn) < 0.005
  return String(g).trim() === String(w).trim()
}

const mismatches: string[] = []
const n = Math.min(result.upload.rows.length, expectedRows.length)
for (let i = 0; i < n; i++) {
  const got = result.upload.rows[i]
  const want = expectedRows[i]
  const width = Math.max(got.length, want.length)
  for (let c = 0; c < width; c++) {
    if (!cellsMatch(got[c], want[c])) {
      mismatches.push(
        `row ${i + 2} (${rows[i]?.employeeName ?? '?'}) col ${c + 1} ` +
        `"${expectedHeader[c] ?? ''}": got ${JSON.stringify(got[c])}, expected ${JSON.stringify(want[c])}`
      )
    }
  }
}
check(
  `all ${n * expectedHeader.length} cells match`,
  mismatches.length === 0,
  mismatches.slice(0, 12).join('\n      ') +
    (mismatches.length > 12 ? `\n      …and ${mismatches.length - 12} more` : '')
)

check(
  `file name — ${result.upload.fileName}`,
  result.upload.fileName === 'EPIBSP34.csv',
  `got ${result.upload.fileName}`
)

// ── 2) Cross-salon overtime ──
console.log('\nCross-salon overtime (floaters treated as one person)')
const floaters = result.employees.filter(e => e.isFloater)
check(`${floaters.length} floaters detected`, floaters.length === 14)

// Claudia Hernandez: 5.38 + 35.82 = 41.20 hours across salons 3045 and 9489.
// Neither salon alone crosses 40, so SD3 reports no overtime for her at all.
const claudia = result.employees.find(e => e.employeeName.startsWith('HERNANDEZ'))
check(
  'HERNANDEZ, CLAUDIA — overtime found across two salons',
  !!claudia && Math.abs(claudia.overtimePay - 11.44) < 0.02,
  `got $${claudia?.overtimePay}, workbook produced $11.44 (1.49 + 9.95)`
)
const bridgette = result.employees.find(e => e.employeeName.startsWith('STOUT'))
check(
  'STOUT, BRIDGETTE Y — overtime found across two salons',
  !!bridgette && Math.abs(bridgette.overtimePay - 14.5) < 0.02,
  `got $${bridgette?.overtimePay}, workbook produced $14.50 (5.12 + 9.38)`
)
// Single-salon overtime must pass through from SD3 untouched.
const dawn = result.employees.find(e => e.employeeName.startsWith('BOWERSOX'))
check(
  'BOWERSOX, DAWN A — single-salon overtime passes through unchanged',
  !!dawn && Math.abs(dawn.overtimePay - 24.1) < 0.005,
  `got $${dawn?.overtimePay}, expected $24.10`
)

// ── 3) Exceptions (the workbook's CheckPay) ──
console.log('\nException report')
const kinds = new Map<string, number>()
for (const e of result.exceptions) kinds.set(e.kind, (kinds.get(e.kind) || 0) + 1)
check(
  `${result.exceptions.length} exceptions raised: ${[...kinds].map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`,
  true
)
check(
  'no blocking exceptions on a clean week',
  result.exceptions.filter(e => e.severity === 'blocking').length === 0,
  result.exceptions.filter(e => e.severity === 'blocking').map(e => e.message).join('\n      ')
)
check(
  'every floater flagged for review',
  result.exceptions.filter(e => e.kind === 'multi-salon' || e.kind === 'multi-salon-wage').length === 14
)

// ── 4) 6-day pay ──
console.log('\n6-day pay')
// CHING SIONG CHONG NEWMAN is a real floater in this week: 5.09 floor hours at
// salon 3043 and 33.50 at 3062, so neither salon alone reaches the 34-hour
// threshold and only the merged person qualifies.
const empRows = rows.filter(r => r.employeeName.startsWith('CHONG NEWMAN'))
const empFloor = round2(empRows.reduce((s, r) => s + r.floorHours, 0))
check(`fixture floater has ${empFloor} floor hours across ${empRows.length} salons`, empFloor === 38.59 && empRows.length === 2)

const mk = (date: string, salonNum: string, hours: number, breakTime = 0): PunchSegment => ({
  date, salonNum, fname: 'Ching Siong', lname: 'Chong Newman',
  checkInTime: `${date}T09:00:00`, checkOutTime: `${date}T17:00:00`,
  hours, breakTime, asStylist: true, asRecept: false, asTraining: false,
  asAdmin: false, absent: false,
})
// Six days on the floor, split across both salons, every one of them 4+ hours.
const punches: PunchSegment[] = [
  mk('2026-08-15', '3062', 6.5), mk('2026-08-16', '3062', 6),
  mk('2026-08-17', '3043', 5.09), mk('2026-08-18', '3062', 7),
  mk('2026-08-19', '3062', 7), mk('2026-08-20', '3062', 7),
]

const sixDay = computeSixDay(empRows, punches, settings)
const emp = sixDay.details.find(d => d.employeeName.startsWith('CHONG NEWMAN'))
check(
  'qualifies with 6 days across two salons, all 4+ hours, 34+ floor hours',
  !!emp && emp.qualifies && emp.qualifyingDays === 6,
  `qualifies=${emp?.qualifies} days=${emp?.qualifyingDays} reason="${emp?.reason}"`
)
check(
  `pays $1 x the week's floor hours = $${emp?.amount}`,
  !!emp && Math.abs(emp.amount - empFloor) < 0.005
)

// Neither salon reaches 34 on its own — the bonus exists only because floaters
// are merged. This is the case the old process had to catch by hand.
const perSalon = empRows.map(r => computeSixDay([r], punches, settings).details[0])
check(
  'neither salon would qualify on its own',
  perSalon.every(d => !d.qualifies),
  perSalon.map(d => `${d.weekFloorHours}h → ${d.qualifies}`).join(', ')
)

// A 3.5-hour day is under the minimum shift length, so only 5 days count.
const shortDay = punches.map((p, i) => (i === 5 ? { ...p, hours: 3.5 } : p))
const sd2 = computeSixDay(empRows, shortDay, settings).details[0]
check(
  'a sub-4-hour day does not count toward the 6',
  !sd2.qualifies && sd2.qualifyingDays === 5,
  `qualifies=${sd2.qualifies} days=${sd2.qualifyingDays} reason="${sd2.reason}"`
)

// Six qualifying days but only 30 floor hours on the report → no bonus.
const thinRows = empRows.map(r => ({ ...r, floorHours: 15 }))
const sd3 = computeSixDay(thinRows, punches, settings).details[0]
check(
  'under 34 floor hours does not qualify even with 6 days',
  !sd3.qualifies && sd3.reason.includes('34'),
  `qualifies=${sd3.qualifies} reason="${sd3.reason}"`
)

// Non-floor time (training, reception, admin) is not floor time.
const adminOnly = punches.map(p => ({ ...p, asStylist: false, asAdmin: true }))
const sd4 = computeSixDay(empRows, adminOnly, settings).details[0]
check(
  'admin/training/reception days do not count as floor days',
  !sd4.qualifies && sd4.qualifyingDays === 0
)

// The dollars follow the hours back to each salon, to the cent.
const sixDayBuild = buildPayroll({
  rows: toPayConsolRows(objects).filter(r => r.employeeName.startsWith('CHONG NEWMAN')),
  punches,
  settings: { ...settings, codes: { ...settings.codes, sixDay: '11' } },
  weekStart: '2026-08-15',
  weekEnd: '2026-08-21',
})
const sixDayLines = sixDayBuild.employees[0].extraEarnings.filter(e => e.label === '6-day pay')
check(
  'the bonus is split across both salons in proportion to floor hours',
  sixDayLines.length === 2 &&
    Math.abs(sixDayLines.reduce((s, e) => s + e.amount, 0) - empFloor) < 0.005,
  JSON.stringify(sixDayLines)
)

// With no code assigned it must block, never quietly drop the pay.
const noCode = buildPayroll({
  rows: toPayConsolRows(objects).filter(r => r.employeeName.startsWith('CHONG NEWMAN')),
  punches, settings, weekStart: '2026-08-15', weekEnd: '2026-08-21',
})
check(
  'unassigned earnings code blocks rather than dropping the pay',
  noCode.exceptions.some(e => e.severity === 'blocking' && e.kind === 'missing-code')
)

// The DAILY feed is the preferred day-count source: it carries Payroll ID, so
// it joins to the payroll report exactly instead of matching on name.
const dailyDays = ['2026-08-15','2026-08-16','2026-08-17','2026-08-18','2026-08-19','2026-08-20']
const daily: DailyFloorRow[] = dailyDays.map((date, i) => ({
  date, payId: empRows[0].payId,
  salonNum: i === 2 ? '3043' : '3062',
  floorHours: i === 2 ? 5.09 : 6.7,
}))
const viaDaily = computeSixDay(empRows, [], settings, daily).details[0]
check(
  'daily feed alone qualifies the same person (no punches, no name match)',
  viaDaily.qualifies && viaDaily.qualifyingDays === 6 && viaDaily.source === 'daily',
  `qualifies=${viaDaily.qualifies} days=${viaDaily.qualifyingDays} source=${viaDaily.source}`
)
// A payroll report name the punch feed spells differently would break a name
// join; the Payroll ID join is unaffected.
const renamed = empRows.map(r => ({ ...r, employeeName: 'NEWMAN-CHONG, C SIONG' }))
const viaDailyRenamed = computeSixDay(renamed, punches, settings, daily).details[0]
check(
  'daily feed still matches when the name would not',
  viaDailyRenamed.qualifies && viaDailyRenamed.source === 'daily',
  `qualifies=${viaDailyRenamed.qualifies} source=${viaDailyRenamed.source}`
)
check(
  'punches are used when the daily feed has nothing',
  computeSixDay(empRows, punches, settings, []).details[0].source === 'punch'
)
check(
  'daily feed wins over punches when both are present',
  computeSixDay(empRows, punches, settings, daily).details[0].source === 'daily'
)
check(
  'neither feed → reported, not silently unqualified',
  (() => {
    const d = computeSixDay(empRows, [], settings, []).details[0]
    return d.source === 'none' && !d.qualifies && d.reason.includes('no day-level hours')
  })()
)

// ── 5) Short breaks ──
console.log('\nShort breaks')
const breakPunches: PunchSegment[] = [
  { ...mk('2026-08-15', '3062', 4, 15) },   // paid — under 20
  { ...mk('2026-08-15', '3062', 4, 30) },   // unpaid — 30 minutes
  { ...mk('2026-08-16', '3043', 4, 19.9) }, // paid — just under
  { ...mk('2026-08-17', '3043', 4, 20) },   // unpaid — exactly 20 is not "under"
  { ...mk('2026-08-18', '3062', 4, 0) },    // no break
]
const brk = computeShortBreaks(empRows, breakPunches, settings)[0]
check(
  'only breaks under 20 minutes are paid',
  !!brk && Math.abs(brk.totalMinutes - 34.9) < 0.005,
  `got ${brk?.totalMinutes} minutes, expected 34.9 (15 + 19.9)`
)
check(
  'a 20-minute break is excluded',
  !!brk && brk.breaks.every(b => b.minutes < 20)
)
check(
  'minutes are attributed to the salon the break happened at',
  !!brk && Math.abs((brk.bySalon['3062'] || 0) - 15) < 0.005 &&
    Math.abs((brk.bySalon['3043'] || 0) - 19.9) < 0.005,
  JSON.stringify(brk?.bySalon)
)

// Folded into Floor Hours, the minutes reach ADP at the employee's base rate,
// on the row for the salon where the break was taken.
const withBreaks = buildPayroll({
  rows: toPayConsolRows(objects).filter(r => r.employeeName.startsWith('CHONG NEWMAN')),
  punches: breakPunches,
  settings,
  weekStart: '2026-08-15',
  weekEnd: '2026-08-21',
})
const floorCol = withBreaks.upload.header.indexOf('Hours 4 Amount')
const floorTotal = round2(
  withBreaks.upload.rows.reduce((s, r) => s + Number(r[floorCol] || 0), 0)
)
check(
  'paid break minutes are added to Floor Hours',
  Math.abs(floorTotal - round2(empFloor + 34.9 / 60)) < 0.005,
  `got ${floorTotal}, expected ${round2(empFloor + 34.9 / 60)}`
)

// ── 6) Pay date / bonus week ──
console.log('\nPay date and bonus week (pay day is every Thursday)')
check(
  'week ending Fri 2026-08-21 pays Thu 2026-08-27',
  payDateFor('2026-08-21', 6) === '2026-08-27',
  payDateFor('2026-08-21', 6)
)
check(
  '2026-08-27 is the 4th Thursday of August',
  occurrenceInMonth('2026-08-27') === 4,
  String(occurrenceInMonth('2026-08-27'))
)
// August 2026 Thursdays: 6th, 13th, 20th, 27th → the 3rd paycheck is the 20th,
// which pays the week ending Friday 2026-08-14.
check(
  'week ending 2026-08-14 IS the 3rd paycheck of August',
  isBonusPayWeek('2026-08-14', 6, 3),
  `pay date ${payDateFor('2026-08-14', 6)}, occurrence ${occurrenceInMonth(payDateFor('2026-08-14', 6))}`
)
check(
  'week ending 2026-08-21 is NOT the 3rd paycheck',
  !isBonusPayWeek('2026-08-21', 6, 3)
)
// A month whose 1st falls on a Thursday still resolves the 3rd correctly.
check(
  'October 2026 — 3rd Thursday is the 15th',
  isBonusPayWeek('2026-10-09', 6, 3) && payDateFor('2026-10-09', 6) === '2026-10-15',
  payDateFor('2026-10-09', 6)
)
check(
  'exactly one bonus week per month (Aug–Dec 2026)',
  (() => {
    const perMonth = new Map<string, number>()
    let d = '2026-08-01'
    for (let i = 0; i < 160; i++) {
      // every Friday week-ending in the span
      const dt = new Date(d + 'T00:00:00Z')
      if (dt.getUTCDay() === 5 && isBonusPayWeek(d, 6, 3)) {
        const m = payDateFor(d, 6).slice(0, 7)
        perMonth.set(m, (perMonth.get(m) || 0) + 1)
      }
      dt.setUTCDate(dt.getUTCDate() + 1)
      d = dt.toISOString().slice(0, 10)
    }
    return [...perMonth.values()].every(v => v === 1) && perMonth.size >= 4
  })()
)

// ── 7) Allocation never loses or invents a cent ──
console.log('\nAllocation')
check('allocate splits exactly', allocate(11.44, [5.38, 35.82]).reduce((a, b) => a + b, 0) === 11.44)
check(
  'allocate handles a third that would otherwise drift',
  allocate(10, [1, 1, 1]).reduce((a, b) => a + b, 0) === 10,
  JSON.stringify(allocate(10, [1, 1, 1]))
)
check('allocate keeps money when all weights are zero', allocate(25, [0, 0])[0] === 25)

// ── Result ──
console.log('\n' + '='.repeat(62))
if (failures === 0) {
  console.log('All checks passed — the engine reproduces the Excel program.\n')
} else {
  console.log(`${failures} check(s) FAILED\n`)
  process.exit(1)
}
