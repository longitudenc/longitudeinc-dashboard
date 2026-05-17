-- ============================================================
-- Longitude Inc Dashboard — Supabase Schema
-- Run this in Supabase SQL editor to set up all tables
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── Users ────────────────────────────────────────────────────
create table if not exists users (
  id          uuid primary key default uuid_generate_v4(),
  email       text unique not null,
  name        text not null,
  role        text not null check (role in ('admin','am','viewer','stylist')),
  am_id       text,           -- 'cassi' | 'dawn' | etc. for AM role
  global_id   text,           -- employee global ID for stylist role
  created_at  timestamptz default now(),
  last_login  timestamptz
);

-- Seed initial users (update emails as needed)
insert into users (email, name, role) values
  ('longitudenc@gmail.com', 'Admin', 'admin')
on conflict (email) do nothing;

-- ── Salon Weekly Data ─────────────────────────────────────────
create table if not exists salon_weeks (
  id            uuid primary key default uuid_generate_v4(),
  week_ending   date not null,
  salon_num     text not null,
  salon_name    text,
  sales_last    numeric,
  sales_this    numeric,
  sales_growth  numeric,
  cc_last       numeric,
  cc_this       numeric,
  cc_growth     numeric,
  nr            numeric,
  rr            numeric,
  product       numeric,
  payroll       numeric,
  waits         numeric,
  ss_waits      numeric,
  hc_time       numeric,
  cph           numeric,
  mbc           numeric,
  created_at    timestamptz default now(),
  unique (week_ending, salon_num)
);

create index if not exists idx_salon_weeks_salon on salon_weeks(salon_num);
create index if not exists idx_salon_weeks_date on salon_weeks(week_ending desc);

-- ── Employee Weekly Data ──────────────────────────────────────
create table if not exists employee_weeks (
  id            uuid primary key default uuid_generate_v4(),
  week_ending   date not null,
  salon_num     text not null,
  emp_name      text,
  global_id     text,
  position      text,
  floor_hours   numeric,
  cust_count    numeric,
  hc_time       numeric,
  cph           numeric,
  product       numeric,
  mbc           numeric,
  payroll       numeric,
  nr            numeric,
  rr            numeric,
  created_at    timestamptz default now(),
  unique (week_ending, salon_num, global_id)
);

create index if not exists idx_emp_weeks_global on employee_weeks(global_id);
create index if not exists idx_emp_weeks_date on employee_weeks(week_ending desc);

-- ── Bonus Period Data ─────────────────────────────────────────
create table if not exists bonus_periods (
  id            uuid primary key default uuid_generate_v4(),
  period_key    text not null,
  period_end    date,
  weeks_n       integer,
  salon_num     text,
  emp_name      text,
  global_id     text,
  pay_id        text,
  position      text,
  floor_hours   numeric,
  avg_wk_hrs    numeric,
  cust_count    numeric,
  hc_time       numeric,
  cph           numeric,
  product       numeric,
  mbc           numeric,
  payroll       numeric,
  nr            numeric,
  rr            numeric,
  points        numeric,
  potential     numeric,
  per_pt        numeric,
  payout        numeric,
  prod_penalty  boolean,
  eligible      boolean,
  tier          text,
  created_at    timestamptz default now(),
  unique (period_key, salon_num, global_id)
);

create index if not exists idx_bonus_global on bonus_periods(global_id);
create index if not exists idx_bonus_period on bonus_periods(period_key);

-- ── Salon Summary (Manager Bonus source) ──────────────────────
create table if not exists salon_summaries (
  id                    uuid primary key default uuid_generate_v4(),
  period_key            text not null,
  period_end            date,
  weeks_n               integer,
  salon_num             text not null,
  total_sales           numeric,
  avg_weekly_sales      numeric,
  total_cc              numeric,
  avg_weekly_cc         numeric,
  floor_hours           numeric,
  avg_weekly_floor_hrs  numeric,
  cph                   numeric,
  payroll_pct           numeric,
  recept_pct            numeric,
  adj_payroll_pct       numeric,
  waits                 numeric,
  ss_waits              numeric,
  mbc                   numeric,
  product_pct           numeric,
  nr                    numeric,
  rr                    numeric,
  created_at            timestamptz default now(),
  unique (period_key, salon_num)
);

-- ── Payroll Consolidated ──────────────────────────────────────
create table if not exists payroll_consolidated (
  id                      uuid primary key default uuid_generate_v4(),
  period_key              text not null,
  period_end              date,
  weeks_n                 integer,
  global_id               text not null,
  emp_name                text,
  total_floor             numeric,
  total_vac               numeric,
  total_hol               numeric,
  total_sick              numeric,
  total_hrs               numeric,
  avg_weekly_floor        numeric,
  avg_weekly_vac_hol      numeric,
  avg_weekly_qualifying   numeric,
  created_at              timestamptz default now(),
  unique (period_key, global_id)
);

create index if not exists idx_payroll_global on payroll_consolidated(global_id);

-- ── Manager Assignments ───────────────────────────────────────
create table if not exists manager_assignments (
  salon_num     text primary key,
  manager_name  text,
  global_id     text,
  updated_at    timestamptz default now()
);

-- ── Penalty Waivers ───────────────────────────────────────────
create table if not exists penalty_waivers (
  id          uuid primary key default uuid_generate_v4(),
  salon_num   text not null,
  period      text not null,
  payroll     boolean default false,
  hours       boolean default false,
  notes       text,
  created_at  timestamptz default now(),
  unique (salon_num, period)
);

-- ── Home Department (Employee Master) ────────────────────────
create table if not exists home_department (
  id              uuid primary key default uuid_generate_v4(),
  payroll_name    text,
  global_id       text unique,
  file_num        text,
  home_salon      text,
  effective_date  date,
  base_wage       numeric,
  loaded_at       timestamptz default now()
);

create index if not exists idx_home_global on home_department(global_id);
create index if not exists idx_home_salon on home_department(home_salon);

-- ── Row Level Security ────────────────────────────────────────
-- Users can only read their own data; admins read everything
alter table users enable row level security;
alter table salon_weeks enable row level security;
alter table employee_weeks enable row level security;
alter table bonus_periods enable row level security;

-- Service role bypasses RLS (used by server-side API routes)
-- Client-side access controlled through API routes, not direct DB access

-- ── NextAuth adapter tables ───────────────────────────────────
-- Magic link tokens stored here
create table if not exists verification_tokens (
  identifier  text not null,
  token       text not null,
  expires     timestamptz not null,
  primary key (identifier, token)
);

create table if not exists accounts (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid references users(id) on delete cascade,
  type                text not null,
  provider            text not null,
  provider_account_id text not null,
  refresh_token       text,
  access_token        text,
  expires_at          integer,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  unique (provider, provider_account_id)
);

create table if not exists sessions (
  id            uuid primary key default uuid_generate_v4(),
  session_token text unique not null,
  user_id       uuid references users(id) on delete cascade,
  expires       timestamptz not null
);
