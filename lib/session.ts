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

// Build the cookie value for an email.
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

// Set the session cookie (called from the verify route after success).
export async function setSession(email: string): Promise<void> {
  const jar = await cookies()
  jar.set(COOKIE_NAME, sessionValue(email), {
    httpOnly: true,                 // not readable by browser JS - blocks XSS theft
    secure: process.env.NODE_ENV === 'production', // HTTPS-only in prod
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_DAYS * 24 * 60 * 60,
  })
}

// Read the current session's email from the cookie, or null if not signed in.
export async function getSessionEmail(): Promise<string | null> {
  const jar = await cookies()
  const c = jar.get(COOKIE_NAME)
  return readSessionValue(c?.value)
}

// Clear the session (logout).
export async function clearSession(): Promise<void> {
  const jar = await cookies()
  jar.delete(COOKIE_NAME)
}
