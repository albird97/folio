import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFJS_ASSET_DIR } from '../vite/constants';
import { pdfjsAssets } from '../vite/plugin';

type Hook = (this: unknown, ...args: unknown[]) => unknown;

let outRoot: string | null = null;
afterEach(async () => {
  if (outRoot) await rm(outRoot, { recursive: true, force: true });
  outRoot = null;
});

describe('pdfjsAssets', () => {
  it('ships the decoders with their licenses but not the unused QuickJS engine', async () => {
    outRoot = await mkdtemp(join(tmpdir(), 'folio-pdfjs-assets-'));
    const plugin = pdfjsAssets();
    await (plugin.configResolved as Hook).call(undefined, {
      root: outRoot,
      build: { outDir: 'dist' },
    });
    await (plugin.writeBundle as Hook).call(undefined);

    const assets = join(outRoot, 'dist', PDFJS_ASSET_DIR);
    expect((await readdir(assets)).sort()).toEqual(['cmaps', 'iccs', 'standard_fonts', 'wasm']);
    const wasm = await readdir(join(assets, 'wasm'));
    expect(wasm).toEqual(
      expect.arrayContaining(['openjpeg.wasm', 'LICENSE_OPENJPEG', 'jbig2.wasm', 'qcms_bg.wasm']),
    );
    expect(wasm.filter((name) => name.startsWith('quickjs'))).toEqual([]);
  });
});
