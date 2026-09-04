// lib/favorites.ts
//
// FAVORITES-v1
//
// Per-person pins. One row per person per pinned thing, on a single tab.
//
// `kind` is generic on purpose. Forms are the first use, but the same storage
// is what the roadmap's "Favorites -> Quick Links" needs, and a second tab
// keyed the same way would only be a second thing to keep in step.
//
// SCOPE IS THE EMAIL, ALWAYS FROM THE SESSION. Nothing here takes an email from
// a caller: a favourite is the one piece of state a person owns outright, and
// letting a request name whose favourites to read or write would turn a
// harmless convenience into a way to see what someone else is doing.

import { readSheet, writeSheet, appendSheet, rowsToObjects } from '@/lib/sheets'

export const TAB_FAVORITES = 'Favorites'
export const FAVORITE_COLUMNS = ['email', 'kind', 'key', 'addedAt'] as const

/** What can be pinned. Anything else is refused rather than stored and ignored. */
export const FAVORITE_KINDS = ['form'] as const
export type FavoriteKind = (typeof FAVORITE_KINDS)[number]

const norm = (v: unknown) => String(v ?? '').trim()
const lower = (v: unknown) => norm(v).toLowerCase()

export interface Favorite {
  email: string
  kind: string
  key: string
  addedAt: string
}

/** A tab that does not exist yet is nobody having pinned anything. */
async function readAll(fresh = false): Promise<Favorite[]> {
  try {
    const rows = rowsToObjects((await readSheet(TAB_FAVORITES, undefined, { fresh })) || [])
    return rows.map(r => ({
      email: lower(r.email), kind: lower(r.kind), key: norm(r.key), addedAt: norm(r.addedAt),
    })).filter(f => f.email && f.kind && f.key)
  } catch {
    return []
  }
}

/** One person's pins of one kind, oldest first so the order is stable. */
export async function listFavorites(email: string, kind: FavoriteKind): Promise<string[]> {
  const me = lower(email)
  if (!me) return []
  return (await readAll())
    .filter(f => f.email === me && f.kind === kind)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
    .map(f => f.key)
}

/**
 * Pin something. Idempotent: pinning what is already pinned changes nothing
 * rather than growing a second row that would then need de-duplicating on read.
 */
export async function addFavorite(email: string, kind: FavoriteKind, key: string): Promise<void> {
  const me = lower(email), k = norm(key)
  if (!me || !k) return

  // Read-modify-write over a shared tab, so it must read fresh -- two people
  // pinning at once is exactly the case a stale read would lose.
  const raw = ((await readSheet(TAB_FAVORITES, undefined, { fresh: true }).catch(() => [])) || []) as any[][]
  const header = (raw[0] || []).map((h: any) => norm(h))
  const cols = [...FAVORITE_COLUMNS]
  const row = { email: me, kind, key: k, addedAt: new Date().toISOString() }

  if (!header.length) {
    await writeSheet(TAB_FAVORITES, [cols, cols.map(c => (row as any)[c])])
    return
  }
  const already = rowsToObjects(raw).some(r =>
    lower(r.email) === me && lower(r.kind) === kind && norm(r.key) === k)
  if (already) return

  // Append rather than rewrite, so a concurrent pin is not clobbered.
  await appendSheet(TAB_FAVORITES, [header.map(h => {
    const hit = cols.find(c => c.toLowerCase() === h.toLowerCase())
    return hit ? String((row as any)[hit] ?? '') : ''
  })])
}

/** Unpin. Silent when there was nothing pinned, which is the same end state. */
export async function removeFavorite(email: string, kind: FavoriteKind, key: string): Promise<void> {
  const me = lower(email), k = norm(key)
  if (!me || !k) return
  const raw = ((await readSheet(TAB_FAVORITES, undefined, { fresh: true }).catch(() => [])) || []) as any[][]
  const header = (raw[0] || []).map((h: any) => norm(h))
  if (!header.length) return
  const rows = rowsToObjects(raw)
  const kept = rows.filter(r =>
    !(lower(r.email) === me && lower(r.kind) === kind && norm(r.key) === k))
  if (kept.length === rows.length) return
  await writeSheet(TAB_FAVORITES, [header, ...kept.map(r => header.map(h => String(r[h] ?? '')))])
}
