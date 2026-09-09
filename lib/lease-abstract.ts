// lib/lease-abstract.ts
// ---------------------------------------------------------------------------
// LEASE-ABSTRACT-v1
//
// Turn a document that has been dropped on the Lease Manager into a PROPOSAL:
// what kind of document it is, which salon it belongs to, and what it says that
// the lease records do not.
//
// IT PROPOSES. IT NEVER WRITES. Everything here is pure — text in, a structured
// suggestion out — and the caller shows it to a person who confirms, corrects
// or throws it away. Document extraction is right most of the time and
// confidently wrong the rest; a landlord statement quietly rewriting a rent
// figure would be worse than no automation at all.
//
// WHY POSITIONED CELLS, NOT A STRING. A PDF has no idea it contains a table.
// Pulled out as one run of characters, an American Asset recovery row reads
// "1,303,823.12-155,814.711,148,008.413651,200.00403,807.000.30..." and there
// is genuinely no way to know whether "3651,200.00" is 365 and 1,200.00 or
// 651,200.00 — both parse. So the browser reads each text item's x/y position
// and rebuilds the rows as tab-separated cells before anything gets here. Given
// cells, the same row is unambiguous. Given only a string, this file says what
// little it can prove and leaves the rest for a person.
//
// ANCHORED ON THE RIGHT. A recovery row ends with twelve numbers in a fixed
// order and begins with a variable amount of text that different PDF writers
// split differently. Reading the numbers backwards from the end of the row is
// stable in a way that counting columns forwards is not.
// ---------------------------------------------------------------------------

const S = (v: unknown) => String(v ?? '').trim()

/** Money as landlords write it: 1,234.56 / -155,814.71 / (1,234.56) / $12.00 */
export function money(raw: string): number | null {
  const t = S(raw).replace(/[$\s]/g, '')
  if (!t) return null
  if (!/^\(?-?[\d,]*\.?\d+\)?$/.test(t)) return null
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-')
  const n = Number(t.replace(/[(),\-]/g, ''))
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}
const isNum = (c: string) => money(c) !== null

export interface CamPool {
  pool: string
  poolLabel: string
  poolTotal: number
  deduction: number
  poolNet: number
  days: number
  tenantSf: number
  denominatorSf: number
  sharePct: number
  netShare: number
  adminFee: number
  totalShare: number
  billed: number
  due: number
}

export interface SalonGuess { salonNum: string; label: string; score: number; why: string }

/** One line of the landlord's own expense breakdown. */
export interface ExpenseLine { label: string; amount: number; total: boolean }

export interface Proposal {
  ok: boolean
  docType: 'cam-recon' | 'unknown'
  docLabel: string
  /** How the rows were read, so the UI can say whether to trust them. */
  source: 'cells' | 'text' | 'none'
  confidence: 'high' | 'low'
  landlord: string
  propertyCode: string
  tenantCode: string
  expenseYear: string
  invoiceDate: string
  tenantSf: number
  pools: CamPool[]
  totals: { netShare: number; adminFee: number; totalShare: number; billed: number; due: number } | null
  /** Best matches against the Leases tab, most likely first. */
  salonGuesses: SalonGuess[]
  /** Things a person should look at before accepting. */
  warnings: string[]
  /** Things worth acting on regardless of whether the rows are accepted. */
  findings: string[]
  /**
   * The landlord's own itemisation of what went into the pools. Not saved with
   * the reconciliation -- it is here so a person can read what they are being
   * charged for against whatever the lease excludes, which is the only way an
   * exclusion clause is ever worth anything.
   */
  expenseDetail: ExpenseLine[]
}

const POOL_KEYS: Record<string, string> = {
  cam: 'cam', ele: 'electricity', elec: 'electricity', electric: 'electricity',
  trash: 'trash', water: 'water', ins: 'insurance', tax: 'tax',
}

/** "12/2025" or "2025" or "December 31, 2025" -> "2025" */
function yearOf(t: string): string {
  const m = S(t).match(/\b(20\d{2})\b/)
  return m ? m[1] : ''
}

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december']
function isoDate(t: string): string {
  const m = S(t).toLowerCase().match(/\b([a-z]+)\s+(\d{1,2}),?\s*(20\d{2})\b/)
  if (m) {
    const mi = MONTHS.indexOf(m[1])
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`
  }
  const s = S(t).match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/)
  if (s) return `${s[3]}-${String(Number(s[1])).padStart(2, '0')}-${String(Number(s[2])).padStart(2, '0')}`
  return ''
}

/**
 * One recovery row, read backwards from the twelve trailing numbers.
 * Returns null when the row does not end in twelve numbers, which is how every
 * non-table line in the document is rejected without a list of exceptions.
 */
function poolFromCells(cells: string[]): CamPool | null {
  const c = cells.map(S).filter(x => x !== '')
  if (c.length < 13) return null
  // Walk back over trailing numeric cells.
  let i = c.length
  const nums: number[] = []
  while (i > 0 && isNum(c[i - 1]) && nums.length < 12) { nums.unshift(money(c[i - 1])!); i-- }
  if (nums.length < 12) return null
  const label = S(c[i - 1] || '')
  if (!label || isNum(label)) return null

  const [poolTotal, deduction, poolNet, days, tenantSf, denominatorSf,
         sharePct, netShare, adminFee, totalShare, billed, due] = nums
  // A recovery row always has a denominator larger than the tenant's own area
  // and a share under 100%. Anything else is a coincidence, not a row.
  if (!(denominatorSf > tenantSf && tenantSf > 0 && sharePct >= 0 && sharePct <= 100)) return null

  const key = label.toLowerCase().replace(/[^a-z]/g, '')
  return {
    pool: POOL_KEYS[key] || key || 'other',
    poolLabel: label,
    poolTotal, deduction, poolNet, days, tenantSf, denominatorSf,
    sharePct, netShare, adminFee, totalShare, billed, due,
  }
}

export interface AbstractInput {
  /** Tab-separated cells per line, from the browser's positional read. */
  lines?: string[]
  /** The same document as plain text, for the header fields. */
  text?: string
  fileName?: string
}

export interface LeaseLite {
  salonNum: string; locationName: string; landlord: string; address: string; areaSqFt: number
}

/** Which of our leases this document is about. Never decides — ranks. */
export function guessSalon(p: Partial<Proposal>, leases: LeaseLite[]): SalonGuess[] {
  const hay = (S(p.landlord) + ' ' + S(p.docLabel)).toLowerCase()
  const words = [...new Set(hay.split(/[^a-z0-9]+/).filter(w => w.length >= 4))]
  const STOP = new Set(['lease','llc','inc','corp','retail','shopping','center','centre','great','clips',
    'reconciliation','statement','invoice','property','company','limited','partnership','associates'])
  const useful = words.filter(w => !STOP.has(w))

  return leases.map(l => {
    const target = (l.landlord + ' ' + l.locationName + ' ' + l.address).toLowerCase()
    const hits = useful.filter(w => target.includes(w))
    let score = hits.length * 10
    const why: string[] = []
    if (hits.length) why.push('matches ' + hits.slice(0, 3).join(', '))
    // Area is a strong confirmation but a weak finder: several salons are
    // 1,200 SF, so it only ever breaks a tie.
    if (p.tenantSf && l.areaSqFt && Math.abs(p.tenantSf - l.areaSqFt) < 1) {
      score += 3; why.push('area matches ' + l.areaSqFt + ' SF')
    }
    return { salonNum: l.salonNum, label: l.locationName || l.salonNum, score, why: why.join(' · ') }
  }).filter(g => g.score > 0).sort((a, b) => b.score - a.score).slice(0, 4)
}

export function abstractDocument(input: AbstractInput, leases: LeaseLite[]): Proposal {
  const text = S(input.text)
  const flat = text.replace(/\s+/g, ' ')
  const lines = (input.lines || []).map(S).filter(Boolean)

  const p: Proposal = {
    ok: false, docType: 'unknown', docLabel: S(input.fileName),
    source: lines.length ? 'cells' : (text ? 'text' : 'none'),
    confidence: 'low',
    landlord: '', propertyCode: '', tenantCode: '', expenseYear: '', invoiceDate: '',
    tenantSf: 0, pools: [], totals: null, salonGuesses: [], warnings: [], findings: [],
    expenseDetail: [],
  }

  // ── is this a reconciliation at all? ──
  const looksRecon = /recovery calculation|reconciliation|cam,? tax|common area maintenance/i.test(flat)
  if (!looksRecon) {
    p.warnings.push('This does not read like a CAM or tax reconciliation. Nothing was extracted; '
      + 'the file is still filed against the salon.')
    return p
  }
  p.docType = 'cam-recon'

  // ── header facts ──
  const yearEnd = flat.match(/Expense Year End:?\s*([0-9/]+)/i)
  p.expenseYear = yearOf(yearEnd ? yearEnd[1] : '')
    || yearOf((flat.match(/\b(20\d{2})\s+(?:CAM|Common Area)/i) || [])[1] || '')
  const prop = flat.match(/Property Code:?\s*(\d+)/i)
  if (prop) p.propertyCode = prop[1]
  const tenant = flat.match(/\((t\d{5,})\)/i)
  if (tenant) p.tenantCode = tenant[1]
  // "1260 - Arboretum Retail, LLC" or "RE: Arboretum Retail, LLC"
  const ll = flat.match(/\b\d{3,5}\s*-\s*([A-Z][A-Za-z0-9 .,&'\-]{4,60}(?:LLC|L\.L\.C\.|Inc\.?|LP|L\.P\.|Trust|Company|Corp\.?))/)
    || flat.match(/RE:?\s*([A-Z][A-Za-z0-9 .,&'\-]{4,60}(?:LLC|L\.L\.C\.|Inc\.?|LP|L\.P\.|Trust|Company|Corp\.?))/)
  if (ll) p.landlord = S(ll[1])
  p.invoiceDate = isoDate(flat)

  // ── the pool rows ──
  for (const line of lines) {
    const row = poolFromCells(line.split('\t'))
    if (row) p.pools.push(row)
  }
  if (!p.pools.length && lines.length) {
    // Cells were supplied but nothing matched: say so rather than silently
    // falling through to a guess.
    p.warnings.push('The document was read but no recovery rows matched the expected shape '
      + '(a pool name followed by twelve figures). Check the table below against the letter.')
  }
  if (!lines.length) {
    p.warnings.push('This came through as plain text with no column positions, so the figures in the '
      + 'table cannot be split apart reliably and have been left out. Header details were still read. '
      + 'Re-drop the original PDF to get the table.')
  }

  if (p.pools.length) {
    p.ok = true
    p.confidence = 'high'
    p.tenantSf = p.pools[0].tenantSf
    const sum = (f: (r: CamPool) => number) => Math.round(p.pools.reduce((t, r) => t + f(r), 0) * 100) / 100
    p.totals = {
      netShare: sum(r => r.netShare), adminFee: sum(r => r.adminFee),
      totalShare: sum(r => r.totalShare), billed: sum(r => r.billed), due: sum(r => r.due),
    }

    // Every row should be internally consistent. Where it is not, the reader
    // needs to know which number to distrust.
    for (const r of p.pools) {
      const share = Math.round((r.netShare + r.adminFee) * 100) / 100
      if (Math.abs(share - r.totalShare) > 0.02) {
        p.warnings.push(`${r.poolLabel}: net share plus admin fee is ${share.toFixed(2)}, but the total `
          + `share reads ${r.totalShare.toFixed(2)}.`)
      }
      const expect = Math.round((r.totalShare - r.billed) * 100) / 100
      if (Math.abs(expect - r.due) > 0.02) {
        p.warnings.push(`${r.poolLabel}: total share less billed is ${expect.toFixed(2)}, but the amount `
          + `due reads ${r.due.toFixed(2)}.`)
      }
    }

    // ── what is worth acting on ──
    const withFee = p.pools.filter(r => r.adminFee > 0)
    if (withFee.length) {
      const rate = withFee.map(r => r.netShare > 0 ? r.adminFee / r.netShare * 100 : 0)
      const lo = Math.min(...rate), hi = Math.max(...rate)
      const band = Math.abs(hi - lo) < 0.05 ? `${hi.toFixed(1)}%` : `${lo.toFixed(1)}–${hi.toFixed(1)}%`
      p.findings.push(`An administrative fee of ${band} is charged on `
        + withFee.map(r => r.poolLabel).join(', ')
        + ` — ${p.totals!.adminFee.toFixed(2)} in total. Check it against what the lease allows; several `
        + `of ours struck the administrative fee out entirely.`)
    }
    const noFee = p.pools.filter(r => r.adminFee === 0).map(r => r.poolLabel)
    if (withFee.length && noFee.length) {
      p.findings.push(`No administrative fee on ${noFee.join(' or ')}, which is normal — the fee usually `
        + `applies to common area expenses only.`)
    }
    if (p.tenantSf) {
      const perSf = p.totals!.totalShare / p.tenantSf
      p.findings.push(`${p.totals!.totalShare.toFixed(2)} over ${p.tenantSf.toLocaleString('en-US')} SF is `
        + `$${perSf.toFixed(2)}/SF for the year, or $${(p.totals!.totalShare / 12).toFixed(2)} a month. `
        + `Compare that with the monthly estimate on the lease record.`)
    }
    if (!p.expenseYear) {
      p.warnings.push('No expense year could be read. Set it before saving, or the rows cannot be filed.')
    }
  }

  // ── the expense breakdown ──
  // Two cells, the second of them money. Deliberately loose: it is reference
  // material shown to a reader, never saved and never arithmetic.
  for (const line of lines) {
    const c = line.split('\t').map(S).filter(x => x !== '')
    if (c.length !== 2) continue
    const amt = money(c[1])
    if (amt === null || isNum(c[0])) continue
    if (!/[a-z]/i.test(c[0])) continue
    p.expenseDetail.push({ label: c[0], amount: amt, total: /^total\b/i.test(c[0]) })
  }
  if (p.expenseDetail.length > 200) p.expenseDetail = p.expenseDetail.slice(0, 200)

  p.salonGuesses = guessSalon(p, leases)
  if (!p.salonGuesses.length) {
    p.warnings.push('No lease record obviously matches this landlord. Pick the salon by hand.')
  }
  return p
}
