// lib/thresholds.ts
//
// METRIC THRESHOLDS — the 4/3/2/1 bands every salon and stylist figure is
// coloured against.
//
// These used to be hard-coded in public/dashboard.html. They live here so they
// can be edited from the admin panel without a deploy, and so anything else
// that grades a number (the planned weekly summary email) reads one definition
// instead of keeping a second copy that quietly drifts out of step.
//
// EFFECTIVE DATING: each row carries an `effectiveFrom` date. Grading a week
// resolves the newest row starting on or before that week, so raising a bar
// today does NOT retroactively re-grade last year's scorecards, bonuses or
// raise reviews — history keeps the bands it was actually earned under. A blank
// effectiveFrom means "since the beginning".
//
// Falls back to DEFAULTS when the tab is missing or a metric has no row, so an
// empty tab degrades to exactly today's behaviour rather than to ungraded
// numbers.

import { readSheet, rowsToObjects } from './sheets'

export const TAB_THRESHOLDS = 'MetricThresholds'

export const THRESHOLD_COLUMNS = [
  'metric', 'direction', 'v4', 'v3', 'v2', 'v4hi', 'v3hi', 'v2hi', 'effectiveFrom', 'notes',
] as const

// 'higher' — bigger is better (>= v4 is Excellence)
// 'lower'  — smaller is better (<= v4 is Excellence)
// 'band'   — an ideal range: Excellence inside [v4, v4hi], Growth in the
//            shoulders [v3, v4) and (v4hi, v3hi], Minimum up to v2hi, else
//            Warning. This is how HC Time works: too fast is a miss too.
export type Direction = 'higher' | 'lower' | 'band'
export type Tier = 'c4' | 'c3' | 'c2' | 'c1' | ''

export interface ThresholdRow {
  metric: string
  direction: Direction
  v4: number | null
  v3: number | null
  v2: number | null
  v4hi: number | null
  v3hi: number | null
  v2hi: number | null
  effectiveFrom: string
  notes: string
}

// Display metadata for the admin editor. `decimals` mirrors the rounding the
// dashboard applies before comparing, so what you see is what gets graded.
export const METRIC_META: {
  metric: string; label: string; direction: Direction; decimals: number; unit: string
}[] = [
  { metric: 'cc',    label: 'Customer Count', direction: 'higher', decimals: 0, unit: ''  },
  { metric: 'ccg',   label: 'CC Growth',      direction: 'higher', decimals: 1, unit: '%' },
  { metric: 'sgr',   label: 'Sales Growth',   direction: 'higher', decimals: 1, unit: '%' },
  { metric: 'prod',  label: 'Product %',      direction: 'higher', decimals: 1, unit: '%' },
  { metric: 'nr',    label: 'NR %',           direction: 'higher', decimals: 1, unit: '%' },
  { metric: 'rr',    label: 'RR %',           direction: 'higher', decimals: 1, unit: '%' },
  { metric: 'mbc',   label: 'MBC',            direction: 'lower',  decimals: 1, unit: ''  },
  { metric: 'waits', label: 'Waits %',        direction: 'lower',  decimals: 1, unit: '%' },
  { metric: 'hc',    label: 'HC Time',        direction: 'band',   decimals: 1, unit: ''  },
]

const R = (
  metric: string, direction: Direction,
  v4: number | null, v3: number | null, v2: number | null,
  v4hi: number | null = null, v3hi: number | null = null, v2hi: number | null = null,
): ThresholdRow => ({ metric, direction, v4, v3, v2, v4hi, v3hi, v2hi, effectiveFrom: '', notes: '' })

// EXACTLY the bands dashboard.html shipped with. These are the fallback for any
// period with no sheet row, so prefer adding a dated row over editing these.
export const DEFAULTS: ThresholdRow[] = [
  R('cc',    'higher', 520, 420,  320),
  R('ccg',   'higher', 5,   3,    1),
  R('sgr',   'higher', 5,   3,    1),
  R('prod',  'higher', 6,   4,    2.5),
  R('nr',    'higher', 26,  24,   21),
  R('rr',    'higher', 77,  73.9, 70.9),
  R('mbc',   'lower',  2.0, 2.5,  3.0),
  R('waits', 'lower',  15,  19,   23),
  R('hc',    'band',   12,  11,   null, 15, 17, 18),
]

const numOrNull = (v: unknown): number | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const n = Number(s.replace('%', ''))
  return Number.isFinite(n) ? n : null
}

// Sheets may hand back "2026-01-03" or a rendered date cell; normalize to ISO so
// a plain string compare is chronological.
export function normEffective(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  const d = new Date(s)
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function getThresholdRows(): Promise<ThresholdRow[]> {
  let raw: any[] = []
  try { raw = rowsToObjects(await readSheet(TAB_THRESHOLDS)) } catch { return [] }
  return raw
    .map(r => ({
      metric: String(r.metric ?? '').trim().toLowerCase(),
      direction: (String(r.direction ?? '').trim().toLowerCase() || 'higher') as Direction,
      v4: numOrNull(r.v4), v3: numOrNull(r.v3), v2: numOrNull(r.v2),
      v4hi: numOrNull(r.v4hi), v3hi: numOrNull(r.v3hi), v2hi: numOrNull(r.v2hi),
      effectiveFrom: normEffective(r.effectiveFrom),
      notes: String(r.notes ?? '').trim(),
    }))
    .filter(r => r.metric)
}

/**
 * The bands in force on `asOf` (YYYY-MM-DD), keyed by metric.
 *
 * Per metric, the row with the latest effectiveFrom that is <= asOf wins. A
 * metric with no qualifying row falls back to its DEFAULT, so a partly-filled
 * tab is safe. A blank asOf means "newest row regardless of date".
 */
export function resolveThresholds(rows: ThresholdRow[], asOf: string): Record<string, ThresholdRow> {
  const out: Record<string, ThresholdRow> = {}
  for (const d of DEFAULTS) out[d.metric] = d
  const bestDate: Record<string, string> = {}
  for (const r of rows) {
    if (asOf && r.effectiveFrom && r.effectiveFrom > asOf) continue   // not in force yet
    const prev = bestDate[r.metric]
    if (prev === undefined || r.effectiveFrom >= prev) {
      bestDate[r.metric] = r.effectiveFrom
      out[r.metric] = r
    }
  }
  return out
}

const round = (v: number, dec: number) => { const f = Math.pow(10, dec); return Math.round(v * f) / f }

/** Grade one value against a resolved table. '' when the value or band is unusable. */
export function gradeMetric(
  metric: string,
  value: number | null | undefined,
  table: Record<string, ThresholdRow>,
): Tier {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return ''
  const t = table[metric]
  if (!t) return ''
  const meta = METRIC_META.find(m => m.metric === metric)
  const v = round(Number(value), meta ? meta.decimals : 1)

  if (t.direction === 'band') {
    const { v4, v3, v4hi, v3hi, v2hi } = t
    if (v4 != null && v4hi != null && v >= v4 && v <= v4hi) return 'c4'
    if (v3 != null && v4 != null && v >= v3 && v < v4) return 'c3'
    if (v3hi != null && v4hi != null && v > v4hi && v <= v3hi) return 'c3'
    if (v2hi != null && v3hi != null && v > v3hi && v <= v2hi) return 'c2'
    return 'c1'
  }
  if (t.direction === 'lower') {
    if (t.v4 != null && v <= t.v4) return 'c4'
    if (t.v3 != null && v <= t.v3) return 'c3'
    if (t.v2 != null && v <= t.v2) return 'c2'
    return 'c1'
  }
  if (t.v4 != null && v >= t.v4) return 'c4'
  if (t.v3 != null && v >= t.v3) return 'c3'
  if (t.v2 != null && v >= t.v2) return 'c2'
  return 'c1'
}
