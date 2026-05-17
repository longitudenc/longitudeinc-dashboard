import { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import EmailProvider from 'next-auth/providers/email'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// User roles
export type UserRole = 'admin' | 'am' | 'viewer' | 'stylist'

export interface AppUser {
  id: string
  email: string
  name: string
  role: UserRole
  amId?: string        // for AM role — 'cassi' | 'dawn' | etc.
  globalId?: string    // for stylist role — links to employee data
}

async function getUserRecord(email: string): Promise<AppUser | null> {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase())
    .single()
  return data || null
}

export const authOptions: NextAuthOptions = {
  providers: [
    // Google OAuth — for AMs and admins (they have Google Workspace accounts)
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),

    // Magic Link — for stylists and anyone without Google account
    EmailProvider({
      from: process.env.RESEND_FROM_EMAIL!,
      sendVerificationRequest: async ({ identifier: email, url }) => {
        const { Resend } = await import('resend')
        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!,
          to: email,
          subject: 'Sign in to Longitude Inc Dashboard',
          html: magicLinkEmail(url),
        })
      },
    }),
  ],

  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false
      const record = await getUserRecord(user.email)
      // Only allow registered users
      return !!record
    },

    async jwt({ token, user }) {
      if (user?.email) {
        const record = await getUserRecord(user.email)
        if (record) {
          token.role = record.role
          token.amId = record.amId
          token.globalId = record.globalId
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

  pages: {
    signIn: '/login',
    error: '/login',
    verifyRequest: '/login?verify=1',
  },

  session: { strategy: 'jwt' },
}

function magicLinkEmail(url: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 20px;">
      <div style="background: #1F3864; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">Longitude Inc</h1>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0;">Performance Dashboard</p>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 32px; border-radius: 0 0 8px 8px;">
        <h2 style="color: #1F3864; margin: 0 0 16px;">Your sign-in link</h2>
        <p style="color: #6b7280; margin: 0 0 24px;">Click the button below to sign in. This link expires in 1 hour.</p>
        <a href="${url}"
           style="display: inline-block; background: #1F3864; color: white; padding: 12px 28px;
                  border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px;">
          Sign In
        </a>
        <p style="color: #9ca3af; font-size: 12px; margin: 24px 0 0;">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    </body>
    </html>
  `
}
