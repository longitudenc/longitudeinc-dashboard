// app/api/favorites/route.ts
//
// FAVORITES-ROUTE-v1  (Ctrl+F this string to confirm the file saved)
//
//   GET    ?kind=form            -> my pinned keys
//   POST   { kind, key }         -> pin one
//   DELETE ?kind=form&key=xyz    -> unpin one
//
// Any signed-in person, and always about THEMSELVES. The email comes from the
// session and is never read from the request: a favourite is the one piece of
// state a person owns outright, and accepting an email here would turn a
// convenience into a way to read, or rearrange, someone else's screen.
//
// effectiveEmail rather than email, so under View As an owner sees the pins of
// the person they are viewing as. That is the whole point of View As -- being
// shown your own shortcuts while impersonating someone else would misrepresent
// what their screen actually looks like.

import { NextResponse } from 'next/server'
import { requireSignedIn } from '@/lib/require-role'
import {
  listFavorites, addFavorite, removeFavorite, FAVORITE_KINDS, type FavoriteKind,
} from '@/lib/favorites'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const asKind = (v: unknown): FavoriteKind | null => {
  const k = String(v ?? '').trim().toLowerCase()
  return (FAVORITE_KINDS as readonly string[]).includes(k) ? (k as FavoriteKind) : null
}

export async function GET(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  const kind = asKind(new URL(req.url).searchParams.get('kind') || 'form')
  if (!kind) return NextResponse.json({ success: false, error: 'unknown kind', keys: [] }, { status: 400 })
  try {
    return NextResponse.json({ success: true, kind, keys: await listFavorites(gate.effectiveEmail, kind) })
  } catch (e: any) {
    // A missing tab or a rate limit must not take the forms screen down with
    // it -- an unpinned screen is a working screen.
    return NextResponse.json({ success: true, kind, keys: [], warning: e?.message })
  }
}

export async function POST(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  try {
    const body = await req.json().catch(() => ({}))
    const kind = asKind(body?.kind)
    const key = String(body?.key ?? '').trim().slice(0, 120)
    if (!kind) return NextResponse.json({ success: false, error: 'unknown kind' }, { status: 400 })
    if (!key) return NextResponse.json({ success: false, error: 'key is required' }, { status: 400 })
    await addFavorite(gate.effectiveEmail, kind, key)
    return NextResponse.json({ success: true, kind, keys: await listFavorites(gate.effectiveEmail, kind) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const gate = await requireSignedIn()
  if (!gate.ok) return gate.response
  try {
    const url = new URL(req.url)
    const kind = asKind(url.searchParams.get('kind'))
    const key = String(url.searchParams.get('key') ?? '').trim()
    if (!kind) return NextResponse.json({ success: false, error: 'unknown kind' }, { status: 400 })
    if (!key) return NextResponse.json({ success: false, error: 'key is required' }, { status: 400 })
    await removeFavorite(gate.effectiveEmail, kind, key)
    return NextResponse.json({ success: true, kind, keys: await listFavorites(gate.effectiveEmail, kind) })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message }, { status: 500 })
  }
}
