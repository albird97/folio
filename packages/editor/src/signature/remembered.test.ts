import { createMemoryStorage, type KeyValueStorage } from '@folio/platform-adapters';
import { describe, expect, it } from 'vitest';
import { makePng } from '../../../../tests/setup/fixtures';
import {
  base64ToBytes,
  bytesToBase64,
  forgetSignature,
  loadRememberedSignatures,
  MAX_REMEMBERED,
  MAX_REMEMBERED_BYTES,
  pngSize,
  rememberSignature,
  REMEMBERED_SIGNATURES_KEY,
  sanitizeRemembered,
} from './remembered';

/** Small PNGs that differ (by colour). */
const pngs = (count: number) =>
  Promise.all(
    Array.from({ length: count }, (_, index) => makePng(30 + index, 10, [index * 20, 0, 0, 255])),
  );

const stored = (storage: ReturnType<typeof createMemoryStorage>) =>
  storage.data.get(REMEMBERED_SIGNATURES_KEY) as { signatures: string[] } | undefined;

describe('remembered signatures', () => {
  it('reads sizes from PNG headers and round-trips base64', async () => {
    const png = await makePng(120, 40);
    expect(pngSize(png)).toEqual({ width: 120, height: 40 });
    expect(pngSize(new Uint8Array(32))).toBeNull();
    expect(base64ToBytes(bytesToBase64(png))).toEqual(png);
    // Larger than one slice of the encoder.
    const large = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251);
    expect(base64ToBytes(bytesToBase64(large))).toEqual(large);
    expect(base64ToBytes('not base64!')).toBeNull();
    expect(base64ToBytes('abc')).toBeNull();
  });

  it('remembers the newest first, once each, and at most five', async () => {
    const storage = createMemoryStorage();
    const [first, second, ...rest] = await pngs(MAX_REMEMBERED + 2);
    await rememberSignature(storage, first!);
    await rememberSignature(storage, second!);
    const again = await rememberSignature(storage, first!);
    expect(again?.map((signature) => signature.png)).toEqual([
      bytesToBase64(first!),
      bytesToBase64(second!),
    ]);
    expect(again?.[0]).toMatchObject({ width: 30, height: 10 });
    for (const png of rest) await rememberSignature(storage, png);
    const kept = await loadRememberedSignatures(storage);
    expect(kept).toHaveLength(MAX_REMEMBERED);
    // The oldest was forgotten.
    expect(kept.map((signature) => signature.png)).not.toContain(bytesToBase64(second!));
    expect(stored(storage)?.signatures).toEqual(kept.map((signature) => signature.png));
  });

  it('refuses signatures too large to keep', async () => {
    const storage = createMemoryStorage();
    const header = await makePng(100, 100);
    const huge = new Uint8Array(MAX_REMEMBERED_BYTES + 1);
    huge.set(header.subarray(0, 24));
    expect(await rememberSignature(storage, huge)).toBeNull();
    expect(storage.data.has(REMEMBERED_SIGNATURES_KEY)).toBe(false);
  });

  it('forgets signatures, and the stored list with the last one', async () => {
    const storage = createMemoryStorage();
    const [first, second] = await pngs(2);
    await rememberSignature(storage, first!);
    const both = (await rememberSignature(storage, second!))!;
    const left = await forgetSignature(storage, both[0]!.id);
    expect(left.map((signature) => signature.png)).toEqual([bytesToBase64(first!)]);
    expect(await forgetSignature(storage, 'unknown')).toEqual(left);
    await forgetSignature(storage, left[0]!.id);
    expect(storage.data.has(REMEMBERED_SIGNATURES_KEY)).toBe(false);
  });

  it('keeps only well-formed PNGs of a size Folio makes when reading storage', async () => {
    const [valid, other] = await pngs(2);
    const tooWide = await makePng(1201, 10);
    const noWidth = (await makePng(10, 10)).slice();
    noWidth.set([0, 0, 0, 0], 16);
    const notPng = bytesToBase64(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );
    const huge = new Uint8Array(MAX_REMEMBERED_BYTES + 3);
    huge.set(valid!.subarray(0, 24));
    const signatures = sanitizeRemembered({
      signatures: [
        bytesToBase64(valid!),
        42,
        null,
        { png: bytesToBase64(other!) },
        'not base64!',
        `${bytesToBase64(other!)}=`,
        notPng,
        bytesToBase64(tooWide),
        bytesToBase64(noWidth),
        bytesToBase64(huge),
        bytesToBase64(valid!),
        bytesToBase64(other!),
      ],
    });
    expect(signatures.map((signature) => signature.png)).toEqual([
      bytesToBase64(valid!),
      bytesToBase64(other!),
    ]);
    expect(new Set(signatures.map((signature) => signature.id)).size).toBe(2);
    for (const value of [undefined, null, 'signatures', 7, [], { signatures: 'x' }, {}]) {
      expect(sanitizeRemembered(value)).toEqual([]);
    }
  });

  it('reads at most five, newest first', async () => {
    const all = (await pngs(MAX_REMEMBERED + 1)).map(bytesToBase64);
    expect(sanitizeRemembered({ signatures: all }).map((signature) => signature.png)).toEqual(
      all.slice(0, MAX_REMEMBERED),
    );
  });

  it('reads nothing from storage it cannot read', async () => {
    const failing: KeyValueStorage = {
      ...createMemoryStorage(),
      get: () => Promise.reject(new Error('Storage is not available.')),
    };
    expect(await loadRememberedSignatures(failing)).toEqual([]);
  });
});
