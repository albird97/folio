/** PDF readers accept the header anywhere in the first 1024 bytes. */
const HEADER_WINDOW = 1024;
const HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export interface PdfSniffResult {
  isPdf: boolean;
  /** Version from the header, e.g. "1.7"; null when absent. */
  headerVersion: string | null;
}

export function sniffPdf(bytes: Uint8Array): PdfSniffResult {
  const limit = Math.min(bytes.length, HEADER_WINDOW) - HEADER.length;
  for (let offset = 0; offset <= limit; offset += 1) {
    let match = true;
    for (let i = 0; i < HEADER.length; i += 1) {
      if (bytes[offset + i] !== HEADER[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    let version = '';
    for (let i = offset + HEADER.length; i < Math.min(bytes.length, offset + 12); i += 1) {
      const char = String.fromCharCode(bytes[i] ?? 0);
      if (!/[0-9.]/.test(char)) break;
      version += char;
    }
    return { isPdf: true, headerVersion: /^\d\.\d$/.test(version) ? version : null };
  }
  return { isPdf: false, headerVersion: null };
}
