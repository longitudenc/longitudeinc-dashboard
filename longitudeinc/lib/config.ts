// ── Area Manager Configuration ────────────────────────────────
export interface AMConfig {
  name: string
  init: string
  color: string
  globalId: string
  salons: string[]
}

export const AMS: Record<string, AMConfig> = {
  cassi:     { name: 'Cassi Sharpe',       init: 'CS', color: '#a03030', globalId: '2014-0001-6376', salons: ['3015','3058','4138'] },
  dawn:      { name: 'Dawn Bowersox',      init: 'DB', color: '#2a6a9a', globalId: '2014-0001-6880', salons: ['3062','3071','9489'] },
  luann:     { name: 'Luann Wetherington', init: 'LW', color: '#6b3fa0', globalId: '2014-0001-5804', salons: ['1304','3043','3545','8725'] },
  dana:      { name: 'Dana Gainous',       init: 'DG', color: '#2a7a4a', globalId: '2014-0001-2977', salons: ['3025','3027','7728'] },
  bridgette: { name: 'Bridgette Stout',    init: 'BS', color: '#9a5a2a', globalId: '2014-0001-5799', salons: ['3053','3685','9689'] },
  kayla:     { name: 'Kayla Medlin',       init: 'KM', color: '#8a2a80', globalId: '2014-0001-2984', salons: [] },
}

export const AM_ORDER = ['cassi', 'dawn', 'luann', 'dana', 'bridgette', 'kayla'] as const

// ── Salon Names ───────────────────────────────────────────────
export const SALON_NAMES: Record<string, string> = {
  '1304': 'Hilltop',
  '2554': 'Carmel',
  '3015': 'Food Lion',
  '3025': 'Landing',
  '3027': 'Franklin',
  '3043': 'Roosevelt',
  '3045': 'Park',
  '3053': 'Plantation',
  '3058': 'Crown Point',
  '3062': 'Mint Hill',
  '3071': 'Sun Valley',
  '3545': 'Meridian',
  '3685': 'Marvin',
  '4138': 'Northwoods',
  '7728': 'Springfield',
  '8725': 'Anderson',
  '9478': 'Carolina',
  '9489': 'Arboretum',
  '9689': 'Cureton',
}

export function salonDisplay(num: string): string {
  const name = SALON_NAMES[num]
  return name ? `${num} ${name}` : num
}

export function amOf(salonNum: string): string | null {
  for (const [id, am] of Object.entries(AMS)) {
    if (am.salons.includes(salonNum)) return id
  }
  return null
}

// ── Sliding Scale (Payroll % and CPH goals by Avg Weekly CC) ──
export interface SlidingRow {
  min: number; max: number
  excPay: number; grwPay: number
  cph: number
}

export const SLIDING_SCALE: SlidingRow[] = [
  { min: 0,   max: 249,  excPay: 49, grwPay: 51, cph: 1.6 },
  { min: 250, max: 299,  excPay: 48, grwPay: 50, cph: 1.8 },
  { min: 300, max: 349,  excPay: 44, grwPay: 45, cph: 2.0 },
  { min: 350, max: 399,  excPay: 40, grwPay: 41, cph: 2.2 },
  { min: 400, max: 449,  excPay: 38, grwPay: 39, cph: 2.4 },
  { min: 450, max: 499,  excPay: 38, grwPay: 39, cph: 2.5 },
  { min: 500, max: 549,  excPay: 37, grwPay: 38, cph: 2.6 },
  { min: 550, max: 599,  excPay: 37, grwPay: 38, cph: 2.7 },
  { min: 600, max: 649,  excPay: 36, grwPay: 37, cph: 2.8 },
  { min: 650, max: 699,  excPay: 36, grwPay: 37, cph: 2.8 },
  { min: 700, max: 9999, excPay: 35, grwPay: 36, cph: 2.9 },
]

export function getSliding(cc: number): SlidingRow {
  return SLIDING_SCALE.find(r => cc >= r.min && cc <= r.max) || SLIDING_SCALE[SLIDING_SCALE.length - 1]
}

// ── Manager Bonus Calculation ─────────────────────────────────
export const BONUS_REF = { base: 555.46, grw: 23.18, exc: 46.25, cph: 69.43 }

export function calcMgrPayout(
  avgWeeklySales: number,
  cc: number,
  metrics: {
    payroll: number; ssWaits: number; waits: number; mbc: number
    salonProduct: number; salonNR: number; salonRR: number
    mgrProduct: number; mgrNR: number; cph: number
  },
  waiver: { payroll?: boolean; hours?: boolean } = {}
) {
  const sl = getSliding(cc)
  const base = avgWeeklySales * 0.065
  const total = base + 50
  const perGrw = base * (BONUS_REF.grw / BONUS_REF.base)
  const perExc = base * (BONUS_REF.exc / BONUS_REF.base)
  const cphAmt = base * (BONUS_REF.cph / BONUS_REF.base)

  const score = (v: number, grw: number, exc: number, lib: boolean) =>
    lib ? (v <= exc ? 'exc' : v <= grw ? 'grw' : 'miss')
        : (v >= exc ? 'exc' : v >= grw ? 'grw' : 'miss')

  const metricDefs = [
    { label: 'Payroll %',      v: metrics.payroll,      grw: sl.grwPay, exc: sl.excPay, lib: true  },
    { label: 'Sat/Sun VT',     v: metrics.ssWaits,      grw: 19,        exc: 15,        lib: true  },
    { label: 'Wait Times',     v: metrics.waits,        grw: 19,        exc: 15,        lib: true  },
    { label: 'Avg MBC',        v: metrics.mbc,          grw: 2.5,       exc: 2.0,       lib: true  },
    { label: 'Product %',      v: metrics.salonProduct, grw: 4,         exc: 6,         lib: false },
    { label: 'New Return %',   v: metrics.salonNR,      grw: 24,        exc: 26,        lib: false },
    { label: 'Repeat Return %',v: metrics.salonRR,      grw: 73.9,      exc: 77,        lib: false },
  ]

  let earned = 0
  let payrollMissed = false
  let productPenalty = false

  const results = metricDefs.map(m => {
    const r = score(m.v, m.grw, m.exc, m.lib)
    if (m.label === 'Payroll %' && r === 'miss') payrollMissed = true
    if (m.label === 'Product %' && metrics.mgrProduct < 4) productPenalty = true
    const amt = r === 'exc' ? (perGrw + perExc) : r === 'grw' ? perGrw : 0
    earned += amt
    return { ...m, result: r, amt }
  })

  const cphHit = metrics.cph >= sl.cph
  if (cphHit) earned += cphAmt

  const nrScore = score(metrics.mgrNR, 24, 26, false)
  const nrKicker = nrScore === 'exc' ? 50 : nrScore === 'grw' ? 25 : 0
  earned += nrKicker

  let penalties = 0
  const payPenActive = payrollMissed && !waiver.payroll
  const payPenAmt = payPenActive ? earned * 0.5 : 0
  if (payPenActive) penalties += payPenAmt
  const prodPenAmt = productPenalty ? (earned - payPenAmt) * 0.25 : 0
  if (productPenalty) penalties += prodPenAmt

  const finalPayout = Math.max(0, earned - penalties)

  return {
    totalPotential: total, finalPayout, earned, penalties,
    payrollMissed, productPenalty, payPenAmt, prodPenAmt,
    nrKicker, cphHit, cphAmt, perGrw, perExc,
    sl, metricResults: results,
    pctEarned: total > 0 ? finalPayout / total : 0,
  }
}
