// lib/adp-history.ts
//
// Shape of the payroll download log. Kept out of the route file because a
// Next.js route module may only export handlers and its own config — exporting
// constants from one fails the build (tsc alone does not catch it).

export const ADP_HISTORY_TAB = 'ADP_HISTORY'

export const HISTORY_COLUMNS = [
  'weekEnd', 'weekStart', 'payDate', 'fileName',
  'employees', 'salons', 'paidHours', 'grossPay', 'tips',
  'overtimePay', 'overtimeDelta', 'sixDayDelta', 'sixDaySd3Paid',
  'breakMinutes', 'extraEarnings', 'exceptions', 'forced',
  'downloadedAt', 'downloadedBy',
] as const
