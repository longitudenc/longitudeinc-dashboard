// lib/xlsx-min.ts
//
// XLSX-MIN-v1 — write a single-sheet .xlsx with no dependencies.
//
// An xlsx is a ZIP of a few XML files. Amazon Business will not import a CSV,
// and this project keeps seven runtime dependencies on purpose, so rather than
// pull in a spreadsheet library for one small sheet we build the zip by hand.
//
// Entries are STORED, not deflated. It makes the file slightly larger and the
// writer dramatically simpler -- no compression state, just bytes and a CRC --
// and every unzip implementation, Excel and Google Sheets included, reads
// stored entries. For a forty-row order the size difference is irrelevant.
//
// Strings are written inline (t="inlineStr") rather than through a shared
// string table, which is another whole file and index to keep consistent for
// no benefit at this size.

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

const xmlEscape = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Excel rejects most control characters outright rather than ignoring them.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/** A1, B1 … Z1, AA1 … for the column index. */
function cellRef(col: number, row: number): string {
  let s = ''
  let n = col + 1
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s + row
}

interface ZipEntry { name: string; data: Buffer }

function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const size = e.data.length

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)   // local file header
    local.writeUInt16LE(20, 4)           // version needed
    local.writeUInt16LE(0, 6)            // flags
    local.writeUInt16LE(0, 8)            // 0 = stored
    local.writeUInt16LE(0, 10)           // mod time
    local.writeUInt16LE(0x21, 12)        // mod date (1980-01-01; deterministic output)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)        // compressed == uncompressed when stored
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)           // extra length
    name.copy(local, 30)
    locals.push(local, e.data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0) // central directory header
    central.writeUInt16LE(20, 4)         // version made by
    central.writeUInt16LE(20, 6)         // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)         // extra
    central.writeUInt16LE(0, 32)         // comment
    central.writeUInt16LE(0, 34)         // disk number
    central.writeUInt16LE(0, 36)         // internal attrs
    central.writeUInt32LE(0, 38)         // external attrs
    central.writeUInt32LE(offset, 42)    // offset of the local header
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + size
  }

  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)       // end of central directory
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)               // comment length

  return Buffer.concat([...locals, cd, end])
}

/**
 * One sheet, one array of rows. A cell that looks like a number is written as
 * one so Excel does not show the green "number stored as text" warning on the
 * quantity column -- and so Amazon's importer reads a quantity rather than a
 * string that happens to contain digits.
 */
export function sheetToXlsx(rows: (string | number)[][], sheetName = 'Sheet1'): Buffer {
  const xmlRows = rows.map((cells, r) => {
    const rowNum = r + 1
    const body = cells.map((v, c) => {
      const ref = cellRef(c, rowNum)
      const isNum = typeof v === 'number'
        || (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()))
      return isNum
        ? `<c r="${ref}"><v>${Number(v)}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`
    }).join('')
    return `<row r="${rowNum}">${body}</row>`
  }).join('')

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${xmlRows}</sheetData></worksheet>`

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`

  const b = (s: string) => Buffer.from(s, 'utf8')
  return zip([
    // [Content_Types].xml must come first; some readers assume it.
    { name: '[Content_Types].xml', data: b(contentTypes) },
    { name: '_rels/.rels', data: b(rootRels) },
    { name: 'xl/workbook.xml', data: b(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: b(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: b(sheet) },
  ])
}
