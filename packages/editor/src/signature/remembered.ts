import type { KeyValueStorage } from '@folio/platform-adapters';
import { MAX_SIGNATURE_SIDE } from './pixels';

/*
 * Signatures remembered on this device, when the user asks for it: kept in
 * the platform's settings storage (localStorage on desktop,
 * chrome.storage.local in the extension) as base64 PNGs, never anywhere
 * else. Storage can hold anything, so what is read back is checked.
 */

/** Where remembered signatures are kept. */
export const REMEMBERED_SIGNATURES_KEY = 'remembered-signatures';
/** How many are remembered; remembering another forgets the oldest. */
export const MAX_REMEMBERED = 5;
/**
 * Largest signature remembered, in PNG bytes. Settings storage is small
 * (about 5 MB on desktop), and five of these must fit with room to spare.
 */
export const MAX_REMEMBERED_BYTES = 256 * 1024;
/** Base64 is 4 characters for every 3 bytes. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_REMEMBERED_BYTES / 3) * 4;

/** A signature remembered on this device. */
export interface RememberedSignature {
  /** Tells signatures apart in lists (a hash of `png`). */
  id: string;
  /** The PNG, base64-encoded as stored. */
  png: string;
  /** Pixel size, from the PNG's header. */
  width: number;
  height: number;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // In slices: spreading a large array into one call overflows the stack.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The bytes of a base64 string, or null when it is not well-formed base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A PNG as an image URL (previews). */
export const pngDataUrl = (bytes: Uint8Array) => `data:image/png;base64,${bytesToBase64(bytes)}`;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's header (its first 24 bytes), or null when it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The first chunk is IHDR: 13 bytes that start with the width and height.
  const ihdr = String.fromCharCode(...bytes.subarray(12, 16));
  if (view.getUint32(8) !== 13 || ihdr !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A short hash of a string (FNV-1a), to tell remembered signatures apart. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stored entry, if it is a PNG of a size Folio produces. Only its header
 * is read here; the picture itself is decoded and drawn again when it is
 * used, so nothing Folio did not draw goes into a document.
 */
function readEntry(entry: unknown): RememberedSignature | null {
  if (typeof entry !== 'string' || entry.length > MAX_BASE64_LENGTH) return null;
  const bytes = base64ToBytes(entry);
  const size = bytes && bytes.byteLength <= MAX_REMEMBERED_BYTES ? pngSize(bytes) : null;
  const fits = (side: number) => side >= 1 && side <= MAX_SIGNATURE_SIDE;
  if (!size || !fits(size.width) || !fits(size.height)) return null;
  return { id: hashOf(entry), png: entry, ...size };
}

/** Remembered signatures as stored, keeping only well-formed ones, newest first. */
export function sanitizeRemembered(value: unknown): RememberedSignature[] {
  if (typeof value !== 'object' || value === null) return [];
  const list = (value as Record<string, unknown>).signatures;
  if (!Array.isArray(list)) return [];
  const signatures: RememberedSignature[] = [];
  for (const entry of list) {
    if (signatures.length === MAX_REMEMBERED) break;
    const signature = readEntry(entry);
    if (signature && !signatures.some((known) => known.png === signature.png)) {
      signatures.push(signature);
    }
  }
  return signatures;
}

const store = (storage: KeyValueStorage, signatures: readonly RememberedSignature[]) =>
  signatures.length === 0
    ? storage.remove(REMEMBERED_SIGNATURES_KEY)
    : storage.set(REMEMBERED_SIGNATURES_KEY, {
        signatures: signatures.map((signature) => signature.png),
      });

/** The signatures remembered on this device (none when storage cannot be read). */
export async function loadRememberedSignatures(
  storage: KeyValueStorage,
): Promise<RememberedSignature[]> {
  try {
    return sanitizeRemembered(await storage.get<unknown>(REMEMBERED_SIGNATURES_KEY));
  } catch {
    return [];
  }
}

/**
 * Remembers a signature (a PNG) as the newest, forgetting the oldest beyond
 * the limit. Returns the remembered signatures, or null when this one is too
 * large to keep. Rejects when storage refuses the write.
 */
export async function rememberSignature(
  storage: KeyValueStorage,
  png: Uint8Array,
): Promise<RememberedSignature[] | null> {
  if (png.byteLength > MAX_REMEMBERED_BYTES) return null;
  const added = readEntry(bytesToBase64(png));
  if (!added) return null;
  const known = await loadRememberedSignatures(storage);
  const signatures = [added, ...known.filter((signature) => signature.png !== added.png)].slice(
    0,
    MAX_REMEMBERED,
  );
  await store(storage, signatures);
  return signatures;
}

/** Forgets a remembered signature. Returns those left. */
export async function forgetSignature(
  storage: KeyValueStorage,
  id: string,
): Promise<RememberedSignature[]> {
  const signatures = (await loadRememberedSignatures(storage)).filter(
    (signature) => signature.id !== id,
  );
  await store(storage, signatures);
  return signatures;
}
