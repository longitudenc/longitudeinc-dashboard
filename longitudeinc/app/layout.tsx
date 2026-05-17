import type { Metadata } from 'next'
import { Inter, Outfit } from 'next/font/google'
import { SessionProvider } from '@/components/SessionProvider'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit' })

export const metadata: Metadata = {
  title: 'Longitude Inc — Dashboard',
  description: 'Area Manager Performance Dashboard',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${outfit.variable}`}>
        <SessionProvider>
          {children}
        </SessionProvider>
      </body>
    </html>
  )
}
