# Longitude Inc. Dashboard — Project Brief

Ops + HR dashboard for **Longitude Inc.**, a Great Clips franchisee running ~18 salons
in the greater Charlotte, NC metro. Owner/operator: Trey Bullard.

> **Read this first, every session.** It captures conventions and gotchas that aren't
> obvious from the code and that have caused real bugs.

---

## Stack & key facts

- **Framework:** Next.js 15.3.8 (App Router), deployed on **Vercel** (Hobby tier).
- **Repo:** `github.com/longitudenc/longitudeinc-dashboard`. **`main` auto-deploys** to Vercel.
- **Production:** https://www.longitudenc.com
- **Primary data store:** **Google Sheets** (Sheet ID `1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE`). Most "tables" are tabs in this sheet.
- **Operational source:** **SD3 / SalonData** (`reports.salondata.com`) — scraped nightly.
- **Email:** **Resend**, from `noreply@mail.longitudenc.com` (DKIM/SPF done). `RESEND_API_KEY` is set in Vercel; `resend` is already a dependency.
- **Secret:** `CRON_SECRET` guards the scraper/cron/import trigger URLs (`?secret=` or a
  `Bearer` header). The value lives in Vercel env vars and in the repo’s Actions secrets —
  deliberately not written down here. Read it from Vercel if you need it locally.
- **Brand:** pine `#03654e`, jade `#048667`, lime accent `#9acb3a`. Logos in `public/` (`longitude-header.png`, `longitude-badge.png`). Tagline: "A Great Clips Franchisee".
- **The owner is not a heavy terminal user.** Prefer having the agent run commands, commit, and push directly rather than handing back manual steps.

## Deploy workflow

Edit → **commit → push to `main`** → Vercel auto-rebuilds → hard-refresh the browser.
Backend `.ts` changes need a full Vercel rebuild (a minute or two). The client is one
big static file (`public/dashboard.html`); its changes are live on refresh after deploy.

## Validate before committing (this catches most breakage)

- **TypeScript routes/libs:** `npx esbuild@0.23.0 <file> --format=esm` (syntax check).
- **`public/dashboard.html` inline `<script>` blocks:** extract each and `node --check`.
- After editing a route, if a trigger 404s, **verify the file path on the deployed branch**
  (`https://raw.githubusercontent.com/longitudenc/longitudeinc-dashboard/main/<path>`) —
  route files have historically landed one folder level off.

---

## Architecture map

**Navigation (in transition):** a top bar (`#topnav`, `renderTopNav`) groups screens by
WHAT — Home / Performance / Pay / People / Requests / ⚙ — with `page-hub` rendering a
group's destination cards, capability-gated. It routes into the SAME functions the
sidebar calls, so the two cannot disagree. **The sidebar is still live and unchanged**;
remove it only once the top bar has earned it. The hub deliberately shows NO company
KPI tiles: recomputing aggregates there would be a second implementation of numbers
that get scored and paid against.

**Client:** `public/dashboard.html` (~14,900 lines, single file — HTML + CSS + JS). This is
the whole authenticated app: home, salon/AM/company views, bonuses, reviews, forms, points.
Edited surgically; validate the inline scripts after each change.

**Public landing:** `app/page.tsx` (marketing front page; "Team sign-in" → `/dashboard.html`).

**Auth:** magic-link (`app/api/auth/*`, `lib/auth-roles.ts`, `lib/require-role.ts`).
`resolveAccess(email)` maps an email to a role. Roles: `owner`, `admin`, `viewer`,
`area_manager`, `manager`, `stylist`, plus scoped `office` and `maintenance`. Owner/admin
see everything; AMs are scoped to their salons (`access.salons`).

**Sheets layer:** `lib/sheets.ts`. `readSheet`/`writeSheet`/`appendSheet`/`upsertSheet`.
Has a short-lived in-memory read cache (see gotchas). `getAllData` is the big dashboard
payload (cached 3 min, sent to browsers — **never put PII in it**).

**Home:** `app/api/home/route.ts` + `lib/home.ts` (announcements / important dates / quick
links, role-filtered) and `getCelebrations` (auto anniversaries/birthdays/new-hires from
`EmployeeProfile`). Client renderer: `paintHome()` in `dashboard.html` ("Coming up" grouped
into Events / Birthdays / Anniversaries / New Hires; Events out ~1 month, auto out ~2 weeks).

**Forms system:** `lib/forms.ts` + `app/api/forms/*`. Tabs: `FormDefs`, `FormFields`,
`FormSubmissions`, `FormComments`. Each form has `audience` (who can submit), `responseView`
+ `notify` (tag lists: `am` / `office` / `maintenance` / `owner` / literal emails), and
`workflow` (`ticket` / `approval` / `record` / blank). Notify emails fire on submit and on
each comment via `lib/notify.ts` (deep-links to `/?req=<submissionId>`).

**Disciplinary points:** `DiscPoints` tab (`eventId | globalId | employeeName | points |
date | reason | addedAt`). The `discipline` form writes one event per violation via
`lib/disc-points.ts`. `activeDiscPoints(gid, periodKey)` sums a rolling 12-month window and
feeds bonus (≥4 blocks bonus) and raise (≥6) eligibility. Client "Points" tab surfaces it.

**Scrapers:** `app/api/scrape/*` (thin routes) → `lib/scrape-runner.ts` (the work).
The nightly schedule lives in **`lib/scrape-plan.ts`** and is served by `/api/cron/plan`;
`.github/workflows/scrape.yml` (08:00 UTC, ~4 AM ET) fetches that plan and fires each job
as its own request, so every job gets a fresh 60s Hobby budget. Saturday weekly also has a
dedicated Vercel cron (`/api/cron/weekly`). Profile scraper runs nightly and captures
`dateOfHire`, `birthday` (**month-day only**) and `phone`.

> **Departed employees are NOT removed from `EmployeeProfile`.** The scrape keeps the
> row and flips `inactive` to `true` — 118 of 245 rows on 2026-08-28, going back to
> Jan 2025. `resolveAccess` refuses them (it did not until 2026-08-28, so every leaver
> had a working magic link). Anything else reading that tab must filter `inactive`
> too, or it is counting leavers: that is why the roster looked like 227 stylists.

> **To add a nightly data point:** build the `/api/scrape/<name>` endpoint, then add one
> line to the matching group in `lib/scrape-plan.ts`. The workflow picks it up
> automatically — never edit the YAML to add a scrape.

**Scrape alerting:** a failing job makes the run red and GitHub emails you. A run that
never fires is caught by the Healthchecks.io heartbeat, which is pinged only on a fully
clean run — that is the case a red-run email cannot cover. `lib/alert.ts` / `ALERT_EMAIL`
is a separate path used only by `/api/cron/weekly` and `/api/report/payroll-pace`; the
`/api/scrape/*` routes do not call it.

---

## Gotchas & hard-won rules (violating these has caused bugs)

- **Sheets read cache** (`lib/sheets.ts`, marker `SHEETS-READ-CACHE-v1`): reads are cached
  ~15s per instance to survive Google's per-minute quota. **`NO_CACHE_TABS`** (Announcements,
  ImportantDates, HomeLinks, HomeData, FormSubmissions, FormDefs, FormFields) are never
  cached. **Any read-modify-write must read fresh** (`readSheet(tab, undefined, {fresh:true})`)
  or it can clobber concurrent edits. Writes invalidate their tab.
- **Auth reads Users first:** `resolveAccess` reads the `Users` tab alone and returns early
  for owner/admin/viewer; only employees trigger the heavier employee-table reads. Keep it
  that way — reading all tables on every request tripped the rate limit hard.
- **Form option lists cannot contain commas.** The engine splits `options` on `|`, `;`, AND
  `,`. Use ` / ` where a comma would read naturally.
- **NR/RR are never summed.** SD3 computes them retroactively over a rolling 105-day window;
  only SD3's pre-computed weekly CSV is accurate. `***` = insufficient sample → treat as N/A.
- **Fiscal calendar:** weeks run Sat→Fri; fiscal week 1 ends the first Friday of January.
- **Some fields need the month-window `mg` payload** (serviceDiscounts, redoAmount,
  receptionistPay, nonCutWithCustWaitingMinutes) — they cannot be reconstructed by summing
  weekly rows. "What you see must equal what's scored/paid."
- **PII:** `EmployeeProfile` holds `email` (auth only) and `birthday` (**MM-DD only, no year**).
  Neither is included in `getAllData`; birthday is used server-side only to generate the
  "[Name] — Birthday" celebration.
- **Import/seed routes are triggered by a one-time POST** after deploy (they rewrite sheet
  tabs), e.g. `fetch('/api/forms/import-discipline', {method:'POST'}).then(r=>r.json()).then(console.log)`.
- **Owner/admin logins have no `globalId`** (they're Users-tab rows, not roster employees).
  Code that matches "mine"/an employee must also match by email, not just globalId.
- **Capabilities, not role lists.** `lib/capabilities.ts` holds named capabilities
  (`view.company`, `view.dayreview`, `view.dayofweek`, `view.market`, `view.salondata`,
  `view.payroll`, `edit.settings`, `manage.access`) with role defaults in code and
  per-person exceptions on the **`Capabilities`** tab (deviations only). Gate routes with
  `requireCapability(cap)`; the client mirrors it via `hasCap()` from `/api/auth/me`.
  **Capabilities are FEATURES, not rows** — `lib/scope-filter.ts` still trims data to
  `access.salons`, so a grant never widens which salons someone sees. Do not add a
  capability before something enforces it: a toggle that does nothing is worse than none.
- **Every data route needs a guard, and reads need scoping.** `lib/require-role.ts`
  exports `requireOwner` / `requireAdmin` / `requireOffice` / `requireSalonView` /
  `requireSignedIn`; anything returning salon or employee rows must ALSO scope through
  `lib/scope-filter.ts`. Four routes shipped with no gate at all and served company-wide
  data to the open internet until 2026-08-28 (`/api/gs/getDailyRange` was the live one).
  **A filter applied in `dashboard.html` is not a filter.** Market-wide data
  (`MarketWeekly`, other operators' salons) is `requireMarketView` (owner/admin/viewer/
  office — deliberately NOT `requireOffice`, which gates the ADP payroll builder); our own
  salons' ratings and CAQ are `requireSalonView` (manager and up).

---

## Current state (recently shipped)

- **Forms:** full interactive layer — comment threads, per-form `workflow` button sets,
  notify emails (Resend) with deep links, a per-form "all responses" spreadsheet + CSV export,
  and `office`/`maintenance` logins that land straight on their jobs (Requests).
- **Disciplinary points:** native `discipline` form → `DiscPoints` tracker → a scoped "Points"
  tab (active total, 4/6 flags, per-person history, search/date filters, CSV).
- **Home:** rebuilt as the "Warm & Human" design, per-person, with auto-populated celebrations.
- **Four new forms added:** `leave-of-absence`, `performance-checkin`, `redo`, `donation`
  (import route currently at `app/api/import-more/route.ts` — should be moved under
  `app/api/forms/import-more/` for consistency).

## Open roadmap (not built yet)

- **Performance Check-In follow-up reminders:** the form has a `nextCheckIn` date; build a
  daily job that emails **office + the salon's AM + the manager (submitter)** as it approaches.
- **Favorites → Quick Links:** let each person pin views to a personal shortcuts strip
  (needs small per-user storage, e.g. a `Favorites` tab keyed by login).
- **"View as":** admin toggle to render the dashboard as a given role/person (impersonation).
  Must be resolved SERVER-side (swap the Access that `resolveAccess` returns), not by
  faking the role in the client — a client-only version proves nothing about whether the
  APIs actually withhold data, which is the main reason to want it.
- **Supabase migration:** move high-volume tables (sd_demand, sd_halfhour, sd_daily,
  sd_shifts, sd_chkinout) off Sheets; everything else stays.
- **Bonus OT true-up — confirm the method with counsel/ADP before the first live run.**
  Built and tested, but never run against a real bonus month. ADP does NOT recalculate
  overtime on a bonus (confirmed with the owner), so `lib/adp-payroll.ts` does it:
  `(bonus ÷ hours in period) × ½ × OT hours in period`, hours from `SD_PAYROLL` merged
  across salons, folded into the overtime line and reported separately. Referral bonuses
  are the only hand-keyed line that counts toward a week's own rate (`otEligible`).
- **Vacation-hours tracking (payroll):** SD3 reports vacation HOURS but pays $0.00 for
  them, and nothing tracks accrual or the remaining balance. Office Tools already sends
  vacation to ADP on code 14 at the person's base wage; what's missing is a per-employee
  balance (accrued / taken / left) the office can see and the ADP build can check a week's
  vacation hours against. Likely a `VacationBalance` tab plus a panel in Office Tools.
- Newsletter automation, market-compare resolver overrides (salons 4138/5770/9085).
