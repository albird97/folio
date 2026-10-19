import { createReadStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { OCR_LANGUAGE_CODES, TESSERACT_ASSET_DIR } from './constants.ts';

/**
 * The cores Tesseract.js 7 picks from for LSTM-only recognition, each with
 * its WebAssembly inlined: built for relaxed SIMD, for SIMD, or for neither,
 * whichever the browser supports. The cores of the legacy engine are not
 * shipped.
 */
const CORES = [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js',
];

/** The smaller "best (integer)" LSTM models: the full ones are 4–16 times larger. */
const MODEL_FOLDER = '4.0.0_best_int';

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.gz': 'application/gzip',
};

/** Every file the OCR worker loads, with its licenses: published name → file on disk. */
function ocrAssetFiles(): Map<string, string> {
  const require = createRequire(import.meta.url);
  const root = (name: string) => dirname(require.resolve(`${name}/package.json`));
  const tesseract = root('tesseract.js');
  const core = root('tesseract.js-core');
  const files = new Map<string, string>([
    ['worker.min.js', join(tesseract, 'dist', 'worker.min.js')],
    ['worker.min.js.LICENSE.txt', join(tesseract, 'dist', 'worker.min.js.LICENSE.txt')],
    ['LICENSE_TESSERACT_JS.md', join(tesseract, 'LICENSE.md')],
    ['LICENSE_TESSERACT_CORE', join(core, 'LICENSE')],
  ]);
  for (const name of CORES) files.set(name, join(core, name));
  for (const code of OCR_LANGUAGE_CODES) {
    files.set(
      `${code}.traineddata.gz`,
      join(root(`@tesseract.js-data/${code}`), MODEL_FOLDER, `${code}.traineddata.gz`),
    );
  }
  return files;
}

/**
 * Serves Tesseract's worker, cores and language data in dev and copies them
 * into the build output, so recognition runs from the app's own origin and
 * nothing is downloaded (Manifest V3 forbids remote code anyway).
 */
export function ocrAssets(): Plugin {
  const files = ocrAssetFiles();
  let outDir = 'dist';
  return {
    name: 'folio:ocr-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(`/${TESSERACT_ASSET_DIR}/`, (req, res, next) => {
        // Only the listed files, by exact name: nothing else on disk is reachable.
        const name = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
        const file = files.get(name.replace(/^\/+/, ''));
        if (!file) {
          next();
          return;
        }
        const extension = file.slice(file.lastIndexOf('.'));
        res.setHeader('Content-Type', CONTENT_TYPES[extension] ?? 'text/plain; charset=utf-8');
        createReadStream(file).pipe(res);
      });
    },
    async writeBundle() {
      const target = join(outDir, TESSERACT_ASSET_DIR);
      await mkdir(target, { recursive: true });
      await Promise.all([...files].map(([name, file]) => copyFile(file, join(target, name))));
    },
  };
}
