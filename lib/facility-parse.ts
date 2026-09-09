// lib/facility-parse.ts
// ---------------------------------------------------------------------------
// FACILITY-PARSE-v1 — a Great Clips facility review email, read into items.
//
// The email is generated, so it is regular. The part that matters looks like:
//
//   A Facility Review was completed for your salon 9689 - Cureton Plaza on 7/16/2026.
//   <big><b>Action Required Items</b></big>
//   <h4>Critical Brand Elements</h4>
//   <dl><dt>Front Desk</dt><dd>- Top of front desk is peeling…</dd>…</dl>
//   <h4>Salon Component Items</h4>
//   <dl><dt>Vinyl Transition and Wall Base</dt><dd>- …</dd>…</dl>
//
// ONE ITEM PER <dt>, NOT PER REPAIR. A component's <dd> can carry three
// separate repairs on three lines, and it is tempting to make each one its own
// row. Corporate does not count them that way: the rule is "Critical Brand
// Elements and/or five or more additional items marked Action Required", and it
// is counting components. Splitting would put nine items against a review that
// says seven, and the compliance arithmetic would stop matching the letter that
// triggers it. The separate lines are kept inside the item, where they can be
// worked through without changing the count.
//
// IT PROPOSES, IT NEVER WRITES — same rule as the lease abstractor. A parse is
// shown, checked and accepted by a person before anything is saved.
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', hellip: '…', deg: '°',
}

function decodeEntities(s: string): string {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[String(n).toLowerCase()] ?? m)
}

/** Tags out, line breaks kept, whitespace tidied. */
function textOf(html: string): string {
  return decodeEntities(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|dd|dt|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
    .replace(/ /g, ' ')
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** "7/16/2026" or "2026-07-16" -> "2026-07-16" */
function isoDate(raw: string): string {
  const s = String(raw || '').trim()
  const a = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (a) return s
  const b = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (b) return `${b[3]}-${String(+b[1]).padStart(2, '0')}-${String(+b[2]).padStart(2, '0')}`
  return ''
}

export type FacilityCategory = 'critical' | 'action'

export interface ParsedItem {
  category: FacilityCategory
  /** The heading the item sat under, verbatim, in case a review adds a third. */
  categoryLabel: string
  component: string
  detail: string
  /** The individual repairs inside `detail`, for a checklist. */
  lines: string[]
}

export interface ParsedReview {
  ok: boolean
  salonNum: string
  salonName: string
  reviewDate: string
  items: ParsedItem[]
  criticalCount: number
  actionCount: number
  /** True when the review, as written, triggers a compliance action. */
  compliance: boolean
  warnings: string[]
  /** Anything the email said that is worth keeping but is not an item. */
  notes: string[]
}

const CRITICAL_RE = /critical\s+brand\s+element/i

export function parseFacilityReview(input: { html?: string; text?: string; subject?: string }): ParsedReview {
  const html = String(input.html || '')
  const flatText = textOf(html || String(input.text || ''))
  const subject = String(input.subject || '')

  const out: ParsedReview = {
    ok: false, salonNum: '', salonName: '', reviewDate: '',
    items: [], criticalCount: 0, actionCount: 0, compliance: false,
    warnings: [], notes: [],
  }

  // Is this one of these emails at all? Asked FIRST, so an ordinary message
  // comes back saying what it is rather than leading with "no salon number
  // found", which reads like a parse that nearly worked.
  if (!/facility review/i.test(flatText) && !/facility review/i.test(subject)) {
    out.warnings.push('This does not read like a facility review email. Nothing was extracted.')
    return out
  }

  // ── which salon, and when ──
  // The sentence carries both; the subject carries the number as a fallback for
  // a forwarded copy whose body has been mangled.
  const line = flatText.match(
    /Facility Review was completed for your salon\s*([0-9]{3,5})\s*-\s*([^\n.]+?)\s+on\s+([0-9/\-]+)/i)
  if (line) {
    out.salonNum = line[1]
    out.salonName = line[2].trim()
    out.reviewDate = isoDate(line[3])
  } else {
    const sub = subject.match(/salon\s*([0-9]{3,5})\s*-\s*([^\n]+?)\s+Action Required/i)
    if (sub) { out.salonNum = sub[1]; out.salonName = sub[2].trim() }
    const d = flatText.match(/on\s+(\d{1,2}\/\d{1,2}\/\d{4})/)
    if (d) out.reviewDate = isoDate(d[1])
  }
  if (!out.salonNum) out.warnings.push('No salon number found — pick the salon by hand.')
  if (!out.reviewDate) out.warnings.push('No review date found — set it before saving.')

  // ── the items ──
  // Headings and definition lists, in document order: each <h4> names the
  // category for every <dl> that follows it until the next <h4>.
  const blocks = [...html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>|<dl[^>]*>([\s\S]*?)<\/dl>/gi)]
  let currentLabel = ''
  for (const b of blocks) {
    if (b[1] !== undefined) { currentLabel = textOf(b[1]); continue }
    const dl = b[2] || ''
    const pairs = [...dl.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)]
    for (const p of pairs) {
      const component = textOf(p[1])
      // The email writes each repair as "- something.", sometimes several on
      // their own lines. The dash is decoration; the sentence is the item.
      const lines = textOf(p[2]).split('\n')
        .map(l => l.replace(/^[-•–—]\s*/, '').trim())
        .filter(Boolean)
      if (!component || !lines.length) continue
      const critical = CRITICAL_RE.test(currentLabel)
      out.items.push({
        category: critical ? 'critical' : 'action',
        categoryLabel: currentLabel || (critical ? 'Critical Brand Elements' : 'Salon Component Items'),
        component,
        detail: lines.join('\n'),
        lines,
      })
    }
  }

  if (!out.items.length) {
    out.warnings.push('No Action Required items were found. If the email says there are some, '
      + 'paste its text into the box instead — the message may have been re-formatted in transit.')
    return out
  }

  out.ok = true
  out.criticalCount = out.items.filter(i => i.category === 'critical').length
  out.actionCount = out.items.length - out.criticalCount
  // The rule quoted in every one of these emails.
  out.compliance = out.criticalCount > 0 || out.actionCount >= 5

  // Carve-outs change, and this one is written into the email rather than the
  // item, so it would be lost if only the list were kept.
  const carve = flatText.match(/Please note that the Critical Brand Element[^\n]*/i)
  if (carve) out.notes.push(carve[0].trim())
  const green = flatText.match(/Green Flag[^\n]*/i)
  if (green) out.notes.push(green[0].trim())
  const who = flatText.match(/For questions on your in-salon review, contact:\s*\n([^\n]+)/i)
  if (who) out.notes.push('Reviewer: ' + who[1].trim())

  return out
}
