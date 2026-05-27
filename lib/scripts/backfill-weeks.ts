// lib/scripts/backfill-weeks.ts
//
// One-time backfill script. Loops through fiscal weeks (Saturday → Friday)
// from a start date to an end date, calling /api/scrape/weekly for each one.
//
// Usage:
//   npx tsx lib/scripts/backfill-weeks.ts

import { config as dotenvConfig } from 'dotenv'
dotenvConfig({ path: '.env.local' })

const NEWEST_WEEK_END = '2026-05-22'
const OLDEST_WEEK_END = '2025-01-03'

const BASE_URL = 'http://localhost:3001'
const SECRET = 'local-dev-secret-not-for-production'

// ── HELPERS (UTC-safe) ──────────────────────────────────────

function toISODate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function addDays(s: string, n: number): string {
  const d = fromISODate(s)
  d.setUTCDate(d.getUTCDate() + n)
  return toISODate(d)
}

// ── MAIN ────────────────────────────────────────────────────

async function main() {
  const weeks: { start: string; end: string }[] = []
  let cursor = NEWEST_WEEK_END
  while (cursor >= OLDEST_WEEK_END) {
    weeks.push({
      start: addDays(cursor, -6),
      end: cursor,
    })
    cursor = addDays(cursor, -7)
  }

  console.log(`\n🗂  Backfilling ${weeks.length} fiscal weeks`)
  console.log(`    Range: ${weeks[weeks.length - 1].start} → ${weeks[0].end}`)
  console.log(`    Newest first: ${weeks[0].start} → ${weeks[0].end}`)
  console.log(`    Estimated time: ~${Math.ceil((weeks.length * 4) / 60)} minute(s)`)
  console.log('')

  let success = 0
  let failed = 0
  const startedAt = Date.now()

  for (let i = 0; i < weeks.length; i++) {
    const { start, end } = weeks[i]
    const idx = `${i + 1}/${weeks.length}`
    const url = `${BASE_URL}/api/scrape/weekly?secret=${encodeURIComponent(SECRET)}&start=${start}&end=${end}`

    process.stdout.write(`[${idx}] ${start} → ${end} ... `)
    const t0 = Date.now()

    try {
      const res = await fetch(url)
      const json = (await res.json()) as any
      const took = ((Date.now() - t0) / 1000).toFixed(1)

      if (json.ok) {
        const action =
          json.inserted > 0 ? `${json.inserted} inserted` :
          json.updated > 0 ? `${json.updated} updated` :
          '0 rows'
        console.log(`✓ ${json.salonsProcessed} salons, ${action} (${took}s)`)
        success++
      } else {
        console.log(`✗ ${json.error || 'unknown error'} (${took}s)`)
        failed++
      }
    } catch (err) {
      console.log(`✗ ${(err as Error).message}`)
      failed++
    }
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(0)
  console.log('')
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Done in ${totalSec}s · ${success} succeeded · ${failed} failed`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})