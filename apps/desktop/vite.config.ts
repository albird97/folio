import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { ocrAssets } from '@folio/editor/vite-plugin';
import { pdfjsAssets } from '@folio/pdf-core/vite-plugin';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets(), ocrAssets()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 is evergreen; macOS 13.3+ ships Safari 16.4's WebKit.
    target: ['es2022', 'chrome111', 'safari16.4'],
    minify: process.env.TAURI_ENV_DEBUG ? false : 'oxc',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    chunkSizeWarningLimit: 2048,
  },
});
