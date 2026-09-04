import { config } from 'dotenv'
config({ path: '.env.local' })
import { readSheet, rowsToObjects } from '../sheets'

const S = (v: unknown) => String(v ?? '').trim()

;(async () => {
  const rows = rowsToObjects(((await readSheet('MarketWeekly')) || []) as any[][])
  const places = rowsToObjects(((await readSheet('GooglePlaces')) || []) as any[][])
  const weeks = [...new Set(rows.map(r => S(r.weekEnding)))].sort()
  const last = weeks[weeks.length - 1]
  const latest = rows.filter(r => S(r.weekEnding) === last)

  console.log('MarketWeekly rows', rows.length, '| weeks', weeks.length, '| latest', last, '| salons in latest week', latest.length)
  console.log('GooglePlaces rows', places.length)

  const noCoord = latest.filter(r => !S(r.lat) || !S(r.lng))
  console.log('\nSALONS WITH NO COORDINATES IN THE LATEST WEEK (' + noCoord.length + '):')
  for (const r of noCoord) console.log(`  ${S(r.salonNum).padEnd(6)} ${S(r.name).slice(0, 40).padEnd(42)} do=${S(r.do)}`)

  const placeBy = new Map(places.map(p => [S(p.salonNum), p]))
  const noPlace = latest.filter(r => !placeBy.has(S(r.salonNum)))
  console.log('\nSALONS WITH NO GooglePlaces ROW (' + noPlace.length + '):')
  for (const r of noPlace) console.log(`  ${S(r.salonNum).padEnd(6)} ${S(r.name).slice(0, 40).padEnd(42)} do=${S(r.do)} lat=${S(r.lat)} lng=${S(r.lng)}`)

  console.log('\nTHE THREE NAMED IN THE ROADMAP:')
  for (const n of ['4138', '5770', '9085']) {
    const inMkt = latest.find(r => S(r.salonNum) === n)
    const anyWeek = rows.filter(r => S(r.salonNum) === n)
    const p = placeBy.get(n)
    console.log(`  ${n}: latest-week row ${inMkt ? 'YES' : 'NO'} | rows in any week ${anyWeek.length}`)
    if (inMkt) console.log(`       name="${S(inMkt.name)}" do=${S(inMkt.do)} lat=${S(inMkt.lat)} lng=${S(inMkt.lng)} address=${S(inMkt.address) || '(none)'}`)
    else if (anyWeek.length) console.log(`       last seen ${S(anyWeek[anyWeek.length - 1].weekEnding)} name="${S(anyWeek[anyWeek.length - 1].name)}"`)
    if (p) console.log(`       GooglePlaces: ${S(p.matchedName)} | ${S(p.matchedAddress)} | ${S(p.businessStatus)} | ${S(p.distanceM)}m | rating ${S(p.rating)} (${S(p.reviews)})`)
    else console.log('       GooglePlaces: NO ROW')
  }

  const cols = Object.keys(latest[0] || {})
  console.log('\nMarketWeekly columns:', cols.join(', '))
})()
