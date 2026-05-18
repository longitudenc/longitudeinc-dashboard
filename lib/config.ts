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
  '3685': 'Marvin',    '4138': 'Northwoods', '7728': 'Springfield',
  '8725': 'Anderson',  '9478': 'Carolina',   '9489': 'Arboretum',
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
