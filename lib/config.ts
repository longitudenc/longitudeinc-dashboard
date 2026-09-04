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
 
export const AM_ORDER = ['cassi','dawn','luann','dana','bridgette','kayla'] as const
 
export const SALON_NAMES: Record<string, string> = {
  '1304': 'Hilltop',   '2554': 'Carmel',     '3015': 'Food Lion',
  '3025': 'Landing',   '3027': 'Franklin',   '3043': 'Roosevelt',
  '3045': 'Park',      '3053': 'Plantation', '3058': 'Crown Point',
  '3062': 'Mint Hill', '3071': 'Sun Valley', '3545': 'Meridian',
  '3685': 'Marvin',    '4138': 'Northwoods', '4263': 'Catawba Ridge',
  '7728': 'Springfield', '8725': 'Anderson', '9478': 'Carolina',
  '9489': 'Arboretum', '9689': 'Cureton',
}

// 4263 Catawba Ridge is SIGNED BUT NOT YET TRADING. It is listed here because
// this map is what gates the Lease Manager (/api/leases/*), and the lease is a
// real obligation from the day it is signed — the paperwork, the guaranty and
// the rent commencement clock all exist before the doors open.
//
// It is deliberately NOT in the operational maps yet: AMS[].salons below,
// DEFAULT_AM_BY_SALON in lib/scrape-runner.ts and app/api/scrape/roster, and
// DEFAULT_SALONS in lib/adp-settings.ts. There is no SD3 data and no payroll
// to run, so adding it there would make the nightly scrape hunt a salon that
// does not report. Wire those up on the day it opens.
//
// KNOWN DRIFT, not yet fixed: 2554, 3045 and 9478 appear here but are missing
// from AMS[].salons and from BOTH copies of DEFAULT_AM_BY_SALON, so they have
// no area manager assigned. lib/adp-settings.ts separately still lists 1082
// and 3446, which are not salons here. These lists should be derived from this
// one rather than maintained alongside it.
 
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
