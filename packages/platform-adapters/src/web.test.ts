import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from './memory';
import { Channel, createLocalStorage, detectOperatingSystem, isPdfFileName } from './web';

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

  it('isolates memory storage values', async () => {
    const storage = createMemoryStorage();
    const value = { list: [1] };
    await storage.set('k', value);
    value.list.push(2);
    expect(await storage.get('k')).toEqual({ list: [1] });
  });
});
