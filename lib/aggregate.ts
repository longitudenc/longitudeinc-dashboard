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
//
// 2026-06: now also exposes the RAW inputs behind SD3's Manager Bonus report
// formulas (verified exactly against the May 2026 report for salon 1304):
//   Product %     = Σ productSales / (Σ serviceSales + Σ svcDiscounts + Σ redo)
//   Productivity  = (Σ serviceSales + Σ svcDiscounts + Σ redo) / Σ floorHours
//   CPH           = Productivity / (Σ grossHaircutSales / Σ haircutCount)
//   Waits >15     = Σ waitOver15Count / Σ cc
//   Sat/Sun >15   = Σ ssWaitCount / Σ ssCustCount
// These raw fields are persisted weekly so the salon-month aggregator can
// reproduce the bonus report from SD_WEEKLY alone.

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
  receptionistPay: number

  // Raw bonus-formula inputs (period totals)
  serviceDiscounts: number     // $ service discounts
  productDiscounts: number     // $ product discounts
  redoAmount: number           // $ redos
  grossHaircutSales: number    // $ haircut sales (gross)
  haircutCount: number         // number of haircuts (cuts, not customers)
  waitOver15Count: number      // customers who waited > 15 min
  ssCustCount: number          // Sat+Sun customer count
  ssWaitCount: number          // Sat+Sun customers who waited > 15 min
  // Raw rate bases for exact pooled roll-ups (period totals) — added 2026-06
  nrReturnCount: number        // new-customer cohort: returned (NR numerator)
  nrVisitCount: number         // new-customer cohort: total (NR denominator)
  rrReturnCount: number        // repeat-customer cohort: returned (RR numerator)
  rrVisitCount: number         // repeat-customer cohort: total (RR denominator)
  nonOciWaitCount: number      // non-OCI customers who waited > 15 min
  nonOciCustCount: number      // non-OCI customer count (nonOciWaits denominator)

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
  const receptionistPay = num(grouped.receptionistPay)

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

  // Raw bonus-formula inputs from the grouped row
  const serviceDiscounts = num(grouped.serviceDiscounts)
  const productDiscounts = num(grouped.productDiscounts)
  const redoAmount = num(grouped.redoAmount)
  const grossHaircutSales = num(grouped.grossHaircutSales)
  const haircutCount = num(grouped.haircutCount)

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
    receptionistPay,

    serviceDiscounts,
    productDiscounts,
    redoAmount,
    grossHaircutSales,
    haircutCount,
    waitOver15Count: waitOver15MinsCount,
    ssCustCount,
    ssWaitCount,
    nrReturnCount: newCustomerReturnCount,
    nrVisitCount: newCustomerVisitCount,
    rrReturnCount: repeatCustomerReturnCount,
    rrVisitCount: repeatCustomerVisitCount,
    nonOciWaitCount: nonOciWaitOver15MinsCount,
    nonOciCustCount: nonOciCustomerCount,

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
