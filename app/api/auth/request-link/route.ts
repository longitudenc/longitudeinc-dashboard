// app/api/auth/request-link/route.ts
//
// Step 1 of code login. Someone submits their email; if it belongs to a known
// person (resolveAccess != null), we issue a 6-digit code and email it via
// Resend.
//
// PRIVACY: the response is ALWAYS the same ("if that email is registered, a
// code was sent") whether or not the email is valid - so this endpoint can't
// be used to discover who has an account.
//
// POST body: { email: string }

import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { resolveAccess } from '@/lib/auth-roles'
import { issueCode, CODE_TTL_MIN } from '@/lib/login-tokens'

const FROM = 'Longitude Dashboard <noreply@mail.longitudenc.com>'

export async function POST(request: Request) {
  let email = ''
  try {
    const body = await request.json()
    email = String(body?.email || '').trim().toLowerCase()
  } catch {
    // fall through - empty email handled below
  }

  // Generic response for BOTH success and "unknown email", so we never reveal
  // which emails are valid.
  const generic = NextResponse.json({
    ok: true,
    message: 'If that email is registered, a sign-in code has been sent.',
  })

  if (!email || !email.includes('@')) return generic

  const access = await resolveAccess(email)
  if (!access) return generic // unknown - say nothing different

  try {
    const code = await issueCode(email)
    const resend = new Resend(process.env.RESEND_API_KEY)
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: `Your Longitude sign-in code: ${code}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
          <h2 style="color:#03654e;margin-bottom:4px;">Longitude Dashboard sign-in</h2>
          <p style="color:#444;">Enter this code to sign in:</p>
          <div style="font-size:34px;font-weight:700;letter-spacing:8px;color:#03654e;background:#eef6f2;border-radius:10px;padding:16px 0;text-align:center;margin:16px 0;">${code}</div>
          <p style="color:#777;font-size:13px;">This code expires in ${CODE_TTL_MIN} minutes and can only be used once. If you didn't request it, you can ignore this email.</p>
        </div>
      `,
    })
  } catch (e) {
    console.error('request-code send failed')
  }

  return generic
}
