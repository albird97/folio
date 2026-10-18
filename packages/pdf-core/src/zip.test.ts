import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, createZip } from './zip';

/**
 * Reads an archive back with Python's zipfile (an independent reader): the
 * names, and each file's bytes verified against its stored CRC. Null when
 * Python is not installed; CI always has it.
 */
function readBack(zip: Uint8Array): Array<{ name: string; bytes: number[] }> | null {
  const dir = mkdtempSync(join(tmpdir(), 'folio-zip-'));
  try {
    const file = join(dir, 'test.zip');
    writeFileSync(file, zip);
    const script = [
      'import json, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as z:',
      '    assert z.testzip() is None, "CRC mismatch"',
      '    print(json.dumps([{"name": i.filename, "bytes": list(z.read(i))} for i in z.infolist()]))',
    ].join('\n');
    const result = spawnSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' });
    if (result.error) {
      if (process.env.CI) throw result.error;
      return null;
    }
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout) as Array<{ name: string; bytes: number[] }>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('zip', () => {
  it('computes CRC-32 like zlib', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes archives other tools read, with UTF-8 names', () => {
    const zip = createZip([
      { name: 'page-1.png', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'Übersicht — 2.png', bytes: new Uint8Array([4, 5]) },
      { name: 'empty.txt', bytes: new Uint8Array() },
    ]);
    const entries = readBack(zip);
    if (!entries) return;
    expect(entries).toEqual([
      { name: 'page-1.png', bytes: [1, 2, 3] },
      { name: 'Übersicht — 2.png', bytes: [4, 5] },
      { name: 'empty.txt', bytes: [] },
    ]);
  });

  it('keeps names inside the archive and unique', () => {
    const zip = createZip([
      { name: '../../etc/passwd', bytes: new Uint8Array([1]) },
      { name: 'C:\\Windows\\page.png', bytes: new Uint8Array([2]) },
      { name: '/abs/page.png', bytes: new Uint8Array([3]) },
      { name: 'Page.PNG', bytes: new Uint8Array([4]) },
      { name: 'page.png', bytes: new Uint8Array([5]) },
    ]);
    const entries = readBack(zip);
    if (!entries) return;
    expect(entries.map((entry) => entry.name)).toEqual([
      'etc/passwd',
      'Windows/page.png',
      'abs/page.png',
      'Page.PNG',
      'page (2).png',
    ]);
  });

  it('refuses entries without a name', () => {
    expect(() => createZip([{ name: '../', bytes: new Uint8Array() }])).toThrow(/file name/);
  });
});
