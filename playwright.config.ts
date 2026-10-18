import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suites:
 * - extension: loads apps/chrome-extension/dist unpacked into Chromium.
 * - desktop-web: the desktop UI served by `vite preview` with the web adapter.
 *   (The native Tauri binary is covered by tests/desktop/tauri-driver.e2e.mjs.)
 *
 * Build first: `pnpm build:extension && pnpm build:desktop:web` (or `pnpm test:e2e`).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'extension', testDir: 'tests/e2e/extension' },
    {
      name: 'desktop-web',
      testDir: 'tests/e2e/desktop-web',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4173',
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @folio/desktop exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});
