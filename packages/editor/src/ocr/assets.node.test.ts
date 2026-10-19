import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TESSERACT_ASSET_DIR } from '../../vite/constants';
import { ocrAssets } from '../../vite/plugin';

type Hook = (this: unknown, ...args: unknown[]) => unknown;

let outRoot: string | null = null;
afterEach(async () => {
  if (outRoot) await rm(outRoot, { recursive: true, force: true });
  outRoot = null;
});

describe('ocrAssets', () => {
  it('ships the worker, the LSTM cores and four languages with their licenses', async () => {
    outRoot = await mkdtemp(join(tmpdir(), 'folio-ocr-assets-'));
    const plugin = ocrAssets();
    await (plugin.configResolved as Hook).call(undefined, {
      root: outRoot,
      build: { outDir: 'dist' },
    });
    await (plugin.writeBundle as Hook).call(undefined);

    const folder = join(outRoot, 'dist', TESSERACT_ASSET_DIR);
    const files = (await readdir(folder)).sort();
    expect(files).toEqual([
      'LICENSE_TESSERACT_CORE',
      'LICENSE_TESSERACT_JS.md',
      'chi_sim.traineddata.gz',
      'chi_tra.traineddata.gz',
      'eng.traineddata.gz',
      'ind.traineddata.gz',
      'tesseract-core-lstm.wasm.js',
      'tesseract-core-relaxedsimd-lstm.wasm.js',
      'tesseract-core-simd-lstm.wasm.js',
      'worker.min.js',
      'worker.min.js.LICENSE.txt',
    ]);
    // The small "best (integer)" models: the full ones are several times larger.
    const sizes = await Promise.all(
      ['eng', 'ind', 'chi_sim', 'chi_tra'].map(
        async (code) => (await stat(join(folder, `${code}.traineddata.gz`))).size,
      ),
    );
    expect(Math.max(...sizes)).toBeLessThan(3_500_000);
  });

  it('serves only the listed files in development', () => {
    type Handler = (req: unknown, res: unknown, next: () => void) => void;
    const mounted: { path?: string; handler?: Handler } = {};
    const server = {
      middlewares: {
        use: (path: string, handler: Handler) => Object.assign(mounted, { path, handler }),
      },
    };
    (ocrAssets().configureServer as Hook).call(undefined, server);
    expect(mounted.path).toBe(`/${TESSERACT_ASSET_DIR}/`);
    // Paths out of the folder, and cores that are not shipped, are left to the next handler.
    for (const url of ['/../package.json', '/%2e%2e/vite/plugin.ts', '/tesseract-core.wasm.js']) {
      let passed = false;
      mounted.handler!({ url }, {}, () => {
        passed = true;
      });
      expect(passed, url).toBe(true);
    }
  });
});
