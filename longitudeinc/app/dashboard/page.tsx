import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { redirect } from 'next/navigation'

// The dashboard is currently served as the full HTML app
// During migration we serve the existing Index.html
// This will be progressively replaced with Next.js components

export default async function DashboardPage() {
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')

  return (
    <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'system-ui' }}>
      <h1 style={{ color: '#1F3864' }}>Dashboard loading...</h1>
      <p style={{ color: '#6b7280', marginTop: '8px' }}>
        Signed in as {session.user?.email}
      </p>
    </div>
  )
}
