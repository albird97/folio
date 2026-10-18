/**
 * End-to-end test of the real desktop binary through tauri-driver
 * (WebKitWebDriver on Linux, Edge WebDriver on Windows; macOS has no WebDriver
 * for WKWebView). No browser automation library: plain W3C WebDriver calls.
 *
 *   cargo install tauri-driver --locked
 *   pnpm build:desktop:linux          # or any build that produces the binary
 *   xvfb-run node tests/desktop/tauri-driver.e2e.mjs
 *
 * FOLIO_APP overrides the binary path.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const exe = process.platform === 'win32' ? 'folio-desktop.exe' : 'folio-desktop';
const application = process.env.FOLIO_APP ?? join(root, 'target', 'release', exe);
const fixture = join(root, 'tests', 'fixtures', 'basic-3-pages.pdf');
const DRIVER = 'http://127.0.0.1:4444';

if (!existsSync(application)) {
  console.error(`Desktop binary not found at ${application}. Build it first.`);
  process.exit(1);
}

async function wd(method, path, body) {
  const response = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  return json.value;
}

async function waitForDriver() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`${DRIVER}/status`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('tauri-driver did not start');
}

const driver = spawn('tauri-driver', [], { stdio: ['ignore', 'inherit', 'inherit'] });
let session;
let failed = false;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push(`✓ ${name}`);
  } catch (error) {
    failed = true;
    results.push(`✗ ${name}\n    ${error.message}`);
  }
}

const run = (script, args = []) => wd('POST', `/session/${session}/execute/sync`, { script, args });
const runAsync = (script, args = []) =>
  wd('POST', `/session/${session}/execute/async`, { script, args });

async function waitFor(script, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    const value = await run(script);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for: ${script}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

try {
  await waitForDriver();
  ({ sessionId: session } = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: { 'tauri:options': { application, args: [fixture] } },
    },
  }));

  await test('opens a PDF passed on the command line (file association path)', async () => {
    await waitFor(`return document.querySelector('[data-render-state="done"]') !== null`);
    const title = await run(`return document.querySelector('[role="toolbar"] h1')?.textContent`);
    assert.equal(title, 'Folio Basic Fixture');
    const tab = await run(
      `return document.querySelector('nav[aria-label="Open documents"] [aria-current="page"]')?.textContent`,
    );
    assert.match(tab, /basic-3-pages\.pdf/);
  });

  await test('renders the page with PDF.js inside the system webview', async () => {
    const size = await run(
      `const c = document.querySelector('[data-testid="page-canvas"]'); return [c.width, c.height]`,
    );
    assert.ok(size[0] > 100 && size[1] > 100, `canvas is ${size}`);
    const inked = await run(`
      const c = document.querySelector('[data-testid="page-canvas"]');
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
      return dark;
    `);
    assert.ok(inked > 200, `expected rendered text, found ${inked} dark pixels`);
  });

  await test('the content security policy blocks nothing Folio needs', async () => {
    const violations = await run('return window.__folioCspViolations');
    assert.deepEqual(violations, []);
  });

  await test('file commands only accept tokens issued by the native layer', async () => {
    const error = await runAsync(`
      const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('read_granted_file', { token: '../../etc/passwd' })
        .then(() => done('resolved'), (e) => done(e));
    `);
    assert.equal(error.code, 'unknown-token');
  });

  await test('plugins the capability does not grant are denied', async () => {
    const error = await runAsync(`
      const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('plugin:dialog|open', { options: {} })
        .then(() => done('resolved'), (e) => done(String(e)));
    `);
    assert.notEqual(error, 'resolved');
    assert.match(error, /not allowed|denied|permission/i);
  });

  await test('closing the last tab returns to the start screen', async () => {
    await run(`document.querySelector('button[aria-label="Close basic-3-pages.pdf"]').click()`);
    await waitFor(
      `return document.querySelector('main')?.textContent?.includes('Open a PDF to get started')`,
    );
  });
} catch (error) {
  failed = true;
  results.push(`✗ setup: ${error.message}`);
} finally {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => undefined);
  driver.kill();
}

console.log(results.join('\n'));
process.exit(failed ? 1 : 0);
