import {
  actionItems, portfolio, rentPerSfYr, termProgress, monthsBetween, daysBetween, normDate,
  type Lease, type LeaseOption,
} from '@/lib/lease-records'

const L = (o: Partial<Lease>): Lease => ({
  leaseId: 'x', salonNum: '0000', locationName: '', landlord: '', address: '',
  areaSqFt: 0, commencementDate: '', expirationDate: '', monthlyRent: 0,
  camMonthly: 0, securityDeposit: 0, status: 'active', note: '',
  updatedAt: '', updatedBy: '', ...o,
})
const O = (o: Partial<LeaseOption>): LeaseOption => ({
  optionId: 'o', salonNum: '0000', optionNo: 1, noticeBy: '',
  effectiveFrom: '', effectiveTo: '', exercised: '', note: '', ...o,
})

const today = '2026-09-01'
let pass = 0, fail = 0
const eq = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

console.log('date maths')
eq('monthsBetween 6mo', monthsBetween(today, '2027-02-28'), 5)
eq('monthsBetween exact', monthsBetween('2026-09-01', '2027-09-01'), 12)
eq('monthsBetween past', monthsBetween(today, '2026-06-01'), -3)
eq('daysBetween', daysBetween(today, '2026-09-11'), 10)
eq('normDate passthrough', normDate('2026-10-31'), '2026-10-31')
eq('normDate US', normDate('10/31/2026'), '2026-10-31')
eq('normDate junk', normDate('sometime'), '')

console.log('\nderived per lease')
const l1 = L({ salonNum: '2554', monthlyRent: 1650, areaSqFt: 1200,
  commencementDate: '2017-03-01', expirationDate: '2027-02-28' })
eq('$/SF/yr', Math.round(rentPerSfYr(l1) * 100) / 100, 16.5)
eq('term progress ~95%', Math.round(termProgress(l1, today)), 95)
eq('progress with no dates', termProgress(L({}), today), 0)

console.log('\naction items')
const leases = [
  L({ salonNum: '2554', locationName: 'Carmel', expirationDate: '2027-02-28' }),
  L({ salonNum: '3025', locationName: 'Landing', expirationDate: '2031-01-01' }),
  L({ salonNum: '3071', locationName: 'Sun Valley', expirationDate: '2026-08-01' }), // past
  L({ salonNum: '9999', locationName: 'Closed', expirationDate: '2026-10-01', status: 'terminated' }),
]
const options = [
  O({ salonNum: '2554', optionNo: 1, noticeBy: '2026-10-31', effectiveFrom: '2027-03-01' }),
  O({ salonNum: '3025', optionNo: 1, noticeBy: '2026-09-15' }),                       // urgent
  O({ salonNum: '3071', optionNo: 1, noticeBy: '2026-11-01', exercised: 'yes' }),     // decided
  O({ salonNum: '3053', optionNo: 2, noticeBy: '2030-01-01' }),                       // beyond horizon
]
const acts = actionItems(leases, options, today)
eq('count', acts.length, 4)
eq('soonest first', acts.map(a => a.date),
   ['2026-08-01', '2026-09-15', '2026-10-31', '2027-02-28'])
eq('expired lease reported as past', acts[0].severity, 'past')
eq('60-day notice is urgent', acts[1].severity, 'urgent')
eq('distant one is soon', acts[3].severity, 'soon')
eq('exercised option excluded', acts.some(a => a.salonNum === '3071' && a.kind === 'notice'), false)
eq('terminated lease excluded', acts.some(a => a.salonNum === '9999'), false)
eq('beyond horizon excluded', acts.some(a => a.salonNum === '3053'), false)

console.log('\nportfolio')
const pf = portfolio([
  L({ salonNum: '2554', areaSqFt: 1200, monthlyRent: 1650, camMonthly: 350, securityDeposit: 1650, expirationDate: '2027-02-28' }),
  L({ salonNum: '3025', areaSqFt: 1100, monthlyRent: 2000, securityDeposit: 2000, expirationDate: '2028-02-28' }),
  L({ salonNum: '3071', areaSqFt: 900, monthlyRent: 1000, expirationDate: '2035-01-01', status: 'terminated' }),
], today, ['2554', '3025', '3071', '3053'])
eq('active excludes terminated', pf.activeLeases, 2)
eq('expiring <=12mo', pf.expiringWithin12, 1)
eq('expiring <=18mo', pf.expiringWithin18, 2)
eq('area excludes terminated', pf.totalAreaSqFt, 2300)
eq('deposits', pf.totalDeposits, 3650)
eq('monthly includes CAM', pf.totalMonthly, 4000)
eq('annual', pf.totalAnnual, 48000)
eq('records present', pf.recordsPresent, 3)
eq('missing salons', pf.missingSalons, ['3053'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
