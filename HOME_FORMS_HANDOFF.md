# Home & Forms — Session Handoff

> Companion to `LONGITUDE_PROJECT_CONTEXT.md`. That doc covers the whole project;
> this one covers **only** the Home page + Forms engine added in Aug 2026, what
> changed in existing code, and what's left to do.
>
> **Read §11 first** — it corrects several stale facts in the main context doc.

---

## 1. TL;DR

Two new surfaces were added to the dashboard:

- **Home** (`page-home`) — announcements, important dates, quick links. Now the
  landing page for every role that has a sidebar.
- **Forms** (`page-forms`) — a **schema-driven** form engine. Forms are defined
  in spreadsheet tabs, not in code. Adding a form or changing a field is a
  spreadsheet edit; no deploy, no code change.

Both are **spreadsheet-driven by design** so Trey can change content and forms
without a developer.

**Audience decision:** Area Managers fill out forms today. Managers come next.
The engine is already role-aware — when managers come online, widen the
`audience` cell in `FormDefs` and add a manager branch to `setupSidebar()`.
No re-architecture needed.

---

## 2. Baseline and commits

| Item | Value |
|---|---|
| Baseline (before this work) | `af6d7ed` — *Update payroll-pace.ts* |
| Commit 1 | `73cb9cf` — *Forms builder* |
| Commit 2 | `21a24ce` — *forms work* |
| Ctrl+F confirm string | `LONGITUDE-HOME-FORMS-V1` |

**Total diff vs baseline:** 11 files, **2353 insertions, 2 deletions**.

Regenerate the full diff any time:

```bash
git diff af6d7ed -- public/dashboard.html
```

---

## 3. Changes to EXISTING code

**Only one pre-existing file was modified: `public/dashboard.html`.** Everything
else is a brand-new file. Within that file, only **two lines** were genuinely
replaced — the rest is pure insertion at 8 points. Regression risk is low by
construction.

### 3.1 Landing page routing — `onDataLoaded()` (~line 4689)

The only behavioural change to existing logic.

**BEFORE**
```js
    setTimeout(()=>{
      if(isAMRole() && amId && AMS[amId]){
        switchAM(amId);
      } else if(canSeeAllSalons()){
        switchToCompany();
      } else if(role === 'manager' || role === 'stylist'){
```

**AFTER**
```js
    setTimeout(()=>{
      if(isAMRole() && amId && AMS[amId]){
        // Initialise the AM view first (sets S.currentAM and repositions the
        // sub-nav) so every code path that assumes currentAM is set after load
        // keeps working — then land on Home.
        switchAM(amId);
        switchToHome();
      } else if(canSeeAllSalons()){
        switchToHome();
      } else if(role === 'manager' || role === 'stylist'){
```

**Why `switchAM(amId)` is still called before `switchToHome()`:** several code
paths assume `S.currentAM` is set after load, and `switchAM` also repositions
`#am-subnav` under the active AM button. Dropping it would have been a subtle
regression. Owners/admins no longer auto-run `renderCompany()` on load, which is
a small speedup — it runs when they click Company.

**To revert Home-as-landing** (keep Home as a normal tab): change both
`switchToHome()` calls back to `switchAM(amId)` / `switchToCompany()`. The Home
sidebar button and page stay working.

### 3.2 Sidebar — `setupSidebar()` (~line 4747 and ~4811)

Two pure insertions. **Home** at the top, **Forms** at the bottom.

```js
  // Home — first item for every role that gets a sidebar at all.
  if(canSeeAllSalons() || isAMRole()){
    html += `<button class="am-btn" onclick="switchToHome()" id="btn-home">
      <div class="am-avatar" style="background:#e6f4ee;color:var(--primary);">&#127968;</div>Home
    </button>`;
    html += '<div style="border-top:1px solid var(--border);margin:.5rem 0;"></div>';
  }
```

```js
  // Forms — last, so it never pushes the performance views down. Shown to any
  // role that already has a sidebar (today: owner/admin/viewer + AMs). When the
  // manager branch is built this needs no change: which forms a role actually
  // sees is decided by the `audience` cell in the FormDefs tab, not here.
  if(html){
    html += '<div style="border-top:1px solid var(--border);margin:.5rem 0;"></div>';
    html += `<button class="am-btn" onclick="switchToForms()" id="btn-forms">
      <div class="am-avatar" style="background:#f2ecdd;color:#8a6d1f;">&#128221;</div>Forms
    </button>`;
  }

  sb.innerHTML = html;
```

**The `if(html)` guard matters.** `setupSidebar()` produces an empty string for
`manager` / `stylist` / `none` — those roles have no sidebar branch and land on
`page-comingsoon`. The guard stops an orphan Forms button appearing alone for
them. **When you build the manager portal, that guard is what lets Forms appear
automatically.**

### 3.3 Whitespace only

`function clearActive(){ ` → `function clearActive(){` (trailing space removed).
No behaviour change.

### 3.4 Pure insertions (no existing code touched)

| Location | What |
|---|---|
| ~line 334 (end of `<style>`) | ~110 lines of CSS for Home + Forms |
| ~line 3435 (before `</main>`) | `page-home` and `page-forms` markup |
| ~line 13754 (before `init();`) | ~640 lines: all Home + Forms JS |

---

## 4. New files

### Backend

| File | Purpose |
|---|---|
| `lib/forms.ts` | Forms schema, audience gating, **scoping rules**, validation, summary builder |
| `lib/home.ts` | Announcements / dates / links readers, date normalisation, `isSafeUrl` |
| `app/api/forms/defs/route.ts` | GET — form definitions visible to the caller's role |
| `app/api/forms/submit/route.ts` | POST — validate + append a submission |
| `app/api/forms/submissions/route.ts` | GET — role-scoped submissions |
| `app/api/forms/status/route.ts` | POST — review status change |
| `app/api/forms/seed/route.ts` | POST — **one-time setup**: creates tabs, seeds starter forms |
| `app/api/home/route.ts` | GET — homepage payload |
| `app/api/home/save/route.ts` | POST — admin editor for home content |

### Tooling

| File | Purpose |
|---|---|
| `scripts/migrate-google-forms.gs` | Apps Script — bulk-import Google Forms **or** spreadsheets into the engine |

### Frontend (all inside `public/dashboard.html`)

Key functions, all searchable by name:

```
switchToHome / renderHome / paintHome
openHomeEditor / closeHomeEditor / saveHomeItem / deleteHomeItem
audToggleAll / audToggleRole / audValue        // audience checkbox picker
switchToForms / loadForms / showFormsTab
renderFormsList / openForm / renderFormRunner / renderFormField
submitActiveForm / seedForms
formsEmployeeOptions / formsSalonOptions       // roster-backed pickers
submissionRows / submissionDetail / toggleSubmission / setSubStatus
renderMySubmissions / renderReviewQueue
hEsc                                            // HTML escaper — see §10
```

---

## 5. Data model — six new Google Sheets tabs

Same spreadsheet: `1uLjwGXzDc3jtmXkUn4yFiJiYlgx5SEs3zbdFWhwuGDE`

**`FormDefs`** — one row per form
```
formId | title | description | icon | audience | status | sortOrder
```

**`FormFields`** — one row per field
```
formId | fieldKey | label | type | required | options | placeholder | help | sortOrder
```
`options` is pipe-separated: `Time Off|Availability Change|Schedule Swap`

**`FormSubmissions`** — one row per submission
```
submissionId | formId | formTitle | submittedByEmail | submittedByGid | submittedByName |
salonNum | status | summary | dataJson | submittedAt | updatedAt | reviewedBy | reviewNote
```
`dataJson` holds answers; `summary` is a human-readable digest so the tab stays
legible in Sheets without parsing JSON.

**`Announcements`**
```
id | title | body | imageUrl | pinned | startDate | endDate | audience | createdBy | createdAt
```

**`ImportantDates`**
```
id | title | date | endDate | category | note | audience
```

**`HomeLinks`**
```
id | label | url | icon | category | sortOrder | audience
```

### The `audience` column (all six tabs)

Blank or `all` = everyone. Otherwise comma-separated roles:
`owner`, `admin`, `viewer`, `area_manager`, `manager`, `stylist`.
Aliases: `am` → area_manager, `admins` → owner+admin.
Implemented once in `audienceAllows()` in `lib/forms.ts`; `lib/home.ts` imports it.

---

## 6. Field types

| Type | Renders as | Stores |
|---|---|---|
| `text` | single-line input | string |
| `textarea` | multi-line | string |
| `number` | number input | string |
| `date` | date picker | `YYYY-MM-DD` |
| `select` | dropdown | string |
| `radio` | radio group | string |
| `checkbox` | single tickbox | `"Yes"` or `""` |
| `multiselect` | tick-all-that-apply | **array** |
| `employee` | roster-backed picker | **`globalId`** |
| `salon` | scoped salon picker | **`salonNum`** |
| `section` | header divider | nothing |

`employee` and `salon` are the point of the engine — they store real ids rather
than typed names. This is the fix the roadmap wanted for disciplinary points.

**`multiselect` gotcha:** stores an array. An empty array is truthy in JS, so
emptiness must be tested per-shape. Already handled in `submitActiveForm()`:

```js
const empty = Array.isArray(val) ? val.length===0 : !val;
```

---

## 7. Permissions

| Action | Who | Enforced by |
|---|---|---|
| View home content | any signed-in role (filtered by `audience`) | `requireSignedIn` |
| **Add/edit/delete home content** | **owner, admin only** | `requireAdmin` in `/api/home/save` |
| See a form | role in the form's `audience` | `getFormDefsForRole` |
| Submit a form | same, **re-checked server-side** | `/api/forms/submit` |
| See a submission | owner/admin/viewer: all · AM/manager: their salons + own · stylist: own | `canViewSubmission` |
| **Review a submission** | owner/admin: all · AM/manager: their salons | `canReviewSubmission` |

Two deliberate choices:

1. **Authors can see their own submission but cannot approve it.**
   `canReviewSubmission` is intentionally narrower than `canViewSubmission`.
2. **A submission with no `salonNum` is visible only to its author and to
   owner/admin/viewer** — it can't be attributed to a salon scope, so it must
   not leak sideways to an AM.

Grant posting rights by setting someone's `role` to `admin` in the **Users** tab.

---

## 8. Setup steps

### 8.1 First-run seed (REQUIRED — may not have been done yet)

Nothing works until the tabs exist. As owner/admin, go to **Forms** and click
**"Set up starter forms"**, or from the browser console:

```js
fetch('/api/forms/seed', {method:'POST'}).then(r=>r.json()).then(console.log)
```

Creates all six tabs with headers, three starter forms (Time-Off, Incident,
Maintenance), five quick links, one welcome announcement. **Idempotent** — safe
to re-run; skips anything already present, never overwrites edits.

### 8.2 Migrating existing Google Forms / Sheets

`scripts/migrate-google-forms.gs` → paste into **Extensions → Apps Script** on
the Longitude sheet, then run one of:

- **`migrateForms`** — with `FORM_URLS` left empty, migrates **every Google Form
  in Drive in a single run**. There is nothing to repeat per form.
- **`listMyForms`** — optional preview to hand-pick a subset.
- **`migrateSheets`** — for spreadsheets people type into. Header row becomes
  fields; types inferred from existing column data. Set `SHEET_FOLDER_ID` or
  `SHEET_URLS` (deliberately never scans all of Drive).

Runs **as the user**, so no API enablement, no credentials, no per-form sharing.
Safe to re-run — skips existing `formId`s.

**Not migrated** (each logged by name, never silently dropped):
file-upload questions · grids / checkbox grids · page breaks and section
branching · **existing responses** (see §9).

After `migrateSheets`, expect cleanup: every field imports **optional** and
types are **guesses**.

---

## 9. Open items

### Known gaps

1. **File attachments are not supported.** No blob storage in the project.
   Incident reports can't take photos, and announcement images need a URL rather
   than an upload. Fix: enable **Vercel Blob** (Vercel dashboard → Storage;
   auto-adds the token), then add an upload control. The `imageUrl` field is
   already the right shape — Blob just fills it, so nothing gets rebuilt.

2. **Response history import — requested, not built.** Two blockers to resolve first:
   - **Attribution.** Old responses identify people by typed name or email; new
     ones store `globalId`. Match on email against `EmployeeProfile` where
     possible; the rest stay name-only and won't scope to an AM's salons.
   - **⚠️ Scale.** `getSubmissions()` in `lib/forms.ts` reads the **entire**
     `FormSubmissions` tab on every request. Fine at a few hundred rows. A couple
     dozen forms × years of history could be 10,000+ and that endpoint will
     crawl. **Fix this before importing history** — date-windowed reads, a
     separate archive tab, or move submissions to **Supabase** (already on the
     roadmap for high-volume tables).

   Historical rows should import with their **original timestamps** and status
   `closed`, so they don't flood the review queue.

3. **Manager portal not built.** `manager` / `stylist` still land on
   `page-comingsoon`. Adding a manager branch to `setupSidebar()` is the only
   frontend work; the Forms engine is already scoped for them.

### Nice to have

- Disciplinary points could migrate onto this engine (it has its own schema and
  existing UI, so treat it as a separate job).
- Forms have no edit-after-submit; only status changes.
- No email notification when a submission needs review.

---

## 10. Gotchas and decisions worth keeping

- **`hEsc()` is mandatory.** Announcements, link labels and other users' form
  answers are rendered via `innerHTML`. Everything from a sheet or another user
  must pass through it. Verified by injecting `<img onerror>`, `<script>` and
  `<svg onload>` through every sheet-sourced field — zero elements created, no
  handler fired.

- **URL safety.** `isSafeUrl()` in `lib/home.ts` allows only `http(s)://` and
  same-origin `/` paths, for both link hrefs and announcement image srcs. Blocks
  `javascript:` from a spreadsheet cell.

- **`showFormsTab()` scopes its selector to `#forms-tabbar .tab`.** The AM tab
  bar uses the same `.tab` class; an unscoped `querySelectorAll('.tab')` would
  clear the AM's active tab. Regression-tested.

- **Home/Forms use dedicated endpoints, never `getAllData`.** That payload is
  already heavy and cached 3 minutes; home content must reflect an edit
  instantly. This follows the project's existing rule.

- **Dates use `todayIsoET()`**, not `new Date()`. Vercel runs UTC, which rolls
  over at 8pm ET and would expire an announcement a day early.

- **Audience is a checkbox picker, not free text.** A typo like `area_managr`
  used to silently hide an item from everyone.

- **Home stat tiles show only exact facts** (active salon count, week ending,
  pending review count). Deliberately no derived KPI — an unreconciled number
  there would violate the project's "what you see is what's scored" rule.

---

## 11. Corrections to `LONGITUDE_PROJECT_CONTEXT.md`

That doc is stale in several places. Verified against live code Aug 2026:

| Doc says | Actually |
|---|---|
| `dashboard.html` is ~2800 lines | **~14,400 lines** (~700KB). Full-file delivery through chat is not viable. |
| `fmtWeek` is defined twice | **Not duplicated** — already cleaned up. |
| Deliver full file replacements | The repo has a **local clone at `C:\Users\TreyBullard\Desktop\longitudeinc-dashboard`**. Edit in place; Trey reviews in GitHub Desktop and pushes. This eliminates the "stale file trap" entirely — there's no staged-vs-local copy to diverge. |

Still true and still worth doing: give Trey a **distinctive Ctrl+F string** for
each delivery, and validate before handing off.

---

## 12. Verification recipe

Run all of these before any handoff. All passed as of `21a24ce` + working tree.

```bash
npx tsc --noEmit
npm run build
```

`dashboard.html` has no build step, so parse its inline scripts explicitly —
**this is the check that catches a broken template literal**:

```bash
node -e "
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync('public/dashboard.html','utf8');
const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m,i=0,bad=0;
while((m=re.exec(html))){i++;try{new vm.Script(m[1]);console.log('OK block '+i);}catch(e){bad++;console.log('FAIL block '+i+': '+e.message);}}
console.log(bad?bad+' FAILED':'all '+i+' blocks parse');
"
```

Check the Apps Script too (copy to `.js` first — `node --check` rejects `.gs`):

```bash
cp scripts/migrate-google-forms.gs /tmp/gs.js && node --check /tmp/gs.js
```

### Live UI testing without a session cookie

Auth needs a magic link, so drive the real UI with stubbed responses. Start
`npm run dev`, open `/dashboard.html`, then in the console override `fetch` for
`/api/auth/me`, `/api/gs/getAllData`, `/api/home`, `/api/forms/*` and call
`init()`. All render functions are global and directly callable
(`switchToHome()`, `openForm('timeoff')`, `paintHome()`).

**Environment note:** the in-app browser pane reports a **0×0 viewport** —
screenshots time out and `getBoundingClientRect` is meaningless. Verify layout
via CSSOM (read `.ff-grid` rules and `matchMedia`) rather than measuring, and
have Trey eyeball the deployed page.

---

## 13. Deploy

```
Edit local clone → GitHub Desktop commit/push to main → Vercel rebuild → hard refresh
```

Backend `.ts` changes need a full Vercel rebuild, not just a refresh.
Ctrl+F confirm string: **`LONGITUDE-HOME-FORMS-V1`**
