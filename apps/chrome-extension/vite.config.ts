import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { ocrAssets } from '@folio/editor/vite-plugin';
import { pdfjsAssets } from '@folio/pdf-core/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/** Emits manifest.json with the package version, so there is one version source. */
function manifest(): Plugin {
  return {
    name: 'folio:manifest',
    generateBundle() {
      const source = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify({ ...source, version: pkg.version }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), pdfjsAssets(), ocrAssets(), manifest()],
  // Extension pages are served from chrome-extension://<id>/, so asset URLs must be relative.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2022', 'chrome116'],
    minify: mode === 'development' ? false : 'oxc',
    sourcemap: mode === 'development',
    // MV3 forbids remote code; everything, including the PDF.js worker, is bundled.
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        sidepanel: resolve(root, 'sidepanel.html'),
        editor: resolve(root, 'editor.html'),
        options: resolve(root, 'options.html'),
        background: resolve(root, 'src/background/service-worker.ts'),
      },
      output: {
        // The manifest refers to the service worker by a fixed name.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
}));
