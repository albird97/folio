import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from './memory';
import {
  Channel,
  createLocalStorage,
  detectOperatingSystem,
  downloadBytes,
  fileNameFor,
  isPdfFileName,
} from './web';

describe('web adapter helpers', () => {
  it('detects operating systems from navigator hints', () => {
    const nav = (userAgent: string, platform?: string) =>
      ({ userAgent, userAgentData: platform ? { platform } : undefined }) as unknown as Navigator;
    expect(detectOperatingSystem(nav('', 'macOS'))).toBe('macos');
    expect(detectOperatingSystem(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))).toBe('windows');
    expect(detectOperatingSystem(nav('Mozilla/5.0 (X11; Linux x86_64)'))).toBe('linux');
    expect(detectOperatingSystem(nav('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)'))).toBe('chromeos');
    expect(detectOperatingSystem(undefined)).toBe('unknown');
  });

  it('recognizes PDF file names', () => {
    expect(isPdfFileName('Report.PDF')).toBe(true);
    expect(isPdfFileName('report.pdf.txt')).toBe(false);
  });

  it('replays events emitted before the first listener', () => {
    const channel = new Channel<number>(true);
    channel.emit(1);
    channel.emit(2);
    const seen: number[] = [];
    const stop = channel.subscribe((value) => seen.push(value));
    channel.emit(3);
    stop();
    channel.emit(4);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('persists JSON values and tolerates broken storage', async () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    } as Storage;
    const storage = createLocalStorage('t:', store);
    await storage.set('theme', { mode: 'dark' });
    expect(data.get('t:theme')).toBe('{"mode":"dark"}');
    expect(await storage.get('theme')).toEqual({ mode: 'dark' });
    data.set('t:broken', '{');
    expect(await storage.get('broken')).toBeUndefined();

    const throwing = createLocalStorage('t:', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage);
    await expect(throwing.set('x', 1)).resolves.toBeUndefined();
    expect(await throwing.get('x')).toBeUndefined();
  });

  it('names downloads after the kind of file they are', () => {
    expect(fileNameFor('pdf', 'Report')).toBe('Report.pdf');
    expect(fileNameFor('png', 'Report-page-1')).toBe('Report-page-1.png');
    expect(fileNameFor('jpeg', 'Report-page-1')).toBe('Report-page-1.jpg');
    expect(fileNameFor('jpeg', 'Photo.JPEG')).toBe('Photo.JPEG');
    expect(fileNameFor('jpeg', 'Photo.jpg')).toBe('Photo.jpg');
    expect(fileNameFor('zip', 'Report (images)')).toBe('Report (images).zip');
    expect(fileNameFor('text', 'Report (text).txt')).toBe('Report (text).txt');
    // Names stay names (no folders) and keep the kind's extension.
    expect(fileNameFor('png', 'a/b\\c:d.exe')).toBe('a b c d.exe.png');
    expect(fileNameFor('text', '')).toBe('Document.txt');
  });

  it('downloads files with the MIME type of their kind', async () => {
    const clicked: Array<{ name: string; type: string }> = [];
    const blobs = new Map<string, Blob>();
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = (blob: Blob) => {
      const url = `blob:test/${blobs.size}`;
      blobs.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = () => undefined;
    const doc = {
      body: { append: () => undefined },
      createElement: () => {
        const link = {
          href: '',
          download: '',
          rel: '',
          style: {},
          click: () => clicked.push({ name: link.download, type: blobs.get(link.href)!.type }),
          remove: () => undefined,
        };
        return link;
      },
    } as unknown as Document;
    try {
      downloadBytes('a.zip', new Uint8Array([1]), 'zip', doc);
      downloadBytes('a.txt', new Uint8Array([1]), 'text', doc);
      downloadBytes('a.pdf', new Uint8Array([1]), undefined, doc);
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
    expect(clicked).toEqual([
      { name: 'a.zip', type: 'application/zip' },
      { name: 'a.txt', type: 'text/plain;charset=utf-8' },
      { name: 'a.pdf', type: 'application/pdf' },
    ]);
  });

  it('isolates memory storage values', async () => {
    const storage = createMemoryStorage();
    const value = { list: [1] };
    await storage.set('k', value);
    value.list.push(2);
    expect(await storage.get('k')).toEqual({ list: [1] });
  });
});
