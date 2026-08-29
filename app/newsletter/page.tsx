// app/newsletter/page.tsx
//
// NEWSLETTER-REDIRECT-v1
//
// Clean URL: /newsletter -> the hosted newsletter app in public/newsletter.html
// (mirrors how app/page.tsx redirects to /dashboard.html).

import { redirect } from 'next/navigation'

export default function Newsletter() {
  redirect('/newsletter.html')
}
