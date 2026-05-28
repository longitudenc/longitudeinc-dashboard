// lib/csv.ts
// Minimal, dependency-free CSV parsing for SD3 consolidated report downloads.
//
// SD3 CSVs are quoted ("field","field",...) with a few quirks we handle here:
//   - Employee Performance has 4 title/filter lines before the real header,
//     and 4 footnote lines after the last data row.
//   - Percentages carry a trailing "%" ("35.4%").
//   - NR/RR columns may be a low-sample marker like "19***" or "0***" —
//     the number is a diagnostic count, NOT the percentage, so the % is null.
//   - Payroll has the header on line 1, no preamble, no footer.

/**
 * Parse raw CSV text into an array of string-cell rows.
 * Handles double-quoted fields, escaped quotes (""), and commas inside quotes.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  // Normalize line endings
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  for (let i = 0; i < s.length; i++) {
    const c = s[i]

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++ // skip escaped quote
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else {
      if (c === '"') {
        inQuotes = true
      } else if (c === ',') {
        row.push(field)
        field = ''
      } else if (c === '\n') {
        row.push(field)
        rows.push(row)
        row = []
        field = ''
      } else {
        field += c
      }
    }
  }

  // Flush trailing field/row (file may not end with newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/**
 * Convert an array of rows into objects keyed by a given header row.
 * `headerRowIndex` is the 0-based index of the header within `rows`.
 * Data rows are everything after the header.
 */
export function rowsToObjectsAt(
  rows: string[][],
  headerRowIndex: number
): Record<string, string>[] {
  if (rows.length <= headerRowIndex) return []
  const headers = rows[headerRowIndex].map(h => h.trim())
  return rows.slice(headerRowIndex + 1).map(r => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? '').trim()
    })
    return obj
  })
}

// ── Value coercion ───────────────────────────────────────────────────────────

/**
 * Parse a numeric cell that may carry a trailing "%" or thousands separators.
 * Returns a number, or null if the cell is empty / non-numeric.
 *   "35.4%" → 35.4 ; "1,234.50" → 1234.5 ; "" → null
 */
export function num(cell: string | undefined): number | null {
  if (cell == null) return null
  const cleaned = cell.replace(/[%,$]/g, '').trim()
  if (cleaned === '') return null
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

/**
 * Parse an SD3 return-rate cell (NR% / RR%).
 * A value containing "***" is a low-sample marker: the percentage is NOT
 * reportable (insufficient return-eligible customers), so we return null.
 * Otherwise behaves like num().
 *   "48.0%" → 48 ; "19***" → null ; "0***" → null ; "" → null
 */
export function returnRate(cell: string | undefined): number | null {
  if (cell == null) return null
  if (cell.includes('*')) return null
  return num(cell)
}

/**
 * Convert M/D/YY or M/D/YYYY → YYYY-MM-DD. Passes through values already
 * in ISO form. Returns '' for blanks.
 *   "5/22/26" → "2026-05-22" ; "2026-05-22" → "2026-05-22"
 */
export function toISODate(cell: string | undefined): string {
  if (!cell) return ''
  const s = cell.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return s
  let [, mm, dd, yy] = m
  let year = parseInt(yy, 10)
  if (yy.length === 2) year += 2000
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}