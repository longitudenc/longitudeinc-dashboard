import { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import EmailProvider from 'next-auth/providers/email'

export type UserRole = 'admin' | 'am' | 'viewer' | 'stylist'

async function getUserRecord(email: string) {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key || url.includes('placeholder')) return null
    const supabase = createClient(url, key)
    const { data } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single()
    return data || null
  } catch {
    return null
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || 'placeholder',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'placeholder',
    }),
    EmailProvider({
      from: process.env.RESEND_FROM_EMAIL || 'noreply@longitudeinc.net',
      sendVerificationRequest: async ({ identifier: email, url }) => {
        try {
          const { Resend } = await import('resend')
          const resend = new Resend(process.env.RESEND_API_KEY)
          await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'noreply@longitudeinc.net',
            to: email,
            subject: 'Sign in to Longitude Inc Dashboard',
            html: `<p>Click <a href="${url}">here</a> to sign in to Longitude Inc Dashboard. Link expires in 1 hour.</p>`,
          })
        } catch (e) {
          console.error('Email send failed:', e)
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false
      const record = await getUserRecord(user.email)
      return !!record
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const record = await getUserRecord(user.email)
        if (record) {
          token.role = record.role
          token.amId = record.am_id
          token.globalId = record.global_id
          token.appName = record.name
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role
        ;(session.user as any).amId = token.amId
        ;(session.user as any).globalId = token.globalId
        ;(session.user as any).appName = token.appName
      }
      return session
    },
  },
  pages: { signIn: '/login', error: '/login', verifyRequest: '/login?verify=1' },
  session: { strategy: 'jwt' },
}
