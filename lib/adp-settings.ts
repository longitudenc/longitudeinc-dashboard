// lib/adp-settings.ts
// ---------------------------------------------------------------------------
// Configuration for the SD3 → ADP payroll upload.
//
// Everything the old "Payroll Import Program.xlsm" kept on its hidden `Settings`
// sheet lives here: the earnings-code map, the salon → Batch Id / Co Code table,
// and the thresholds behind 6-day pay and short-break pay.
//
// Defaults below are transcribed from that workbook (v241119Client) so the tool
// produces the same file on day one with nothing configured. Two Google Sheet
// tabs override them, so the office can change a code without a deploy:
//
//   ADP_SETTINGS  key | value        — flat key/value (codes + rule thresholds)
//   ADP_SALONS    salonNum | coCode | batchId
//
// Neither tab has to exist; a missing tab just means "use the defaults".
//
// The workbook left Shift Incentive, Stylist Bonus and 6-day pay as "TBD".
// The owner assigned them on 2026-09-01 against the real ADP earnings code
// list: stylist bonus on 2, and shift incentive and 6-day both on 11, the
// same code All Other Incentives already uses.
//
// Short-break pay is still unassigned, and correctly so: breakMode is 'off',
// and a code is only needed in 'separateCode' mode. buildAdpUpload() refuses
// to silently emit a blank code — any pay landing on an unset one is a
// blocking exception rather than money that disappears into ADP.
// ---------------------------------------------------------------------------

import { readSheet, rowsToObjects } from '@/lib/sheets'

const ADP_SETTINGS_TAB = 'ADP_SETTINGS'
const ADP_SALONS_TAB = 'ADP_SALONS'

// ── Which ADP column pair each payroll field is written to ───────────────
// Fixed by ADP's import layout, not by us — an hours field goes in an
// "Hours 4 Code/Amount" pair, tips and the OT premium in "Earnings 3", every
// other dollar field in "Earnings 4". This mirrors the workbook's Settings
// columns C/D ("Code Desc" / "Amt Desc") exactly.
export type AdpSlot = 'hours4' | 'earnings3' | 'earnings4'

export const SLOT_HEADERS: Record<AdpSlot, { code: string; amount: string }> = {
  hours4: { code: 'Hours 4 Code', amount: 'Hours 4 Amount' },
  earnings3: { code: 'Earnings 3 Code', amount: 'Earnings 3 Amount' },
  earnings4: { code: 'Earnings 4 Code', amount: 'Earnings 4 Amount' },
}

/**
 * One column pair in the ADP upload, in the order ADP expects them.
 *
 * `source` names where the amount comes from:
 *   - a Pay Consol column name, for the columns SD3 already gives us
 *   - a `calc:` pseudo-source, for the lines this tool adds
 *   - `manual:` for the two free slots the office fills in by hand
 */
export interface AdpField {
  /** Key used in ADP_SETTINGS as `code.<key>` */
  key: string
  /** Human label, matching the workbook's Settings "Description" column */
  label: string
  slot: AdpSlot
  source: string
  /** true = the amount is hours, not dollars (ADP applies the rate) */
  isHours: boolean
}

/**
 * The 15 code/amount pairs, in ADP column order. This ordering IS the file
 * format — it reproduces what CreatePayUpload built by deleting columns from
 * Pay Consol and inserting a code column before each survivor.
 */
export const ADP_FIELDS: AdpField[] = [
  { key: 'floorHours', label: 'Floor Hours', slot: 'hours4', source: 'Floor Hours', isHours: true },
  // Closing absorbs Admin Hours before export — the workbook does the same add
  // and then deletes the Admin column.
  { key: 'closingHours', label: 'Closing Hours', slot: 'hours4', source: 'calc:closingPlusAdmin', isHours: true },
  { key: 'trainingHours', label: 'Training Hours', slot: 'hours4', source: 'Training Hours', isHours: true },
  { key: 'receptionHours', label: 'Reception Hours', slot: 'hours4', source: 'Reception Hours', isHours: true },
  { key: 'vacationHours', label: 'Vacation Hours', slot: 'hours4', source: 'Vacation Hours', isHours: true },
  { key: 'holidayHours', label: 'Holiday Hours', slot: 'hours4', source: 'Holiday Hours', isHours: true },
  { key: 'sickHours', label: 'Sick Hours', slot: 'hours4', source: 'Sick Hours', isHours: true },
  { key: 'overtimePay', label: 'Overtime Hours Pay', slot: 'earnings3', source: 'calc:overtimePay', isHours: false },
  { key: 'productivityIncentive', label: 'Productivity Incentive', slot: 'earnings4', source: 'Productivity Incentive', isHours: false },
  { key: 'productIncentive', label: 'Product Incentive', slot: 'earnings4', source: 'Product Incentive', isHours: false },
  { key: 'newReturnIncentive', label: 'New Return Incentive', slot: 'earnings4', source: 'New Return Incentive', isHours: false },
  { key: 'shiftIncentive', label: 'Shift Incentive', slot: 'earnings4', source: 'Shift Incentive', isHours: false },
  { key: 'allOtherIncentives', label: 'All Other Incentives', slot: 'earnings4', source: 'All Other Incentives', isHours: false },
  { key: 'cashCheckTips', label: 'Cash & Check Tips', slot: 'earnings3', source: 'Cash & Check Tips', isHours: false },
  { key: 'chargeTips', label: 'Charge Tips', slot: 'earnings4', source: 'Charge Tips', isHours: false },
]

/**
 * Two spare Earnings 4 pairs the workbook appended for hand-keyed lines
 * (Referral/Sign On, Guarantee). We keep them — that's where 6-day pay, the
 * short-break add-back, bonuses and any manual earning land, so the column
 * count and layout stay byte-identical to what ADP accepts today.
 */
export const EXTRA_EARNINGS_SLOTS = 2

/** Codes from the workbook's Settings sheet. '' = the workbook said "TBD". */
const DEFAULT_CODES: Record<string, string> = {
  floorHours: '37',
  closingHours: '38',
  trainingHours: '39',
  receptionHours: '17',
  vacationHours: '14',
  holidayHours: '15',
  sickHours: '99',
  overtimePay: '12',
  productivityIncentive: '16',
  productIncentive: '13',
  newReturnIncentive: '19',
  // 11 is also All Other Incentives. Deliberate: Pay Consol reports Shift
  // Incentive in its own column, but it belongs in the same bucket, and that
  // is where the office has always put it.
  shiftIncentive: '11',
  allOtherIncentives: '11',
  cashCheckTips: 'T',
  chargeTips: 'CT',
  // Lines this tool adds.
  //
  // sixDay is read ONLY in sixDayMode 'add'. The live mode is 'net', which
  // adjusts allOtherIncentives in place and never writes a separate line —
  // so 6-day pay already rides on 11 today. Setting it here means 'add' mode
  // would put it on the same code rather than failing for want of one.
  sixDay: '11',
  // Unassigned on purpose: breakMode is 'off', and only 'separateCode' needs it.
  shortBreak: '',
  stylistBonus: '2',
}

/**
 * Every earnings code that exists in our ADP company.
 *
 * Transcribed from the Earnings Codes list in Workforce Now on 2026-09-01.
 * This is a REFERENCE list, not configuration: it does not decide what any
 * field is paid on. It exists so the settings screen can offer real codes
 * instead of a blank box, and can say that a code typed in by hand is not one
 * ADP actually knows about.
 *
 * INCOMPLETE AT BOTH ENDS. The list was copied from a paginated screen that
 * sorts codes as text: it began at "10", so any code sorting before that (a
 * bare "1", for instance) is missing, and it was cut off mid-row at XMS, so
 * anything after XMS is missing too. Add to it rather than trusting its
 * absence — an unknown code here is reported as a warning, never a block.
 */
export interface AdpEarningsCode {
  code: string
  description: string
  kind: 'Hours/Earnings' | 'Earnings' | ''
  /** ADP rate class, as shown in Workforce Now. */
  rateClass: string
  /** Whether ADP lists the code as in use. */
  active: boolean
}

export const ADP_EARNINGS_CODES: AdpEarningsCode[] = [
  { code: '2', description: "Stylist Bonus", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '10', description: "INCENTIVE", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '11', description: "Incentive", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '12', description: "O/T", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '13', description: "PROD BONUS", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '14', description: "VACATION", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '15', description: "HOLIDAY", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '16', description: "PRODUCTIVITY", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '17', description: "RECEPTION", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '19', description: "RETURN BON", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '23', description: "GUARANTEE", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '37', description: "FLOOR", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '38', description: "ADMIN/CLOSING", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: '39', description: "TRAINING", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'ADT', description: "Admin/Training", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'ADV', description: "", kind: 'Hours/Earnings', rateClass: '', active: false },
  { code: 'CC', description: "Child care", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'CEL', description: "CELL", kind: 'Hours/Earnings', rateClass: '4 - Straight Time', active: false },
  { code: 'CP', description: "Cell Phone", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'CT', description: "Card Tips", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'GMA', description: "GM Admin", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'GMB', description: "GM Bonus", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'HSA', description: "HSA", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'J', description: "", kind: 'Hours/Earnings', rateClass: '', active: false },
  { code: 'MGR', description: "Manager Bonus", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'MIL', description: "Mileage", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'REF', description: "REFERRAL", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'REG', description: "Regular Salary", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'SEV', description: "SEVERANCE", kind: 'Earnings', rateClass: '4 - Straight Time', active: true },
  { code: 'SL', description: "Student Loan", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'T', description: "TIPS", kind: 'Hours/Earnings', rateClass: '3 - Straight Time', active: true },
  { code: 'TRP', description: "", kind: 'Hours/Earnings', rateClass: '4 - Straight Time', active: false },
  { code: 'XMS', description: "XMAS%", kind: 'Earnings', rateClass: '3 - Straight Time', active: true },
]

/** Look a code up in the catalogue, case-insensitively. */
export function findEarningsCode(code: string): AdpEarningsCode | undefined {
  const c = String(code ?? '').trim().toLowerCase()
  if (!c) return undefined
  return ADP_EARNINGS_CODES.find(e => e.code.toLowerCase() === c)
}

export interface AdpRules {
  // ── 6-day pay ──
  /** Dollars per floor hour once the week qualifies. */
  sixDayRate: number
  /** Days on the floor required in the Sat→Fri week. */
  sixDayMinDays: number
  /** A day only counts toward sixDayMinDays if it reaches this many floor hours. */
  sixDayMinShiftHours: number
  /** Minimum floor hours for the whole week. */
  sixDayMinFloorHours: number
  /**
   * How 6-day pay reaches the file.
   *   'net'        — SD3 ALREADY pays 6-day inside All Other Incentives, using
   *                  its own looser rule, so the file carries only the
   *                  difference: subtract where SD3 over-paid, add where it
   *                  missed a floater. Default, and what the office does by hand.
   *   'add'        — treat SD3 as paying nothing and add the full amount.
   *   'reportOnly' — calculate and show it, write nothing.
   */
  sixDayMode: 'net' | 'add' | 'reportOnly'

  // ── SD3's OWN 6-day rule, which is looser than ours ──
  // SD3 pays $1 per floor hour once someone worked this many days at a salon
  // and reached this many TOTAL hours there — it does not check the 4-hour
  // minimum shift, does not use floor hours for the threshold, and evaluates
  // each salon separately (so floaters get missed entirely).
  sd3SixDayMinDays: number
  sd3SixDayMinTotalHours: number

  // ── Short breaks ──
  /** Breaks strictly under this many minutes must be paid. */
  breakMaxMinutes: number
  /**
   * 'off' skips short breaks entirely — nothing is calculated, nothing reaches
   *   the file, and the review screen never mentions them. Default, so a week
   *   built here lines up with the weeks the office already sent to ADP.
   * 'foldFloorHours' adds the minutes to the Floor Hours line, so ADP pays them
   *   at the employee's own base rate with no new earnings code.
   * 'separateCode' emits them on their own code (requires code.shortBreak).
   * 'reportOnly' calculates and shows them but writes nothing to the file.
   */
  breakMode: 'off' | 'foldFloorHours' | 'separateCode' | 'reportOnly'

  // ── Overtime ──
  /** Weekly hours after which the half-time premium applies. */
  otThresholdHours: number

  // ── Week-over-week check ──
  /**
   * Percent movement in a salon's payroll cost, against the last week actually
   * sent, that earns a warning. A bad scrape or a missing person shows up here
   * before the file does — 0 turns the check off.
   */
  varianceAlertPct: number

  // ── Bonuses ──
  /** Auto-populate bonuses on the Nth paycheck of the calendar month. */
  bonusPaycheckOfMonth: number
  /** Days from week-ending Friday to the pay date. 6 → the following Thursday. */
  payDateOffsetDays: number
}

const DEFAULT_RULES: AdpRules = {
  sixDayRate: 1,
  sixDayMinDays: 6,
  sixDayMinShiftHours: 4,
  sixDayMinFloorHours: 34,
  sixDayMode: 'net',
  sd3SixDayMinDays: 6,
  sd3SixDayMinTotalHours: 34,
  breakMaxMinutes: 20,
  breakMode: 'off',
  otThresholdHours: 40,
  varianceAlertPct: 15,
  bonusPaycheckOfMonth: 3,
  payDateOffsetDays: 6,
}

/** salon # → { coCode, batchId }, from the workbook's Settings columns F/G/H. */
const DEFAULT_SALONS: Record<string, { coCode: string; batchId: string }> = {
  '1304': { coCode: 'BSP', batchId: '4' },
  '2554': { coCode: 'BSP', batchId: '54' },
  '3015': { coCode: 'BSP', batchId: '15' },
  '3025': { coCode: 'BSP', batchId: '25' },
  '3043': { coCode: 'BSP', batchId: '43' },
  '3053': { coCode: 'BSP', batchId: '53' },
  '3058': { coCode: 'BSP', batchId: '58' },
  '3062': { coCode: 'BSP', batchId: '62' },
  '3071': { coCode: 'BSP', batchId: '71' },
  '3446': { coCode: 'BSP', batchId: '46' },
  '7728': { coCode: 'BSP', batchId: '28' },
  '9478': { coCode: 'BSP', batchId: '78' },
  '1082': { coCode: 'BSP', batchId: '82' },
  '4138': { coCode: 'BSP', batchId: '38' },
  '8725': { coCode: 'BSP', batchId: '87' },
  '3027': { coCode: 'BSP', batchId: '27' },
  '3045': { coCode: 'BSP', batchId: '45' },
  '3545': { coCode: 'BSP', batchId: '35' },
  '3685': { coCode: 'BSP', batchId: '85' },
  '9489': { coCode: 'BSP', batchId: '94' },
  '9689': { coCode: 'BSP', batchId: '89' },
}

export interface AdpSettings {
  /** field key → ADP earnings code. '' means unassigned. */
  codes: Record<string, string>
  rules: AdpRules
  salons: Record<string, { coCode: string; batchId: string }>
  /** Which values actually came from the sheet (for the settings UI). */
  overrides: Record<string, string>
}

export function defaultSettings(): AdpSettings {
  return {
    codes: { ...DEFAULT_CODES },
    rules: { ...DEFAULT_RULES },
    salons: JSON.parse(JSON.stringify(DEFAULT_SALONS)),
    overrides: {},
  }
}

function toNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n : fallback
}

/**
 * Load settings: defaults, then anything the ADP_SETTINGS / ADP_SALONS tabs
 * override. A missing tab, an empty tab, or a Sheets hiccup all fall back to
 * defaults rather than failing the payroll run — the caller still gets a
 * working configuration and the exception report flags any unset code.
 */
export async function loadAdpSettings(): Promise<AdpSettings> {
  const settings = defaultSettings()

  // ── key/value tab ──
  try {
    const rows = rowsToObjects(await readSheet(ADP_SETTINGS_TAB))
    for (const r of rows) {
      const key = String(r.key ?? '').trim()
      if (!key) continue
      const raw = String(r.value ?? '').trim()
      settings.overrides[key] = raw

      if (key.startsWith('code.')) {
        // A blank cell means "still unassigned", which is meaningful — keep it.
        settings.codes[key.slice(5)] = raw
        continue
      }
      if (!raw) continue
      switch (key) {
        case 'sixDayRate': settings.rules.sixDayRate = toNum(raw, DEFAULT_RULES.sixDayRate); break
        case 'sixDayMinDays': settings.rules.sixDayMinDays = toNum(raw, DEFAULT_RULES.sixDayMinDays); break
        case 'sixDayMinShiftHours': settings.rules.sixDayMinShiftHours = toNum(raw, DEFAULT_RULES.sixDayMinShiftHours); break
        case 'sixDayMinFloorHours': settings.rules.sixDayMinFloorHours = toNum(raw, DEFAULT_RULES.sixDayMinFloorHours); break
        case 'sd3SixDayMinDays': settings.rules.sd3SixDayMinDays = toNum(raw, DEFAULT_RULES.sd3SixDayMinDays); break
        case 'sd3SixDayMinTotalHours': settings.rules.sd3SixDayMinTotalHours = toNum(raw, DEFAULT_RULES.sd3SixDayMinTotalHours); break
        case 'sixDayMode':
          if (raw === 'net' || raw === 'add' || raw === 'reportOnly') settings.rules.sixDayMode = raw
          break
        case 'breakMaxMinutes': settings.rules.breakMaxMinutes = toNum(raw, DEFAULT_RULES.breakMaxMinutes); break
        case 'breakMode':
          if (raw === 'off' || raw === 'foldFloorHours' || raw === 'separateCode' || raw === 'reportOnly') {
            settings.rules.breakMode = raw
          }
          break
        case 'otThresholdHours': settings.rules.otThresholdHours = toNum(raw, DEFAULT_RULES.otThresholdHours); break
        case 'varianceAlertPct': settings.rules.varianceAlertPct = toNum(raw, DEFAULT_RULES.varianceAlertPct); break
        case 'bonusPaycheckOfMonth': settings.rules.bonusPaycheckOfMonth = toNum(raw, DEFAULT_RULES.bonusPaycheckOfMonth); break
        case 'payDateOffsetDays': settings.rules.payDateOffsetDays = toNum(raw, DEFAULT_RULES.payDateOffsetDays); break
      }
    }
  } catch {
    // tab absent → defaults stand
  }

  // ── salon table ──
  try {
    const rows = rowsToObjects(await readSheet(ADP_SALONS_TAB))
    const fromSheet: Record<string, { coCode: string; batchId: string }> = {}
    for (const r of rows) {
      const salonNum = String(r.salonNum ?? '').trim()
      const batchId = String(r.batchId ?? '').trim()
      const coCode = String(r.coCode ?? '').trim()
      if (!salonNum || !batchId || !coCode) continue
      fromSheet[salonNum] = { coCode, batchId }
    }
    // Only replace wholesale when the tab actually has rows, so a half-written
    // tab can't quietly drop salons out of the upload.
    if (Object.keys(fromSheet).length > 0) settings.salons = fromSheet
  } catch {
    // tab absent → defaults stand
  }

  return settings
}
