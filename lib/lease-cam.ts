// lib/lease-cam.ts
// ---------------------------------------------------------------------------
// LEASE-CAM-v1
//
// CAM, tax and insurance RECONCILIATIONS — one row per salon per expense year
// per pool.
//
// This is the missing half of what a lease record says about money. The Leases
// tab carries `camMonthly`: a single number, and in most cases an ESTIMATE the
// landlord set at the start of the first lease year and has never revisited in
// our records. What actually happens is that every spring a landlord totals the
// year's expenses, applies our share, subtracts what we were billed monthly and
// invoices the difference. Until that lands somewhere structured, nobody can
// answer "is our estimate right", "what did CAM actually cost", or "are we
// being charged things the lease excludes".
//
// A ROW IS A POOL, NOT A LETTER. One reconciliation typically covers CAM,
// electricity, trash, water, insurance and tax, each with its own expense
// total, its own denominator and — importantly — its own admin fee treatment.
// Flattening them into one row per year would lose exactly the detail that
// makes the letter worth reading: on 9489 the admin fee is charged on the four
// CAM pools and not on tax or insurance, which is only visible per pool.
//
// THE ADMIN FEE IS STORED SEPARATELY FROM THE SHARE for the same reason. A
// lease that struck the administrative fee and a landlord that charges it
// anyway is a difference of hundreds of dollars a year, and it is invisible if
// the fee is buried inside a total.
//
// Nothing here writes itself. Rows arrive from a document the user has read a
// proposal for and confirmed — see lib/lease-abstract.ts.
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, rowsToObjects, tabExists, createTab } from '@/lib/sheets'

export const TAB_LEASE_CAM = 'LeaseCAM'

export const CAM_COLUMNS = [
  'reconId', 'salonNum', 'expenseYear', 'pool', 'poolLabel',
  'poolTotal', 'deduction', 'poolNet',
  'tenantSf', 'denominatorSf', 'sharePct',
  'netShare', 'adminFee', 'adminPct', 'totalShare', 'billed', 'due',
  'landlord', 'invoiceDate', 'sourceFile', 'note', 'updatedAt', 'updatedBy',
] as const

export interface CamRow {
  reconId: string
  salonNum: string
  /** The year the expenses belong to, not the year the letter arrived. */
  expenseYear: string
  /** A short key: cam, electricity, trash, water, insurance, tax, other. */
  pool: string
  /** Whatever the landlord called it, kept verbatim. */
  poolLabel: string
  poolTotal: number
  deduction: number
  poolNet: number
  tenantSf: number
  denominatorSf: number
  sharePct: number
  netShare: number
  adminFee: number
  adminPct: number
  totalShare: number
  billed: number
  due: number
  landlord: string
  invoiceDate: string
  sourceFile: string
  note: string
  updatedAt: string
  updatedBy: string
}

const S = (v: unknown) => String(v ?? '').trim()
const N = (v: unknown) => {
  // Landlord statements write money as 1,234.56 and negatives as (1,234.56).
  const raw = S(v).replace(/[$\s]/g, '')
  const neg = /^\(.*\)$/.test(raw)
  const n = Number(raw.replace(/[(),]/g, ''))
  if (!Number.isFinite(n)) return 0
  return neg ? -n : n
}
const r2 = (n: number) => Math.round(n * 100) / 100

function toRow(o: Record<string, any>): CamRow {
  return {
    reconId: S(o.reconId), salonNum: S(o.salonNum), expenseYear: S(o.expenseYear),
    pool: S(o.pool), poolLabel: S(o.poolLabel),
    poolTotal: N(o.poolTotal), deduction: N(o.deduction), poolNet: N(o.poolNet),
    tenantSf: N(o.tenantSf), denominatorSf: N(o.denominatorSf), sharePct: N(o.sharePct),
    netShare: N(o.netShare), adminFee: N(o.adminFee), adminPct: N(o.adminPct),
    totalShare: N(o.totalShare), billed: N(o.billed), due: N(o.due),
    landlord: S(o.landlord), invoiceDate: S(o.invoiceDate), sourceFile: S(o.sourceFile),
    note: S(o.note), updatedAt: S(o.updatedAt), updatedBy: S(o.updatedBy),
  }
}

export async function listCam(fresh = false): Promise<CamRow[]> {
  const rows = await readSheet(TAB_LEASE_CAM, undefined, fresh ? { fresh: true } : undefined)
  if (!rows || !rows.length) return []
  return rowsToObjects(rows).map(toRow).filter(r => r.salonNum && r.expenseYear)
}

/**
 * Replace every row for one salon+year with the set given. A reconciliation is
 * a document: re-importing it should produce the same state, not a second copy
 * of every pool. Other salons and years are untouched.
 */
export async function saveRecon(
  salonNum: string, expenseYear: string, rows: Partial<CamRow>[], by: string,
): Promise<CamRow[]> {
  const sn = S(salonNum), yr = S(expenseYear)
  if (!sn || !/^\d{4}$/.test(yr)) throw new Error('salonNum and a four-digit expenseYear are required')

  if (!(await tabExists(TAB_LEASE_CAM))) await createTab(TAB_LEASE_CAM)
  const all = await listCam(true)
  const keep = all.filter(r => !(r.salonNum === sn && r.expenseYear === yr))

  const now = new Date().toISOString()
  const stamp = Date.now().toString(36)
  const fresh: CamRow[] = rows.map((r, i) => {
    const poolTotal = r2(N(r.poolTotal))
    const deduction = r2(N(r.deduction))
    const netShare = r2(N(r.netShare))
    const adminFee = r2(N(r.adminFee))
    return toRow({
      ...r,
      reconId: S(r.reconId) || `cam_${sn}_${yr}_${S(r.pool) || i}_${stamp}`,
      salonNum: sn,
      expenseYear: yr,
      poolTotal, deduction,
      // Derived rather than trusted, so a mistyped subtotal cannot make the
      // stored row internally inconsistent.
      poolNet: r.poolNet === undefined || r.poolNet === null ? r2(poolTotal - Math.abs(deduction)) : r2(N(r.poolNet)),
      netShare, adminFee,
      adminPct: netShare > 0 ? r2(adminFee / netShare * 100) : 0,
      totalShare: r.totalShare === undefined || r.totalShare === null ? r2(netShare + adminFee) : r2(N(r.totalShare)),
      billed: r2(N(r.billed)),
      due: r.due === undefined || r.due === null
        ? r2(r2(netShare + adminFee) - r2(N(r.billed)))
        : r2(N(r.due)),
      updatedAt: now,
      updatedBy: by,
    })
  })

  const cols = CAM_COLUMNS as unknown as string[]
  const out = [...keep, ...fresh]
  await writeSheet(TAB_LEASE_CAM, [cols, ...out.map(r => cols.map(c => String((r as any)[c] ?? '')))])
  return fresh
}

export async function removeRecon(salonNum: string, expenseYear: string): Promise<number> {
  const sn = S(salonNum), yr = S(expenseYear)
  const all = await listCam(true)
  const keep = all.filter(r => !(r.salonNum === sn && r.expenseYear === yr))
  if (keep.length === all.length) return 0
  const cols = CAM_COLUMNS as unknown as string[]
  await writeSheet(TAB_LEASE_CAM, [cols, ...keep.map(r => cols.map(c => String((r as any)[c] ?? '')))])
  return all.length - keep.length
}

export interface ReconSummary {
  salonNum: string
  expenseYear: string
  landlord: string
  invoiceDate: string
  pools: number
  netShare: number
  adminFee: number
  totalShare: number
  billed: number
  due: number
  /** Total share over twelve months — what the monthly estimate SHOULD be. */
  impliedMonthly: number
  /** Which pools carried an administrative fee, and at what rate. */
  adminOn: { pool: string; pct: number; amount: number }[]
}

/** One line per salon per year, which is how a lease screen wants to read it. */
export function summarise(rows: CamRow[]): ReconSummary[] {
  const by = new Map<string, CamRow[]>()
  for (const r of rows) {
    const k = r.salonNum + '|' + r.expenseYear
    const l = by.get(k)
    if (l) l.push(r); else by.set(k, [r])
  }
  return [...by.values()].map(list => {
    const sum = (f: (r: CamRow) => number) => r2(list.reduce((t, r) => t + f(r), 0))
    const totalShare = sum(r => r.totalShare)
    return {
      salonNum: list[0].salonNum,
      expenseYear: list[0].expenseYear,
      landlord: list.find(r => r.landlord)?.landlord || '',
      invoiceDate: list.find(r => r.invoiceDate)?.invoiceDate || '',
      pools: list.length,
      netShare: sum(r => r.netShare),
      adminFee: sum(r => r.adminFee),
      totalShare,
      billed: sum(r => r.billed),
      due: sum(r => r.due),
      impliedMonthly: r2(totalShare / 12),
      adminOn: list.filter(r => r.adminFee > 0)
        .map(r => ({ pool: r.poolLabel || r.pool, pct: r.adminPct, amount: r.adminFee })),
    }
  }).sort((a, b) => (a.salonNum.localeCompare(b.salonNum)) || b.expenseYear.localeCompare(a.expenseYear))
}
