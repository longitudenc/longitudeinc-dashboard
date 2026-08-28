// lib/scripts/inspect-empincentive.ts
//
// Dump the shape of SD3's /rest/empincentive response so the Six Day figure can
// be mapped to real field names instead of guessed at.
//
// The Payroll Detail report shows incentives itemised — "Six Day", "FLOATER",
// "Bank Incentive" — while the Payroll Consolidated report merges them all into
// "All Other Incentives". This endpoint is what the report itself calls, so it
// should carry the same breakdown as data.
//
//   npx tsx lib/scripts/inspect-empincentive.ts [--salon 1304] [--week 2026-08-21]
//
// Needs SD3_USERNAME / SD3_PASSWORD in a local .env. Read-only: it fetches one
// store and prints, writing nothing anywhere.

import { config as loadEnv } from 'dotenv'
import { authenticate, fetchSalons, fetchEmpIncentive } from '../sd3'
import { fiscalWeekContaining, lastCompletedFiscalWeek, todayET } from '../fiscal'

loadEnv()

const argv = process.argv.slice(2)
const arg = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }

async function main() {
  const weekEnd = arg('week') || lastCompletedFiscalWeek(todayET()).end
  const weekStart = fiscalWeekContaining(weekEnd).start
  const wantSalon = arg('salon') || '1304'

  const session = await authenticate()
  const salons = await fetchSalons(session)
  const salon = salons.find(s => s.salonNum === wantSalon)
  if (!salon) {
    console.error(`Salon ${wantSalon} not found. Available: ${salons.map(s => s.salonNum).join(', ')}`)
    process.exit(1)
  }

  console.log(`\nempincentive — salon ${salon.salonNum} (storeId ${salon.storeId}), ${weekStart} → ${weekEnd}`)
  console.log('='.repeat(72))

  const rows = await fetchEmpIncentive(session, salon.storeId, weekStart, weekEnd)
  console.log(`${rows.length} records\n`)
  if (rows.length === 0) return

  // Every key seen, how often it is populated, and an example value.
  const keys = new Map<string, { filled: number; sample: unknown }>()
  for (const r of rows) {
    for (const [k, v] of Object.entries(flatten(r))) {
      const e = keys.get(k) ?? { filled: 0, sample: undefined }
      if (v !== null && v !== '' && v !== 0 && v !== false) {
        e.filled++
        if (e.sample === undefined) e.sample = v
      }
      keys.set(k, e)
    }
  }
  console.log('Fields (populated / total, example):')
  for (const [k, e] of [...keys].sort((a, b) => b[1].filled - a[1].filled)) {
    console.log(`  ${k.padEnd(44)} ${String(e.filled).padStart(4)}/${rows.length}  ${JSON.stringify(e.sample)?.slice(0, 60) ?? ''}`)
  }

  // Anything that looks like the six-day or floater line, by value or by name.
  console.log('\nRecords mentioning "six day" or "floater" anywhere:')
  let hits = 0
  for (const r of rows) {
    const text = JSON.stringify(r).toLowerCase()
    if (/six\s*day|floater/.test(text)) {
      if (hits < 5) console.log('  ' + JSON.stringify(r).slice(0, 400))
      hits++
    }
  }
  console.log(`  ${hits} of ${rows.length} records matched`)

  console.log('\nFirst record in full:')
  console.log(JSON.stringify(rows[0], null, 2).slice(0, 2000))
}

/** Flatten nested objects to dotted keys so nothing is hidden a level down. */
function flatten(o: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, prefix + k + '.'))
      else out[prefix + k] = v
    }
  } else {
    out[prefix.replace(/\.$/, '')] = o
  }
  return out
}

main().catch(e => { console.error('\n' + (e instanceof Error ? e.stack : String(e))); process.exit(1) })
