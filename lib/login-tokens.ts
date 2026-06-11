// lib/login-tokens.ts
//
// One-time 6-digit sign-in codes. Each is stored in the LoginCodes sheet tab
// with the email it's for, an expiry, an attempt counter, and a used flag.
//
// LoginCodes schema:
//   code | email | expiresAt (ISO) | attempts | usedAt (ISO or '') | createdAt
//
// Rules:
//   - 6-digit numeric code (100000-999999).
//   - 15-minute expiry (CODE_TTL_MIN).
//   - Single-use: verifying successfully sets usedAt.
//   - 5 wrong attempts (MAX_ATTEMPTS) locks THAT code - the person requests a
//     new one. Brute force is impractical anyway (1-in-1,000,000 per code,
//     15-min window, single-use).
//
// SECURITY: email is the only PII; this tab is server-only, never sent to the
// browser, never logged.

import crypto from 'crypto'
import { readSheet, upsertSheet, rowsToObjects } from './sheets'

const TAB = 'LoginCodes'
const HEADERS = ['code', 'email', 'expiresAt', 'attempts', 'usedAt', 'createdAt']
export const CODE_TTL_MIN = 15
export const MAX_ATTEMPTS = 5

// Cryptographically-random 6-digit code as a string (always 100000-999999 so
// it's always 6 digits).
export function newCode(): string {
  const n = 100000 + crypto.randomInt(0, 900000)
  return String(n)
}

// Create + store a code for an email. Returns the code (to email to them).
// Keyed on email so a new request replaces the person's previous code.
export async function issueCode(email: string): Promise<string> {
  const e = String(email).trim().toLowerCase()
  const code = newCode()
  const now = new Date()
  const expires = new Date(now.getTime() + CODE_TTL_MIN * 60 * 1000)
  await upsertSheet(TAB, HEADERS, ['email'], [
    {
      code,
      email: e,
      expiresAt: expires.toISOString(),
      attempts: '0',
      usedAt: '',
      createdAt: now.toISOString(),
    },
  ])
  return code
}

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'locked' | 'used' }

// Verify a submitted code for an email. On success marks it used and returns
// the email. Wrong codes increment attempts; at MAX_ATTEMPTS the code locks.
export async function verifyCode(email: string, code: string): Promise<VerifyResult> {
  const e = String(email).trim().toLowerCase()
  const c = String(code || '').trim()
  if (!e || !c) return { ok: false, reason: 'invalid' }

  let rows: any[] = []
  try {
    rows = rowsToObjects(await readSheet(TAB))
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  const row = rows.find((r: any) => String(r.email).trim().toLowerCase() === e)
  if (!row) return { ok: false, reason: 'invalid' }
  if (String(row.usedAt || '').trim()) return { ok: false, reason: 'used' }

  const attempts = parseInt(String(row.attempts || '0'), 10) || 0
  if (attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' }

  const exp = new Date(String(row.expiresAt))
  if (isNaN(exp.getTime()) || exp.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  if (String(row.code).trim() === c) {
    await upsertSheet(TAB, HEADERS, ['email'], [
      { ...row, usedAt: new Date().toISOString() },
    ])
    return { ok: true, email: e }
  }

  const next = attempts + 1
  await upsertSheet(TAB, HEADERS, ['email'], [
    { ...row, attempts: String(next) },
  ])
  return { ok: false, reason: next >= MAX_ATTEMPTS ? 'locked' : 'invalid' }
}
