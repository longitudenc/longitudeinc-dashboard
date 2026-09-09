// lib/msg-reader.ts
// ---------------------------------------------------------------------------
// MSG-READER-v1 — pull the body out of an Outlook .msg, with no dependencies.
//
// A .msg is a Compound File Binary: a FAT filesystem in a file. The pieces that
// matter are small — a header, two allocation tables and a directory — and the
// alternative is a dependency that carries a full OLE implementation to read
// one string.
//
// WHY NOT JUST SCAN THE BYTES FOR "<html". Because it nearly works, which is
// worse than not working. The HTML body is one stream among dozens and it is
// chained through the FAT in 512-byte fragments that need not be adjacent; a
// scan gets the first fragment, or gets it interleaved with another property,
// and produces a document that parses cleanly and is missing three of the
// repairs. Following the chain is the only way to know the body is whole.
//
// Two storage classes, both handled here: streams of 4096 bytes or more live in
// ordinary sectors chained by the FAT; anything smaller lives inside the root
// entry's "mini stream" and is chained by the mini FAT. A short plain-text body
// takes the second path, so skipping it would fail on exactly the small emails.
// ---------------------------------------------------------------------------

const SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff

export interface MsgEntry { name: string; size: number; read: () => Buffer }

/** A file that came with the message. */
export interface MsgAttachment {
  fileName: string
  mimeType: string
  /** The cid: the HTML body refers to it by, when it is an inline image. */
  contentId: string
  /** Where it sat in the message, for ordering when there are no cids. */
  index: number
  size: number
  data: Buffer
}

/** True if these bytes are a compound file at all. */
export function isMsg(buf: Buffer): boolean {
  return buf.length > 512 && buf.subarray(0, 8).equals(SIG)
}

interface Dir {
  name: string; type: number; start: number; size: number
  child: number; left: number; right: number
}

function parseCfb(buf: Buffer) {
  if (!isMsg(buf)) throw new Error('not a compound file (.msg)')
  const sectorShift = buf.readUInt16LE(30)
  const miniShift = buf.readUInt16LE(32)
  const secSize = 1 << sectorShift
  const miniSize = 1 << miniShift
  const nFat = buf.readUInt32LE(44)
  const dirStart = buf.readUInt32LE(48)
  const miniCutoff = buf.readUInt32LE(56) || 4096
  const miniFatStart = buf.readUInt32LE(60)
  const difatStart = buf.readUInt32LE(68)
  const nDifat = buf.readUInt32LE(72)

  const sectorOffset = (n: number) => 512 + n * secSize
  const sectorAt = (n: number) => {
    const off = sectorOffset(n)
    if (off < 0 || off + secSize > buf.length) throw new Error('sector out of range')
    return buf.subarray(off, off + secSize)
  }

  // ── FAT ──
  // The first 109 FAT sector numbers sit in the header; the rest are in a chain
  // of DIFAT sectors, each ending with a pointer to the next.
  const fatSectors: number[] = []
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) {
    const v = buf.readUInt32LE(76 + i * 4)
    if (v === FREESECT || v === ENDOFCHAIN) break
    fatSectors.push(v)
  }
  let d = difatStart
  for (let i = 0; i < nDifat && d !== ENDOFCHAIN && d !== FREESECT; i++) {
    const s = sectorAt(d)
    const per = secSize / 4 - 1
    for (let j = 0; j < per && fatSectors.length < nFat; j++) {
      const v = s.readUInt32LE(j * 4)
      if (v === FREESECT || v === ENDOFCHAIN) break
      fatSectors.push(v)
    }
    d = s.readUInt32LE(secSize - 4)
  }
  const fat: number[] = []
  for (const fs of fatSectors) {
    const s = sectorAt(fs)
    for (let i = 0; i < secSize / 4; i++) fat.push(s.readUInt32LE(i * 4))
  }

  /** Walk a sector chain and concatenate, stopping at `size` bytes. */
  const readChain = (start: number, size: number, mini = false, miniStream?: Buffer) => {
    const out: Buffer[] = []
    let n = start, guard = 0
    const unit = mini ? miniSize : secSize
    const table = mini ? miniFat : fat
    while (n !== ENDOFCHAIN && n !== FREESECT && guard++ < 1_000_000) {
      if (mini) {
        const off = n * miniSize
        if (!miniStream || off + miniSize > miniStream.length) break
        out.push(miniStream.subarray(off, off + miniSize))
      } else {
        out.push(sectorAt(n))
      }
      const next = table[n]
      if (next === undefined) break
      n = next
    }
    const all = Buffer.concat(out)
    return size >= 0 && size <= all.length ? all.subarray(0, size) : all
  }

  // ── mini FAT ──
  const miniFat: number[] = []
  {
    let n = miniFatStart, guard = 0
    while (n !== ENDOFCHAIN && n !== FREESECT && guard++ < 100000) {
      const s = sectorAt(n)
      for (let i = 0; i < secSize / 4; i++) miniFat.push(s.readUInt32LE(i * 4))
      n = fat[n]
      if (n === undefined) break
    }
  }

  // ── directory ──
  const dirBytes = readChain(dirStart, -1)
  const dirs: Dir[] = []
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = dirBytes.readUInt16LE(off + 64)
    const name = nameLen > 2
      ? dirBytes.subarray(off, off + nameLen - 2).toString('utf16le')
      : ''
    dirs.push({
      name,
      type: dirBytes.readUInt8(off + 66),
      left: dirBytes.readUInt32LE(off + 68),
      right: dirBytes.readUInt32LE(off + 72),
      child: dirBytes.readUInt32LE(off + 76),
      start: dirBytes.readUInt32LE(off + 116),
      size: dirBytes.readUInt32LE(off + 120),
    })
  }
  const root = dirs[0]
  const miniStream = root ? readChain(root.start, root.size) : Buffer.alloc(0)

  const streamOf = (e: Dir): MsgEntry => ({
    name: e.name,
    size: e.size,
    read: () => e.size < miniCutoff
      ? readChain(e.start, e.size, true, miniStream)
      : readChain(e.start, e.size),
  })

  /**
   * The children of one storage.
   *
   * SIBLINGS ARE A RED-BLACK TREE, not a list — left and right on each entry,
   * with the storage pointing only at the middle one. Reading the directory
   * flat works right up until there are attachments, because every attachment
   * names its streams identically (37010102 is the bytes of whichever one you
   * are inside) and a flat pass collapses fourteen photos into one. Walking the
   * tree per storage is what keeps them apart.
   */
  const childrenOf = (idx: number): Dir[] => {
    const root = dirs[idx]
    if (!root || root.child === FREESECT) return []
    const out: Dir[] = []
    const seen = new Set<number>()
    const walk = (i: number) => {
      if (i === FREESECT || i >= dirs.length || seen.has(i)) return
      seen.add(i)
      walk(dirs[i].left)
      out.push(dirs[i])
      walk(dirs[i].right)
    }
    walk(root.child)
    return out
  }

  return { dirs, streamOf, childrenOf }
}

/** Decode a MAPI property stream by the type in its name. */
function decode(name: string, raw: Buffer): string {
  const type = name.slice(-4).toUpperCase()
  if (type === '001F') return raw.toString('utf16le')          // PT_UNICODE
  if (type === '001E') return raw.toString('latin1')           // PT_STRING8
  return raw.toString('latin1')                                 // PT_BINARY (HTML)
}

export interface MsgContent {
  subject: string
  html: string
  text: string
  attachments: MsgAttachment[]
  /** Every stream found, for when a message does not look like the others. */
  streams: string[]
}

/**
 * Subject and body out of a .msg.
 *
 * PR_HTML (1013) is preferred over the plain-text body (1000): the facility
 * review's structure — which heading an item sits under — exists only in the
 * markup, and the text version flattens it into a list with no categories.
 */
export function readMsg(buf: Buffer): MsgContent {
  const { dirs, streamOf, childrenOf } = parseCfb(buf)

  /** Read a property out of one storage's own children. */
  const propFrom = (kids: Dir[]) => (...ids: string[]) => {
    for (const id of ids) {
      const want = `__substg1.0_${id}`.toUpperCase()
      const e = kids.find(k => k.type === 2 && k.name.toUpperCase() === want)
      if (e && e.size) {
        try { return decode(id, streamOf(e).read()) } catch { /* try the next */ }
      }
    }
    return ''
  }
  const rawFrom = (kids: Dir[], ...ids: string[]): Buffer => {
    for (const id of ids) {
      const want = `__substg1.0_${id}`.toUpperCase()
      const e = kids.find(k => k.type === 2 && k.name.toUpperCase() === want)
      if (e && e.size) {
        try { return streamOf(e).read() } catch { /* try the next */ }
      }
    }
    return Buffer.alloc(0)
  }

  const top = childrenOf(0)
  const get = propFrom(top)

  // ── attachments ──
  const attachments: MsgAttachment[] = []
  const attachDirs = top.filter(e => e.type === 1 && /^__attach_version1\.0_#/i.test(e.name))
  attachDirs.forEach((a, n) => {
    const kids = childrenOf(dirs.indexOf(a))
    const p = propFrom(kids)
    const data = rawFrom(kids, '37010102')
    if (!data.length) return
    attachments.push({
      // Long filename first: the short one is the 8.3 truncation, so a photo
      // called "9689 front desk.jpg" arrives as "9689FR~1.JPG" without it.
      fileName: (p('3707001F', '3707001E') || p('3704001F', '3704001E') || `attachment-${n + 1}`)
        .replace(/ +$/, '').trim(),
      mimeType: (p('370E001F', '370E001E') || '').replace(/ +$/, '').trim(),
      contentId: (p('3712001F', '3712001E') || '').replace(/ +$/, '').trim().replace(/^<|>$/g, ''),
      index: n,
      size: data.length,
      data,
    })
  })

  return {
    subject: get('0037001F', '0037001E').replace(/ +$/, '').trim(),
    html: get('10130102', '1013001E', '1013001F'),
    text: get('1000001F', '1000001E'),
    attachments,
    streams: top.map(e => e.name),
  }
}
