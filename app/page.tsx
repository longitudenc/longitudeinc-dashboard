import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export default async function Home() {
  const session = await getServerSession(authOptions)

  if (session) {
    const role = (session.user as any)?.role
    if (role === 'stylist') redirect('/my')
    else redirect('/dashboard')
  }

  redirect('/login')
}
