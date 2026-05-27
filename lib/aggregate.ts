// lib/aggregate.ts
// Convert SD3 raw fields → dashboard schema.
//
// Every formula here has been verified against the live SD3 Salon Summary Report
// for Arboretum 5/16-5/22 (see session memory for full cross-check).
//
// Two sources of input:
//   - `SD3GroupedSummary` (pre-aggregated by SD3 over a date range)
//   - `SD3DailyStoreSummary[]` (raw daily rows for the same range)
//
// The grouped record gives us most metrics directly. Daily rows are needed only
// for Sat/Sun-specific splits and for storing per-day granularity in SD_DAILY.

import type { SD3GroupedSummary, SD3DailyStoreSummary } from './sd3'
import { dayOfWeek } from './fiscal'

// ── Output schema ─────────────────────────────────────────────

/**
 * One aggregated period (week or month) of metrics for a salon.
 * Matches the dashboard's existing schema.
 */
export interface AggregatedPeriod {
  storeId: number
  /** Period start (YYYY-MM-DD) — Saturday of fiscal week, or first day of fiscal month */
  startDate: string
  /** Period end (YYYY-MM-DD) — Friday of fiscal week, or last day of fiscal month */
  endDate: string

  // Raw counts / dollars
  cc: number              // customer count
  newCust: number         // new customer count
  serviceSales: number
  productSales: number
  totalSales: number      // service + product
  floorHours: number
  payrollAmount: number
  trainingPay: number

  // Computed percentages and averages
  cph: number             // customers per hour
  payrollPct: number      // payroll / totalSales × 100
  payrollPctNoTraining: number  // (payroll - trainingPay) / totalSales × 100
  productPct: number      // productSales / totalSales × 100
  hcTime: number          // avg minutes per haircut
  mbc: number             // avg min between cust w/ cust waiting
  avgWaitTime: number     // total wait minutes / cc
  waits: number           // wait>15 % of all customers
  nonOciWaits: number     // wait>15 % of non-OCI customers
  ssWaits: number         // wait>15 % on Sat+Sun only
  nr: number              // new customer return %
  rr: number              // repeat customer return %
  newCustPct: number      // new customer % of total
}

// ── Aggregation ──────────────────────────────────────────────

/**
 * Combine a grouped summary with the underlying daily rows into the dashboard schema.
 *
 * The grouped row provides most metrics directly. Daily rows are used only for
 * splitting Sat/Sun waits.
 */
export function aggregatePeriod(
  grouped: SD3GroupedSummary,
  dailyRows: SD3DailyStoreSummary[],
  startDate: string,
  endDate: string
): AggregatedPeriod {
  const cc = num(grouped.customerCount)
  const newCust = num(grouped.newCustomerCount)
  const serviceSales = num(grouped.serviceSales)
  const productSales = num(grouped.productSales)
  const totalSales = serviceSales + productSales
  const floorHours = num(grouped.floorHours)
  const payrollAmount = num(grouped.approximatePayrollAmount)
  const trainingPay = num(grouped.trainingPay)

  const haircutOnlyServiceMinutes = num(grouped.haircutOnlyServiceMinutes)
  const haircutOnlyInvoiceCount = num(grouped.haircutOnlyInvoiceCount)
  const nonCutWithCustWaitingMinutes = num(grouped.nonCutWithCustWaitingMinutes)
  const totalCustomerWaitMinutes = num(grouped.totalCustomerWaitMinutes)
  const waitOver15MinsCount = num(grouped.waitOver15MinsCount)
  const nonOciWaitOver15MinsCount = num(grouped.nonOciWaitOver15MinsCount)
  const nonOciCustomerCount = num(grouped.nonOciCustomerCount)
  const newCustomerReturnCount = num(grouped.newCustomerReturnCount)
  const newCustomerVisitCount = num(grouped.newCustomerVisitCount)
  const repeatCustomerReturnCount = num(grouped.repeatCustomerReturnCount)
  const repeatCustomerVisitCount = num(grouped.repeatCustomerVisitCount)

  // Sat/Sun split — only place where we need daily granularity
  const weekendRows = dailyRows.filter(r => {
    const dow = dayOfWeek(r.date)
    return dow === 0 || dow === 6 // Sunday or Saturday
  })
  const ssWaitCount = weekendRows.reduce((s, r) => s + num(r.waitOver15MinsCount), 0)
  const ssCustCount = weekendRows.reduce((s, r) => s + num(r.customerCount), 0)

  return {
    storeId: grouped.storeId,
    startDate,
    endDate,

    cc,
    newCust,
    serviceSales,
    productSales,
    totalSales,
    floorHours,
    payrollAmount,
    trainingPay,

    cph: safeDiv(cc, floorHours),
    payrollPct: pct(payrollAmount, totalSales),
    payrollPctNoTraining: pct(payrollAmount - trainingPay, totalSales),
    productPct: pct(productSales, totalSales),
    hcTime: safeDiv(haircutOnlyServiceMinutes, haircutOnlyInvoiceCount),
    mbc: safeDiv(nonCutWithCustWaitingMinutes, cc),
    avgWaitTime: safeDiv(totalCustomerWaitMinutes, cc),
    waits: pct(waitOver15MinsCount, cc),
    nonOciWaits: pct(nonOciWaitOver15MinsCount, nonOciCustomerCount),
    ssWaits: pct(ssWaitCount, ssCustCount),
    nr: pct(newCustomerReturnCount, newCustomerVisitCount),
    rr: pct(repeatCustomerReturnCount, repeatCustomerVisitCount),
    newCustPct: pct(newCust, cc),
  }
}

// ── Helpers ───────────────────────────────────────────────────

/** Coerce SD3's mixed string/number numerics into number. */
function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return isNaN(n) ? 0 : n
  }
  return 0
}

/** Division returning 0 instead of NaN/Infinity. Rounds to 2 decimals. */
function safeDiv(numerator: number, denominator: number): number {
  if (!denominator) return 0
  return Math.round((numerator / denominator) * 100) / 100
}

/** Percentage with 2-decimal rounding. */
function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0
  return Math.round((numerator / denominator) * 10000) / 100
}