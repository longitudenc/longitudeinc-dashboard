// lib/lease-settings.ts
// ---------------------------------------------------------------------------
// Settings for the Lease Manager, kept in a sheet rather than in environment
// variables.
//
// The alert recipients are the reason this exists. ALERT_EMAIL is the
// operational address — failed scrapes, health checks, payroll pace — and lease
// deadlines are a different audience: an owner, a bookkeeper, an attorney,
// changing over time. Putting them in an env var means a Vercel visit and a
// redeploy every time that list changes, which in practice means it stops being
// changed.
//
// Resolution order, most specific first:
//   1. the `alertEmail` row on this tab   (editable in the Lease Manager)
//   2. LEASE_ALERT_EMAIL                  (env, for a deploy-time default)
//   3. ALERT_EMAIL                        (env, the operational fallback)
//
// A blank tab value falls through rather than silencing the alert: "" is how a
// setting looks when it was never filled in, and an alert that quietly goes
// nowhere is the failure this whole feature exists to prevent.
// ---------------------------------------------------------------------------

import { readSheet, writeSheet, rowsToObjects } from '@/lib/sheets'

export const TAB_LEASE_SETTINGS = 'LeaseSettings'

const S = (v: unknown) => String(v ?? '').trim()

/** Only these keys are stored; anything else posted is ignored. */
export const SETTING_KEYS = ['alertEmail', 'alertNote'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

export type LeaseSettings = Record<string, string>

export async function readSettings(fresh = false): Promise<LeaseSettings> {
  try {
    const rows = rowsToObjects((await readSheet(TAB_LEASE_SETTINGS, undefined, { fresh })) || [])
    const out: LeaseSettings = {}
    for (const r of rows) {
      const k = S(r.key)
      if (k) out[k] = S(r.value)
    }
    return out
  } catch {
    return {}                    // tab absent — defaults stand
  }
}

export async function writeSettings(patch: LeaseSettings): Promise<LeaseSettings> {
  // Read fresh and merge: this tab is small but it IS read-modify-write.
  const current = await readSettings(true)
  for (const k of SETTING_KEYS) {
    if (patch[k] !== undefined) current[k] = S(patch[k])
  }
  const rows: any[][] = [['key', 'value']]
  for (const k of Object.keys(current).sort()) rows.push([k, current[k]])
  await writeSheet(TAB_LEASE_SETTINGS, rows)
  return current
}

/** Split a comma/semicolon/whitespace list into addresses that look like addresses. */
export function parseRecipients(raw: string): string[] {
  return S(raw)
    .split(/[,;\s]+/)
    .map(s => s.trim())
    .filter(s => s.includes('@') && s.length > 3)
}

export interface RecipientResolution {
  recipients: string[]
  /** Which layer supplied them, for the health/dry-run output. */
  source: 'lease settings' | 'LEASE_ALERT_EMAIL' | 'ALERT_EMAIL' | 'none'
}

/**
 * Who the lease alerts go to.
 *
 * Reports its SOURCE as well as the addresses. "No email arrived" and "the
 * email went to the wrong list" look identical from an inbox, and this is what
 * lets the dry run tell them apart.
 */
export async function leaseAlertRecipients(settings?: LeaseSettings): Promise<RecipientResolution> {
  const s = settings || (await readSettings())
  const fromTab = parseRecipients(s.alertEmail || '')
  if (fromTab.length) return { recipients: fromTab, source: 'lease settings' }

  const fromLease = parseRecipients(process.env.LEASE_ALERT_EMAIL || '')
  if (fromLease.length) return { recipients: fromLease, source: 'LEASE_ALERT_EMAIL' }

  const fromAlert = parseRecipients(process.env.ALERT_EMAIL || '')
  if (fromAlert.length) return { recipients: fromAlert, source: 'ALERT_EMAIL' }

  return { recipients: [], source: 'none' }
}

/** Local part masked, domain intact — safe to show in a JSON response. */
export function maskEmail(e: string): string {
  const at = e.indexOf('@')
  if (at < 1) return '(malformed)'
  return e.slice(0, Math.min(2, at)) + '***' + e.slice(at)
}
