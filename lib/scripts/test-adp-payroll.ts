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
import { parsePayrollDetail, parsePayrollWeekResult } from '../adp-payroll-detail'
import {
  buildPayroll,
  toPayConsolRows,
  computeSixDay,
  computeShortBreaks,
  isBonusPayWeek,
  payDateFor,
  occurrenceInMonth,
  allocate,
  applyFloaterOvertime,
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

// SD3 evaluates a person in STORE ISOLATION, for overtime as well as 6-day.
// The hard case: SD3 already paid overtime at one salon, and the person ALSO
// worked a second salon — so the premium it paid is on too few hours, at that
// salon's rate alone. The whole week has to be recomputed, not topped up.
{
  // Incentives feed the blended rate, so zero them here to isolate the overtime
  // arithmetic — a flat $25/hr across both salons.
  const base = {
    ...rows.find(r => r.employeeName.startsWith('BOWERSOX'))!,
    productivityIncentive: 0, productIncentive: 0, newReturnIncentive: 0,
    shiftIncentive: 0, allOtherIncentives: 0,
  }
  const across = [
    // 42 hours at one salon: SD3 sees overtime here and pays a premium.
    { ...base, salonNum: '3071', totalHoursWorked: 42, floorHours: 42,
      totalHoursPay: 42 * 25, overtimePay: 25, sourceRow: 1 },
    // 6 more at another salon: SD3 sees 6 hours and no overtime at all.
    { ...base, salonNum: '1304', totalHoursWorked: 6, floorHours: 6,
      totalHoursPay: 6 * 25, overtimePay: 0, sourceRow: 2 },
  ]
  applyFloaterOvertime(across, 40)
  const paid = round2(across.reduce((s, r) => s + r.overtimePay, 0))
  // 48 hours worked → 8 over 40. Blended rate $25 → premium 8 × 25 / 2 = $100.
  check(
    'overtime across salons is recomputed on the whole week, not topped up',
    Math.abs(paid - 100) < 0.005,
    `got $${paid}, expected $100.00 (8 OT hours × $25 blended ÷ 2)`
  )
  check(
    "SD3's single-salon premium is replaced, not added to",
    across[0].overtimePay < 100 && paid === 100,
    `salon shares: ${across.map(r => `${r.salonNum}=${r.overtimePay}`).join(', ')}`
  )
  check(
    'the premium is split across both salons by hours worked',
    Math.abs(across[0].overtimePay - 87.5) < 0.02 && Math.abs(across[1].overtimePay - 12.5) < 0.02,
    across.map(r => `${r.salonNum}=${r.overtimePay}`).join(', ')
  )
}

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

// In 'add' mode (SD3 treated as paying nothing) the amount goes on its own
// earnings code, and the dollars follow the hours back to each salon.
const addSettings = { ...settings, rules: { ...settings.rules, sixDayMode: 'add' as const } }
const sixDayBuild = buildPayroll({
  rows: toPayConsolRows(objects).filter(r => r.employeeName.startsWith('CHONG NEWMAN')),
  punches,
  settings: { ...addSettings, codes: { ...settings.codes, sixDay: '11' } },
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

// In 'add' mode the pay needs a code, and an unassigned one must block rather
// than quietly drop it. ('net' mode needs no code — it moves All Other Incentives.)
const noCode = buildPayroll({
  rows: toPayConsolRows(objects).filter(r => r.employeeName.startsWith('CHONG NEWMAN')),
  punches, settings: addSettings, weekStart: '2026-08-15', weekEnd: '2026-08-21',
})
check(
  'add mode: unassigned earnings code blocks rather than dropping the pay',
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

// ── 4b) Netting against what SD3 already paid ────────────────────────────
// SD3 pays 6-day itself, inside All Other Incentives, on a looser rule: per
// salon, no minimum shift length, threshold on TOTAL hours. The office then
// corrects it by hand. For w/e 2026-08-21 the Weekly Payroll Summary recorded:
//     -32.80 (1304)  -30.79 (3027)  -35.90 (3043)  -35.62 (3045)   and  +38.59
// This reproduces those exact figures from the payroll report alone.
console.log('\nNetting against SD3 (reproducing the hand corrections for this week)')

/** Build day rows for one employee-salon: `n` days of `hours` floor time each. */
const dayRows = (payId: string, salonNum: string, hours: number[], from = '2026-08-15'): DailyFloorRow[] =>
  hours.map((h, i) => ({
    date: addDaysIso(from, i), payId, salonNum, floorHours: h,
  }))
function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const findRow = (name: string) => rows.find(r => r.employeeName.startsWith(name))!

// Six days, every one over 4 hours — so only the 34-FLOOR-HOUR test can fail.
const sixEven = (total: number) => Array(6).fill(round2(total / 6))
// Six days with a short one — fails OUR rule on shift length, not on hours.
const sixWithShort = (total: number) =>
  [round2((total - 2) / 5), round2((total - 2) / 5), round2((total - 2) / 5),
   round2((total - 2) / 5), round2(total - 2 - 4 * round2((total - 2) / 5)), 2]

const netCases: DailyFloorRow[] = [
  // Under 34 FLOOR hours, but over 34 TOTAL hours → SD3 paid, we should not.
  ...dayRows(findRow('MOORE, ALISHA').payId, '1304', sixEven(32.80)),
  ...dayRows(findRow('MORGAN, JAMIE').payId, '3027', sixEven(30.79)),
  // Over 34 floor hours but a day under the minimum shift → SD3 paid, we should not.
  ...dayRows(findRow('TOMBERLIN').payId, '3043', sixWithShort(35.90)),
  ...dayRows(findRow('LATTIMORE').payId, '3045', sixWithShort(35.62)),
  // A floater: 6 qualifying days across two salons, neither salon enough alone.
  ...dayRows(findRow('CHONG NEWMAN').payId, '3043', [5.09]),
  ...dayRows(findRow('CHONG NEWMAN').payId, '3062', [6.7, 6.7, 6.7, 6.7, 6.7], '2026-08-16'),
  // Genuinely qualifies — SD3 paid exactly the right amount, so nothing moves.
  ...dayRows(findRow('BLAKENEY').payId, '9689', sixEven(37.97)),
]

const netted = buildPayroll({
  rows: toPayConsolRows(objects),
  punches: [], settings, weekStart: '2026-08-15', weekEnd: '2026-08-21',
  dailyFloor: netCases,
})
const six = (name: string) => netted.sixDay.find(d => d.employeeName.startsWith(name))!

for (const [name, expected] of [
  ['MOORE, ALISHA', -32.80], ['MORGAN, JAMIE', -30.79],
  ['TOMBERLIN', -35.90], ['LATTIMORE', -35.62],
  ['CHONG NEWMAN', 38.59], ['BLAKENEY', 0],
] as [string, number][]) {
  const d = six(name)
  check(
    `${name.padEnd(14)} delta ${expected >= 0 ? '+' : ''}${expected.toFixed(2)}`,
    Math.abs(d.delta - expected) < 0.005,
    `got ${d.delta} (owed ${d.amount}, SD3 paid ${d.sd3Paid}, qualifies=${d.qualifies}, reason="${d.reason}")`
  )
}

// The correction has to land in the file, not just the report.
const aoCol = (payId: string, salon: string) => {
  const i = netted.upload.header.indexOf('Temp Dept')
  const row = netted.upload.rows.find(r => String(r[2]) === payId && String(r[i]) === salon + '00')!
  // All Other Incentives is the 13th of the 15 fixed pairs → amount at 4 + 13*2
  return Number(row[4 + 13 * 2 - 1] || 0)
}
check(
  'MOORE: All Other Incentives 45.02 → 12.22 (SD3 6-day removed, other incentives kept)',
  Math.abs(aoCol(findRow('MOORE, ALISHA').payId, '1304') - 12.22) < 0.005,
  `got ${aoCol(findRow('MOORE, ALISHA').payId, '1304')}`
)
check(
  'TOMBERLIN: All Other Incentives 35.90 → 0 (it was 6-day and nothing else)',
  Math.abs(aoCol(findRow('TOMBERLIN').payId, '3043')) < 0.005,
  `got ${aoCol(findRow('TOMBERLIN').payId, '3043')}`
)
check(
  'BLAKENEY: All Other Incentives unchanged at 37.97 (SD3 got it right)',
  Math.abs(aoCol(findRow('BLAKENEY').payId, '9689') - 37.97) < 0.005,
  `got ${aoCol(findRow('BLAKENEY').payId, '9689')}`
)
check(
  'CHONG NEWMAN: the floater gains 38.59 across his two salons',
  Math.abs(
    (aoCol(findRow('CHONG NEWMAN').payId, '3043') + aoCol(findRow('CHONG NEWMAN').payId, '3062')) -
    (15.27 + 38.59)
  ) < 0.02,
  `got ${aoCol(findRow('CHONG NEWMAN').payId, '3043')} + ${aoCol(findRow('CHONG NEWMAN').payId, '3062')}`
)
check(
  'netting needs no new earnings code — nothing blocks',
  netted.exceptions.filter(e => e.kind === 'missing-code').length === 0
)
check(
  `week nets ${netted.totals.sixDayDelta >= 0 ? '+' : ''}$${netted.totals.sixDayDelta.toFixed(2)}`,
  Math.abs(netted.totals.sixDayDelta - (-32.80 - 30.79 - 35.90 - 35.62 + 38.59)) < 0.02,
  `got ${netted.totals.sixDayDelta}`
)

// ── 4b2) The detail-report parser ─────────────────────────────────────────
console.log('\nPayroll Detail report parser')
{
  const mini = [
    '"Payroll Detail Report - Weekly","Hilltop Plaza #1304","Saturday, 8/15/2026 - Friday, 8/21/2026"',
    '"SMITH, ANN","Position:","Hire Date:","Global EE ID:","Base Wage:","Pay ID:"',
    ',"Stylist","4/13/2017","2016-0000-8686","14.41","0742"',
    '',
    '"DETAIL","SAT","SUN","MON","TUE","WED","THU","FRI","Weekly #\'s",,"Weekly #s","Computer Pay"',
    '"Floor Hrs","5.00","0","4.50","6.00","0","6.25","4.75","26.50","Floor","26.50","400.00"',
    '"Six Day","5.00","0","4.50","6.00","0","6.25","4.75","26.50","Six Day","1.00/hr","26.50"',
    '"Charge Tips","0","0","0","0","0","0","0","0","Total Tips","","0"',
    '',
    // The trap: the salon-totals section reuses "Floor Hrs" with a WEEK total in
    // the first column. Absorbing it gave one employee 190 hours in a day.
    '"SALON TOTALS","Hours","","Pay","","Bonus/Incentives","","Tips"',
    '"Floor Hrs","190.77","Floor Pay","3011.14","Productivity Bonus","339.48","Cash/Check Tips","0.00"',
    '"Closing Hrs","0.16","Closing Pay","2.45","Six Day Bonus","26.50","",""',
    '"TOTALS*","195.26","","3096.36","","496.72","","1945.00"',
  ].join('\n')

  const parsed = parsePayrollDetail(mini, '2026-08-15')
  check('one employee block, one salon', parsed.blocks === 1 && parsed.salons.join() === '1304')
  check(
    'five working days parsed, zero-hour days skipped',
    parsed.dailyFloor.length === 5,
    JSON.stringify(parsed.dailyFloor)
  )
  check(
    'SAT maps to the week-start date, FRI to the week end',
    parsed.dailyFloor[0].date === '2026-08-15' &&
      parsed.dailyFloor[parsed.dailyFloor.length - 1].date === '2026-08-21'
  )
  check(
    'Pay ID loses its leading zero, matching the payroll report',
    parsed.dailyFloor.every(d => d.payId === '742')
  )
  check('SD3\'s Six Day figure read from the week-total column', 
    parsed.sd3SixDay.length === 1 && parsed.sd3SixDay[0].amount === 26.50,
    JSON.stringify(parsed.sd3SixDay))
  check(
    'the SALON TOTALS section is not absorbed into the employee',
    parsed.dailyFloor.every(d => d.floorHours < 20),
    `max day = ${Math.max(...parsed.dailyFloor.map(d => d.floorHours))}`
  )
}

// ── 4b3) The payrollweekresult feed ───────────────────────────────────────
// The same figures as the Detail report but as DATA, so no weekly download.
// Fixture is real records from SD3 for salon 1304, week ending 2026-08-21.
console.log('\npayrollweekresult feed (SD3 line items)')
{
  const wr = JSON.parse(readFileSync(join(__dirname, 'adp-weekresult-fixture.json'), 'utf8'))
  // employeepk → Payroll ID. In production this comes from EmployeeProfile.
  const pkMap = { '858423': '7784', '1205208': '2812' }
  const parsed = parsePayrollWeekResult(wr, '1304', '2026-08-15', pkMap)

  check(
    "SIX DAY BONUS is read straight off line 8 — Moore's $32.80",
    parsed.sd3SixDay.length === 1 &&
      parsed.sd3SixDay[0].payId === '2812' &&
      parsed.sd3SixDay[0].amount === 32.8,
    JSON.stringify(parsed.sd3SixDay)
  )
  check(
    'FLOOR HRS line gives the per-day hours; Moore worked 5 floor days',
    parsed.dailyFloor.filter(d => d.payId === '2812').length === 5,
    JSON.stringify(parsed.dailyFloor.filter(d => d.payId === '2812').map(d => d.floorHours))
  )
  check(
    'ADMIN HRS and Bank Incentive lines are ignored, not counted as floor time',
    parsed.dailyFloor.every(d => d.floorHours !== 2.32 && d.floorHours !== 12.22)
  )
  check(
    'the second employee is parsed too, keyed by their own Payroll ID',
    parsed.dailyFloor.filter(d => d.payId === '7784').length === 4
  )
  // Anyone without a Payroll ID mapping must be reported, never dropped quietly.
  const noMap = parsePayrollWeekResult(wr, '1304', '2026-08-15', { '858423': '7784' })
  check(
    'an unmapped employeepk is reported rather than silently skipped',
    noMap.unmappedEmployeePks.includes('1205208') &&
      noMap.warnings.some(w => w.includes('no Payroll ID mapping')),
    JSON.stringify(noMap.warnings)
  )
  check(
    'both sources agree — the feed reproduces the Detail report for Moore',
    parsed.sd3SixDay[0].amount ===
      (JSON.parse(readFileSync(join(__dirname, 'adp-detail-fixture.json'), 'utf8'))
        .sd3SixDay.find((x: any) => x.payId === '2812')?.amount)
  )
}

// ── 4c) The real week, end to end ─────────────────────────────────────────
// adp-detail-fixture.json is the REAL SD3 "Payroll Detail Report - Weekly" for
// w/e 2026-08-21, reduced to what the engine reads: floor hours per employee
// per salon per DAY, and SD3's own "Six Day" figures. Run against the real
// payroll report it must reproduce the corrections the office made by hand.
console.log('\nReal week, end to end (SD3 Payroll Detail + Payroll Consolidated)')

const detailFx = JSON.parse(
  readFileSync(join(__dirname, 'adp-detail-fixture.json'), 'utf8')
) as { dailyFloor: DailyFloorRow[]; sd3SixDay: { payId: string; salonNum: string; amount: number }[]
       blocks: number; salons: string[] }

check(
  `detail report covers ${detailFx.blocks} employee-salon blocks across ${detailFx.salons.length} salons`,
  detailFx.blocks === 140 && detailFx.salons.length === 18
)
check(
  `SD3 states its own Six Day figure for ${detailFx.sd3SixDay.length} people`,
  detailFx.sd3SixDay.length === 18
)

const real = buildPayroll({
  rows: toPayConsolRows(objects),
  punches: [], settings, weekStart: '2026-08-15', weekEnd: '2026-08-21',
  dailyFloor: detailFx.dailyFloor,
  sd3SixDay: detailFx.sd3SixDay,
})
const realSix = (name: string) => real.sixDay.find(d => d.employeeName.startsWith(name))!

check(
  'SD3\'s side is taken from its stated figure, not modelled',
  real.sixDay.every(d => d.sd3Source === 'stated')
)
check(
  'every employee with floor hours got day-level hours from the detail report',
  real.sixDay.filter(d => d.weekFloorHours > 0).every(d => d.source === 'daily'),
  real.sixDay.filter(d => d.weekFloorHours > 0 && d.source !== 'daily')
    .map(d => `${d.employeeName} (${d.source})`).join(', ')
)

// The five corrections recorded in the Weekly Payroll Summary for this week.
for (const [name, expected, why] of [
  ['MOORE, ALISHA', -32.80, 'worked 5 days'],
  ['MORGAN, JAMIE', -30.79, 'worked 5 days'],
  ['TOMBERLIN', -35.90, 'worked 5 days'],
  ['LATTIMORE', -35.62, 'a day under 4 hours'],
  ['CHONG NEWMAN', 38.59, 'floater SD3 paid nothing'],
] as [string, number, string][]) {
  const d = realSix(name)
  check(
    `${name.padEnd(14)} ${expected >= 0 ? '+' : ''}${expected.toFixed(2)} — ${why}`,
    Math.abs(d.delta - expected) < 0.005,
    `got ${d.delta} (owed ${d.amount}, SD3 ${d.sd3Paid}, ${d.qualifyingDays} qualifying days, "${d.reason}")`
  )
}

// Everyone SD3 got right must be left completely alone.
for (const name of ['BLAKENEY', 'BURNETT', 'WYNN', 'ORTIZ', 'SLIGH', 'STATON', 'WALKER', 'DART', 'MELTON', 'GORDON', 'LONG', 'MORALES']) {
  const d = realSix(name)
  check(`${name.padEnd(14)} untouched — SD3 paid exactly what's owed`, Math.abs(d.delta) < 0.005,
    `got ${d.delta} (owed ${d.amount}, SD3 ${d.sd3Paid})`)
}

// Two the office did NOT catch — real money, found by running the rule properly.
// No rounding, no tolerance: 33.95 floor hours is under 34 and does not
// qualify, however close it lands. Confirmed by the owner.
check(
  '33.95 floor hours does NOT qualify — the threshold is not rounded to',
  !realSix('BROOM').qualifies && realSix('BROOM').weekFloorHours === 33.95
)
check(
  '33.99 still does not qualify; 34.00 exactly does',
  (() => {
    const at = (fh: number) => {
      const one = toPayConsolRows(objects)
        .filter(r => r.employeeName.startsWith('BROOM'))
        .map(r => ({ ...r, floorHours: fh }))
      return computeSixDay(one, [], settings,
        detailFx.dailyFloor.filter(d => d.payId === realSix('BROOM').payId)
          .map(d => ({ ...d, floorHours: fh / 6 })), []).details[0].qualifies
    }
    return at(33.99) === false && at(34.00) === true
  })()
)
check(
  'BROOM, SABRINA  -33.95 — 33.95 floor hours, 0.05 under the threshold',
  Math.abs(realSix('BROOM').delta - -33.95) < 0.005,
  `got ${realSix('BROOM').delta}`
)
check(
  'HERNANDEZ       +5.34 — floater owed on 39.67 merged hours, SD3 paid 34.33',
  Math.abs(realSix('HERNANDEZ').delta - 5.34) < 0.005,
  `got ${realSix('HERNANDEZ').delta}`
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
