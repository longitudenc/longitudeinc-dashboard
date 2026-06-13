// app/api/auth/request-link/route.ts
//
// Step 1 of code login. Someone submits their email; if it belongs to a known
// person (resolveAccess != null), we issue a 6-digit code and email it via
// Resend.
//
// NOTE: by request, this endpoint now tells the caller when an email is NOT
// registered (so users know to ask a manager/AM to add them). This trades away
// the prior privacy property of not revealing which emails have accounts.
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

  if (!email || !email.includes('@')) {
    return NextResponse.json({ ok: false, reason: 'invalid', message: 'Enter a valid email address.' })
  }

  const access = await resolveAccess(email)
  if (!access) {
    // Per request: tell the user explicitly so they know to get their email added.
    return NextResponse.json({
      ok: false,
      reason: 'not_registered',
      message: "This email isn't registered. Please contact your manager or area manager to have your email added to the system.",
    })
  }

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

  return NextResponse.json({ ok: true, message: 'A sign-in code has been sent to your email.' })
}
