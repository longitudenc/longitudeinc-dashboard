// scripts/test-fiscal.ts
// Sanity checks for fiscal.ts date math.
// Run with: npx tsx lib/scripts/test-fiscal.ts

import {
  todayET,
  yesterdayET,
  addDays,
  dayOfWeek,
  fiscalWeekContaining,
  lastCompletedFiscalWeek,
  lastFridayOfCalendarMonth,
  isLastFridayOfMonth,
  fiscalMonthEndingOn,
  lastCompletedFiscalMonth,
} from '../fiscal'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const fmt = (d: string) => `${d} (${DOW[dayOfWeek(d)]})`

function header(title: string) {
  console.log(`\n--- ${title} ---`)
}

let failures = 0
function assertEq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}`)
    console.log(`      expected: ${JSON.stringify(expected)}`)
    console.log(`      got:      ${JSON.stringify(actual)}`)
    failures++
  }
}

header('Current dates (ET)')
console.log(`  today:     ${fmt(todayET())}`)
console.log(`  yesterday: ${fmt(yesterdayET())}`)

header('Fiscal week — given various dates from our captured week (5/16 Sat → 5/22 Fri)')
assertEq(
  'Sat 5/16 → week (5/16, 5/22)',
  fiscalWeekContaining('2026-05-16'),
  { start: '2026-05-16', end: '2026-05-22' }
)
assertEq(
  'Wed 5/20 → week (5/16, 5/22)',
  fiscalWeekContaining('2026-05-20'),
  { start: '2026-05-16', end: '2026-05-22' }
)
assertEq(
  'Fri 5/22 → week (5/16, 5/22)',
  fiscalWeekContaining('2026-05-22'),
  { start: '2026-05-16', end: '2026-05-22' }
)
assertEq(
  'Sat 5/23 → next week (5/23, 5/29)',
  fiscalWeekContaining('2026-05-23'),
  { start: '2026-05-23', end: '2026-05-29' }
)

header('Last completed fiscal week')
assertEq(
  'Sat 5/23 → just-finished week (5/16, 5/22)',
  lastCompletedFiscalWeek('2026-05-23'),
  { start: '2026-05-16', end: '2026-05-22' }
)
assertEq(
  'Sun 5/24 → (5/16, 5/22)',
  lastCompletedFiscalWeek('2026-05-24'),
  { start: '2026-05-16', end: '2026-05-22' }
)
assertEq(
  'Fri 5/22 → previous completed week (5/9, 5/15)',
  lastCompletedFiscalWeek('2026-05-22'),
  { start: '2026-05-09', end: '2026-05-15' }
)

header('Last Friday of calendar month')
assertEq("May 2026 → 5/29 (Fri)", lastFridayOfCalendarMonth('2026-05-15'), '2026-05-29')
assertEq("April 2026 → 4/24 (Fri)", lastFridayOfCalendarMonth('2026-04-15'), '2026-04-24')
assertEq("June 2026 → 6/26 (Fri)", lastFridayOfCalendarMonth('2026-06-15'), '2026-06-26')

header('isLastFridayOfMonth')
assertEq('5/29/2026 is last Fri of May', isLastFridayOfMonth('2026-05-29'), true)
assertEq('5/22/2026 is NOT last Fri of May', isLastFridayOfMonth('2026-05-22'), false)
assertEq('4/24/2026 is last Fri of April', isLastFridayOfMonth('2026-04-24'), true)

header('Fiscal month ending on 5/29 → (4/25, 5/29)')
assertEq(
  'May fiscal month',
  fiscalMonthEndingOn('2026-05-29'),
  { start: '2026-04-25', end: '2026-05-29' }
)
assertEq(
  'April fiscal month',
  fiscalMonthEndingOn('2026-04-24'),
  { start: '2026-03-28', end: '2026-04-24' }
)
assertEq(
  'June fiscal month',
  fiscalMonthEndingOn('2026-06-26'),
  { start: '2026-05-30', end: '2026-06-26' }
)

header('Last completed fiscal month')
assertEq(
  'as of 5/30 → April fiscal month (3/28, 4/24)... wait no, May ended 5/29',
  lastCompletedFiscalMonth('2026-05-30'),
  { start: '2026-04-25', end: '2026-05-29' }
)
assertEq(
  'as of 5/29 (the day it ended) → April (3/28, 4/24)',
  lastCompletedFiscalMonth('2026-05-29'),
  { start: '2026-03-28', end: '2026-04-24' }
)

console.log(failures === 0 ? '\n=== All tests PASSED ✓ ===' : `\n=== ${failures} test(s) FAILED ✗ ===`)
process.exit(failures === 0 ? 0 : 1)