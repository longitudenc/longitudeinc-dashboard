# Longitude Inc — AM Dashboard

A Next.js application hosted on Vercel with Supabase as the database.

## Setup Instructions

### 1 . Clone and install

```bash
git clone https://github.com/YOUR\_USERNAME/longitudeinc-dashboard.git
cd longitudeinc-dashboard
npm install
```

### 2\. Set up Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. In the SQL editor, run the contents of `supabase-schema.sql`
3. Copy your project URL and API keys

### 3\. Set up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URIs:

   * `https://longitudeinc.net/api/auth/callback/google`
   * `http://localhost:3000/api/auth/callback/google` (for dev)

### 4\. Set up Resend (magic link emails)

1. Go to [resend.com](https://resend.com) and create account
2. Add and verify your domain `longitudeinc.net`
3. Copy your API key

### 5\. Environment variables

Copy `.env.example` to `.env.local` and fill in all values:

```bash
cp .env.example .env.local
```

Generate NEXTAUTH\_SECRET:

```bash
openssl rand -base64 32
```

### 6\. Run locally

```bash
npm run dev
```

### 7\. Deploy to Vercel

1. Push to GitHub
2. In Vercel, import the repository
3. Add all environment variables from `.env.local`
4. Deploy

### 8\. Connect your domain

In Vercel project settings → Domains → Add `longitudeinc.net`
Follow the DNS instructions shown (add CNAME/A record at your registrar)

## Architecture

```
longitudeinc.net
├── /              → Landing page (coming soon)
├── /login         → Sign in (Google OAuth or magic link)
├── /dashboard     → AM Dashboard (current app, ported)
├── /my            → Employee self-service portal
└── /admin         → Admin tools
```

## Data Flow

```
CSV uploads → /api/upload → parse → Supabase
Google Sheets (legacy) → /api/migrate → Supabase
Scrapers (future) → Supabase → Dashboard
```

