import { createClient } from '@supabase/supabase-js'

// Public client (for browser)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// Admin client (server-side only)
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Database Types ────────────────────────────────────────────

export interface SalonWeekRow {
  id: string
  week_ending: string         // ISO date
  salon_num: string
  salon_name: string
  sales_last: number
  sales_this: number
  sales_growth: number
  cc_last: number
  cc_this: number
  cc_growth: number
  nr: number                  // new return %
  rr: number                  // repeat return %
  product: number             // product %
  payroll: number             // payroll %
  waits: number               // wait times > 15min %
  ss_waits: number            // sat/sun wait times %
  hc_time: number             // avg haircut time
  cph: number                 // cuts per hour
  mbc: number                 // avg MBC
  created_at: string
}

export interface EmployeeWeekRow {
  id: string
  week_ending: string
  salon_num: string
  emp_name: string
  global_id: string
  position: string
  floor_hours: number
  cust_count: number
  hc_time: number
  cph: number
  product: number
  mbc: number
  payroll: number
  nr: number
  rr: number
  created_at: string
}

export interface BonusPeriodRow {
  id: string
  period_key: string          // e.g. 'Apr 26'
  period_end: string          // ISO date
  weeks_n: number
  salon_num: string
  emp_name: string
  global_id: string
  pay_id: string
  position: string
  floor_hours: number
  avg_wk_hrs: number
  cust_count: number
  hc_time: number
  cph: number
  product: number
  mbc: number
  payroll: number
  nr: number
  rr: number
  points: number
  potential: number
  per_pt: number
  payout: number
  prod_penalty: boolean
  eligible: boolean
  tier: string
  created_at: string
}

export interface SalonSummaryRow {
  id: string
  period_key: string
  period_end: string
  weeks_n: number
  salon_num: string
  total_sales: number
  avg_weekly_sales: number
  total_cc: number
  avg_weekly_cc: number
  floor_hours: number
  avg_weekly_floor_hours: number
  cph: number
  payroll_pct: number
  recept_pct: number
  adj_payroll_pct: number
  waits: number
  ss_waits: number
  mbc: number
  product_pct: number
  nr: number
  rr: number
  created_at: string
}

export interface PayrollConsolidatedRow {
  id: string
  period_key: string
  period_end: string
  weeks_n: number
  global_id: string
  emp_name: string
  total_floor: number
  total_vac: number
  total_hol: number
  total_sick: number
  total_hrs: number
  avg_weekly_floor: number
  avg_weekly_vac_hol: number
  avg_weekly_qualifying: number
  created_at: string
}

export interface UserRow {
  id: string
  email: string
  name: string
  role: 'admin' | 'am' | 'viewer' | 'stylist'
  am_id?: string
  global_id?: string
  created_at: string
  last_login?: string
}

export interface ManagerAssignmentRow {
  salon_num: string
  manager_name: string
  global_id: string
  updated_at: string
}

export interface PenaltyWaiverRow {
  id: string
  salon_num: string
  period: string
  payroll: boolean
  hours: boolean
  notes: string
  created_at: string
}
