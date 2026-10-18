/**
 * A minimal ZIP writer for exports made of several files (page images).
 * Entries are stored without compression: PNG and JPEG data is already
 * compressed. Names are UTF-8. Archives are limited to what plain ZIP can
 * describe (no ZIP64): fewer than 65,535 entries and under 4 GiB in total.
 */
export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  /** Shown as the file's modification time; defaults to now. */
  modified?: Date;
}

const MAX_ENTRIES = 0xffff - 1;
const MAX_OFFSET = 0xffffffff;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** CRC-32 (IEEE 802.3), as ZIP stores it. */
export function crc32(bytes: Uint8Array): number {
  const lookup = table();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = lookup[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which ZIP headers use (local time, two-second steps). */
function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

/** Keeps names relative and portable: no drive letters, `..` or leading slashes. */
function safeName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter(
      (part, index) =>
        part !== '' && part !== '.' && part !== '..' && !(index === 0 && /^[A-Za-z]:$/.test(part)),
    );
  if (parts.length === 0) throw new Error('A ZIP entry needs a file name.');
  return parts.join('/');
}

const UTF8_FLAG = 1 << 11;
const encoder = new TextEncoder();

export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error('Too many files for one ZIP archive.');
  const seen = new Set<string>();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    let name = safeName(entry.name);
    // Later duplicates get a number, as file managers do: "page.png" → "page (2).png".
    for (let copy = 2; seen.has(name.toLowerCase()); copy += 1) {
      name = safeName(entry.name).replace(/(\.[^./]*)?$/, (ext) => ` (${copy})${ext}`);
    }
    seen.add(name.toLowerCase());
    const nameBytes = encoder.encode(name);
    const { date, time } = dosDateTime(entry.modified ?? new Date());
    const crc = crc32(entry.bytes);
    const size = entry.bytes.byteLength;
    if (offset + 30 + nameBytes.length + size > MAX_OFFSET) {
      throw new Error('The files are too large for one ZIP archive.');
    }

    const header = new Uint8Array(30 + nameBytes.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); // local file header signature
    h.setUint16(4, 20, true); // version needed to extract (2.0)
    h.setUint16(6, UTF8_FLAG, true);
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, size, true);
    h.setUint32(22, size, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);
    local.push(header, entry.bytes);

    const record = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true); // central directory header signature
    c.setUint16(4, 20, true); // version made by
    c.setUint16(6, 20, true); // version needed to extract
    c.setUint16(8, UTF8_FLAG, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, nameBytes.length, true);
    // Extra field, comment, disk number, internal and external attributes: none.
    c.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    central.push(record);

    offset += header.length + size;
  }
  const directorySize = central.reduce((total, record) => total + record.length, 0);
  if (offset + directorySize > MAX_OFFSET) {
    throw new Error('The files are too large for one ZIP archive.');
  }
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); // end of central directory signature
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);

  const out = new Uint8Array(offset + directorySize + end.length);
  let position = 0;
  for (const part of [...local, ...central, end]) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
