// lib/email-log.ts
//
// EMAIL-ONCE-v1 -- "has this scheduled email already gone out?"
//
// The nightly workflow fires three times a day because GitHub's scheduler is
// unreliable, and scrapes are safe to repeat. An email is not. The first fix
// kept emails to the run that started before 12:00 UTC -- but GitHub has been
// starting the 08:00 run at about 12:40, so that rule quietly dropped the
// Wednesday payroll-pace email (09/02 and 09/09) and every lease alert since
// they were added. Nothing failed; the email was simply never on the list.
//
// So the once-only rule lives HERE, on the outcome rather than the clock: every
// run may try, and the first that actually sends records it in the EmailLog
// tab; later runs see the row and skip. A late or dropped trigger now costs a
// few hours, not a week.

import { readSheet, rowsToObjects, appendSheet, tabExists, createTab } from './sheets'

export const TAB_EMAIL_LOG = 'EmailLog'
const COLS = ['job', 'key', 'sentAt', 'detail']

let ready = false
async function ensureTab(): Promise<void> {
  if (ready) return
  if (!(await tabExists(TAB_EMAIL_LOG))) {
    await createTab(TAB_EMAIL_LOG)
    await appendSheet(TAB_EMAIL_LOG, [COLS])
  }
  ready = true
}

/** True when `job` has already been sent for `key` (a week end, a date...). */
export async function alreadySent(job: string, key: string): Promise<boolean> {
  try {
    const rows = rowsToObjects((await readSheet(TAB_EMAIL_LOG, undefined, { fresh: true })) || [])
    return rows.some(r => String(r.job ?? '').trim() === job && String(r.key ?? '').trim() === key)
  } catch {
    return false   // no tab yet: nothing has been sent
  }
}

/** Record a send. Called only after the provider has accepted the email. */
export async function markSent(job: string, key: string, detail = ''): Promise<void> {
  await ensureTab()
  await appendSheet(TAB_EMAIL_LOG, [[job, key, new Date().toISOString(), String(detail).slice(0, 300)]])
}
