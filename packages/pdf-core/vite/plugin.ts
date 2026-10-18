import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { PDFJS_ASSET_DIR } from './constants.ts';

const ASSET_FOLDERS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

/**
 * Folio never enables PDF.js scripting, so the QuickJS engine of its sandbox
 * (`wasm/quickjs-eval.*`) is neither served nor shipped.
 */
const isExcludedAsset = (path: string) => basename(path).startsWith('quickjs-eval.');

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
  '.js': 'text/javascript',
};

function pdfjsRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('pdfjs-dist/package.json'));
}

/**
 * Serves PDF.js' font, CMap, ICC and WASM assets in dev and copies them into
 * the build output, so every target loads them from its own origin.
 */
export function pdfjsAssets(): Plugin {
  const root = pdfjsRoot();
  let outDir = 'dist';
  return {
    name: 'folio:pdfjs-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_ASSET_DIR}/`, (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
        const [folder] = relative.split(/[/\\]/);
        const file = resolve(root, relative);
        if (
          !ASSET_FOLDERS.includes(folder as (typeof ASSET_FOLDERS)[number]) ||
          !file.startsWith(root + sep) ||
          isExcludedAsset(file) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          next();
          return;
        }
        const extension = file.slice(file.lastIndexOf('.'));
        res.setHeader('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    async writeBundle() {
      await Promise.all(
        ASSET_FOLDERS.map((folder) =>
          // License files are copied too; they must ship with the binaries.
          cp(join(root, folder), join(outDir, PDFJS_ASSET_DIR, folder), {
            recursive: true,
            filter: (source) => !isExcludedAsset(source),
          }),
        ),
      );
    },
  };
}
