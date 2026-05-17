import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _supabaseAdmin: SupabaseClient | null = null

export function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key || url.includes('placeholder')) {
      throw new Error('Supabase not configured')
    }
    _supabaseAdmin = createClient(url, key)
  }
  return _supabaseAdmin
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
