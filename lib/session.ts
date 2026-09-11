// lib/session.ts
//
// Session cookie handling. After someone verifies their code, we set a signed
// cookie identifying them. On later requests we read + verify that cookie to
// know who they are (then resolveAccess gives their role/scope).
//
// The cookie value is "email.signature" where signature = HMAC-SHA256(email)
// using SESSION_SECRET. Because the signature requires the secret, the cookie
// can't be forged or tampered with - changing the email invalidates it.
//
// Requires env var SESSION_SECRET (any long random string). 30-day lifetime.

import crypto from 'crypto'
import { cookies } from 'next/headers'

const COOKIE_NAME = 'longitude_session'
const MAX_AGE_DAYS = 30

function secret(): string {
  return process.env.SESSION_SECRET || ''
}

function sign(email: string): string {
  return crypto.createHmac('sha256', secret()).update(email).digest('hex')
}

// Build the cookie value for an email. (Unstamped -- still used as-is by the
// View As cookie in lib/view-as.ts, which has no lifetime rule of its own.)
export function sessionValue(email: string): string {
  const e = String(email).trim().toLowerCase()
  return `${e}.${sign(e)}`
}

// Verify a cookie value, returning the email if the signature is valid.
export function readSessionValue(value: string | undefined): string | null {
  if (!value || !secret()) return null
  const idx = value.lastIndexOf('.')
  if (idx <= 0) return null
  const email = value.slice(0, idx)
  const sig = value.slice(idx + 1)
  const expected = sign(email)
  // constant-time compare to avoid timing leaks
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  return email
}

// ── SESSION-WEEKLY-v1 ──────────────────────────────────────────────────────
// A sign-in now carries WHEN it was issued: "email~issuedAtMs.signature", the
// signature covering both, so the date cannot be edited to extend a session.
// Managers and stylists must enter a fresh code every 7 days; everyone else
// keeps 30. The rule is checked on the server on every request (require-role,
// /api/auth/me) -- the cookie's own maxAge is only the browser's copy.
//
// A cookie from before this change has no date. For the weekly roles that
// counts as expired, so each of them signs in once more and is then on the
// weekly cycle; for everyone else it is honoured until its 30 days run out.
export const WEEKLY_ROLES = new Set(['manager', 'stylist'])
export const WEEKLY_SESSION_DAYS = 7

function stampedValue(email: string, issuedAt: number): string {
  const payload = `${String(email).trim().toLowerCase()}~${issuedAt}`
  return `${payload}.${sign(payload)}`
}

export interface SessionInfo { email: string; issuedAt: number | null }

/** Verify either cookie format. issuedAt is null for a pre-stamp cookie. */
export function readSession(value: string | undefined): SessionInfo | null {
  if (!value || !secret()) return null
  const idx = value.lastIndexOf('.')
  if (idx <= 0) return null
  const payload = value.slice(0, idx)
  const sig = value.slice(idx + 1)
  const expected = sign(payload)
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  const t = payload.lastIndexOf('~')
  if (t > 0 && /^\d+$/.test(payload.slice(t + 1))) {
    return { email: payload.slice(0, t), issuedAt: Number(payload.slice(t + 1)) }
  }
  return { email: payload, issuedAt: null }
}

/** True when this role's sign-in is too old to honour. */
export function sessionExpiredFor(role: string, issuedAt: number | null, now = Date.now()): boolean {
  if (!WEEKLY_ROLES.has(String(role))) return false
  if (issuedAt === null) return true
  return now - issuedAt > WEEKLY_SESSION_DAYS * 24 * 60 * 60 * 1000
}

export async function getSession(): Promise<SessionInfo | null> {
  const jar = await cookies()
  return readSession(jar.get(COOKIE_NAME)?.value)
}

// Set the session cookie (called from the verify route after success).
export async function setSession(email: string): Promise<void> {
  const jar = await cookies()
  jar.set(COOKIE_NAME, stampedValue(email, Date.now()), {
    httpOnly: true,                 // not readable by browser JS - blocks XSS theft
    secure: process.env.NODE_ENV === 'production', // HTTPS-only in prod
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_DAYS * 24 * 60 * 60,
  })
}

// Read the current session's email from the cookie, or null if not signed in.
export async function getSessionEmail(): Promise<string | null> {
  const s = await getSession()
  return s ? s.email : null
}

// Clear the session (logout).
export async function clearSession(): Promise<void> {
  const jar = await cookies()
  jar.delete(COOKIE_NAME)
}
