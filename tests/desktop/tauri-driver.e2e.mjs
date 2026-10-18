/**
 * End-to-end test of the real desktop binary through tauri-driver
 * (WebKitWebDriver on Linux, Edge WebDriver on Windows; macOS has no WebDriver
 * for WKWebView). No browser automation library: plain W3C WebDriver calls.
 *
 *   cargo install tauri-driver --locked
 *   pnpm build:desktop:linux          # or any build that produces the binary
 *   xvfb-run node tests/desktop/tauri-driver.e2e.mjs
 *
 * FOLIO_APP overrides the binary path. Everything the app stores goes to a
 * temporary folder (FOLIO_DATA_DIR and the XDG folders), never the user's
 * profile. On Linux, a private D-Bus session lets the single-instance
 * plugin hand a second launch to the running app, as it does on a desktop.
 */
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const exe = process.platform === 'win32' ? 'folio-desktop.exe' : 'folio-desktop';
const application = process.env.FOLIO_APP ?? join(root, 'target', 'release', exe);
const fixtures = join(root, 'tests', 'fixtures');
const DRIVER = 'http://127.0.0.1:4444';
/** The official Folio extension (its development key gives it this id). */
const OFFICIAL_EXTENSION_ID = 'ghfckfnleaidabfhaplbnfknipajedan';
/** An extension Folio does not know. */
const OTHER_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

if (!existsSync(application)) {
  console.error(`Desktop binary not found at ${application}. Build it first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'folio-e2e-'));
const dataDir = join(work, 'data');
const configDir = join(work, 'config');
const docs = join(work, 'documents');
for (const dir of [dataDir, configDir, docs, join(work, 'share'), join(work, 'cache')]) {
  mkdirSync(dir, { recursive: true });
}
// The app edits a copy, never the fixture itself.
const document = join(docs, 'basic-3-pages.pdf');
copyFileSync(join(fixtures, 'basic-3-pages.pdf'), document);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Starts a D-Bus session bus for this run and returns its address. It starts
 * no services (portals and the like), so the run does not depend on them.
 */
async function startSessionBus() {
  if (process.platform !== 'linux') return null;
  const found = spawnSync('dbus-daemon', ['--version'], { stdio: 'ignore' });
  if (found.error) throw new Error('dbus-daemon is needed for the single-instance checks');
  const config = join(work, 'session-bus.conf');
  writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${tmpdir()}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  const bus = spawn('dbus-daemon', [`--config-file=${config}`, '--nofork', '--print-address=1'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const address = await new Promise((resolve, reject) => {
    let output = '';
    bus.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split('\n')[0];
      if (output.includes('\n')) resolve(line.trim());
    });
    bus.once('error', reject);
    bus.once('exit', () => reject(new Error('dbus-daemon exited')));
  });
  return { bus, address };
}

const session_bus = await startSessionBus();
const env = {
  ...process.env,
  FOLIO_DATA_DIR: dataDir,
  XDG_CONFIG_HOME: configDir,
  XDG_DATA_HOME: join(work, 'share'),
  XDG_CACHE_HOME: join(work, 'cache'),
  NO_AT_BRIDGE: '1',
  ...(session_bus ? { DBUS_SESSION_BUS_ADDRESS: session_bus.address } : {}),
};

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

const driver = spawn('tauri-driver', [], { stdio: ['ignore', 'inherit', 'inherit'], env });
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

/**
 * Invokes a Folio command from the page, as the UI does. `raw` (bytes) is
 * sent as the request body instead of `args`. Binary responses come back
 * as a Buffer. Rejections are returned as `{ rejected }`.
 */
async function invoke(command, args = {}, { raw, headers } = {}) {
  const outcome = await runAsync(
    `
    const done = arguments[arguments.length - 1];
    const [command, args, raw, headers] = arguments;
    const body = raw === null ? args : Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    window.__TAURI_INTERNALS__
      .invoke(command, body, headers ? { headers } : undefined)
      .then((value) => {
        if (value instanceof ArrayBuffer) {
          let binary = '';
          for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
          done({ binary: btoa(binary) });
        } else {
          done({ value: value === undefined ? null : value });
        }
      }, (error) => done({ rejected: error ?? null }));
    `,
    [command, args, raw ? Buffer.from(raw).toString('base64') : null, headers ?? null],
  );
  if ('binary' in outcome) return Buffer.from(outcome.binary, 'base64');
  if ('rejected' in outcome) return { rejected: outcome.rejected };
  return outcome.value;
}

function exitOf(child, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('process did not exit'));
    }, timeout);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Talks to the binary in native messaging host mode, like Chrome. */
function startHost(extensionId = OFFICIAL_EXTENSION_ID) {
  const host = spawn(application, [`chrome-extension://${extensionId}/`], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // A host that exits early must not take the test down with EPIPE.
  host.stdin.on('error', () => undefined);
  let buffer = Buffer.alloc(0);
  const received = [];
  const waiting = [];
  host.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else received.push(message);
    }
  });
  const next = () =>
    received.length > 0
      ? Promise.resolve(received.shift())
      : new Promise((resolve) => waiting.push(resolve));
  return {
    host,
    next,
    ask(message) {
      const json = Buffer.from(JSON.stringify(message), 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32LE(json.length);
      host.stdin.write(Buffer.concat([length, json]));
      return next();
    },
  };
}

/** Sends a document through the host and returns the transfer id. */
async function sendFromChrome(name, bytes) {
  const { host, ask } = startHost();
  const hello = await ask({ type: 'hello' });
  assert.equal(hello.type, 'hello');
  assert.equal(hello.protocol, 1);
  const ready = await ask({ type: 'begin', name, size: bytes.length, sha256: sha256(bytes) });
  assert.equal(ready.type, 'ready', JSON.stringify(ready));
  const half = Math.ceil(bytes.length / 2);
  const chunks = [bytes.subarray(0, half), bytes.subarray(half)];
  for (const [index, chunk] of chunks.entries()) {
    const ack = await ask({
      type: 'chunk',
      transfer: ready.transfer,
      index,
      data: chunk.toString('base64'),
    });
    assert.deepEqual(ack, { type: 'ack', index });
  }
  const done = await ask({ type: 'end', transfer: ready.transfer });
  assert.deepEqual(done, { type: 'done', transfer: ready.transfer });
  host.stdin.end();
  assert.equal(await exitOf(host), 0);
  return ready.transfer;
}

const tabCount = () => run(`return document.querySelectorAll('button[data-document-tab]').length`);

try {
  await waitForDriver();
  ({ sessionId: session } = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: { 'tauri:options': { application, args: [document] } },
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

  await test('lays out selectable text over the page in WebKit', async () => {
    const text = await waitFor(`
      const spans = [...document.querySelectorAll('[data-page="1"] .textLayer span')];
      return spans.length > 0 && spans.map((span) => span.textContent).join(' ');
    `);
    assert.match(text, /The quick brown fox jumps over the lazy dog\./);
    // The invisible text sits over the drawn text: the span is inside the page box.
    const inside = await run(`
      const page = document.querySelector('[data-page="1"]').getBoundingClientRect();
      const span = [...document.querySelectorAll('[data-page="1"] .textLayer span')]
        .find((s) => s.textContent.includes('quick brown fox')).getBoundingClientRect();
      return span.width > 50 && span.left > page.left && span.right < page.right &&
        span.top > page.top && span.bottom < page.bottom;
    `);
    assert.equal(inside, true);
  });

  await test('finds and highlights text in WebKit', async () => {
    await run(`document.querySelector('button[aria-label="Find"]').click()`);
    await waitFor(`return document.activeElement?.id === 'folio-find-input'`);
    await run(`
      const input = document.getElementById('folio-find-input');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(input, 'lazy dog');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    const status = await waitFor(
      `return document.querySelector('[role="search"] [role="status"]')?.textContent || null`,
    );
    assert.equal(status, '3 results');
    await waitFor(
      `return document.querySelectorAll('[data-page="1"] .folio-hit[data-active]').length === 1`,
    );
    await run(`
      const input = document.getElementById('folio-find-input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    `);
    await waitFor(`return document.querySelector('[role="search"]') === null`);
  });

  await test('"Save a copy" refuses anything but PDF data before showing a dialog', async () => {
    const notPdf = await runAsync(`
      const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('save_pdf_as', new Uint8Array([35, 33, 47, 98, 105, 110]), {
        headers: { 'x-folio-name': 'evil.sh' },
      }).then(() => done('resolved'), (e) => done(e));
    `);
    assert.equal(notPdf.code, 'not-pdf');
    const notRaw = await runAsync(`
      const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke('save_pdf_as', { path: '/tmp/evil.pdf' })
        .then(() => done('resolved'), (e) => done(e));
    `);
    assert.equal(notRaw.code, 'invalid-request');
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
    for (const [command, args] of [
      ['plugin:dialog|open', { options: {} }],
      // The window-state plugin works natively only.
      ['plugin:window-state|save_window_state', { flags: 1 }],
    ]) {
      const error = await runAsync(
        `
        const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
          .then(() => done('resolved'), (e) => done(String(e)));
      `,
        [command, args],
      );
      assert.notEqual(error, 'resolved', command);
      assert.match(error, /not allowed|denied|permission/i, command);
    }
  });

  await test('the title bar drag region may zoom/maximize the window on double-click', async () => {
    const outcome = await runAsync(`
      const done = arguments[arguments.length - 1];
      const toggle = () => window.__TAURI_INTERNALS__.invoke('plugin:window|internal_toggle_maximize', { label: 'main' });
      toggle().then(toggle).then(() => done('allowed'), (e) => done(String(e)));
    `);
    assert.equal(outcome, 'allowed');
  });

  await test('Save writes back through a grant and refuses files changed on disk', async () => {
    const recent = await invoke('recent_list');
    const entry = recent.find((file) => file.name === 'basic-3-pages.pdf');
    assert.ok(entry, JSON.stringify(recent));
    // Recent files reach the page without their location.
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'openedAt']);
    assert.ok(!JSON.stringify(recent).includes(work));

    const opened = await invoke('recent_open', { id: entry.id });
    assert.equal(opened.files.length, 1, JSON.stringify(opened));
    const { token } = opened.files[0];

    const original = readFileSync(document);
    const replacement = readFileSync(join(fixtures, 'outline-and-text.pdf'));
    const headers = (expected) => ({
      'x-folio-token': token,
      'x-folio-expected-sha256': expected,
    });
    const saved = await invoke(
      'write_granted_file',
      {},
      {
        raw: replacement,
        headers: headers(sha256(original)),
      },
    );
    assert.deepEqual(saved, { status: 'saved' });
    assert.ok(readFileSync(document).equals(replacement), 'the file on disk was replaced');

    // Someone else edits the file; Folio's next save must not clobber it.
    const edited = Buffer.concat([replacement, Buffer.from('\n% edited elsewhere\n')]);
    writeFileSync(document, edited);
    const stale = await invoke(
      'write_granted_file',
      {},
      {
        raw: original,
        headers: headers(sha256(replacement)),
      },
    );
    assert.deepEqual(stale, { status: 'changed-on-disk' });
    assert.ok(readFileSync(document).equals(edited), 'the edited file was kept');

    const notPdf = await invoke(
      'write_granted_file',
      {},
      {
        raw: Buffer.from('#!/bin/sh\n'),
        headers: headers(sha256(edited)),
      },
    );
    assert.equal(notPdf.rejected?.code, 'not-pdf');
    assert.equal(await invoke('release_file', { token }), true);
    const released = await invoke(
      'write_granted_file',
      {},
      {
        raw: original,
        headers: headers(sha256(edited)),
      },
    );
    assert.equal(released.rejected?.code, 'unknown-token');
  });

  await test('crash recovery data round-trips through the app data folder', async () => {
    const pdf = readFileSync(join(fixtures, 'basic-3-pages.pdf'));
    const id = 'e2e-record';
    const saved = await invoke(
      'recovery_save_snapshot',
      {},
      {
        raw: Buffer.from('{"version":1}'),
        headers: {
          'x-folio-recovery-id': id,
          'x-folio-recovery-title': encodeURIComponent('Été report.pdf'),
        },
      },
    );
    assert.equal(saved, null);
    await invoke(
      'recovery_save_file',
      {},
      {
        raw: pdf,
        headers: { 'x-folio-recovery-id': id, 'x-folio-recovery-key': 'source_1' },
      },
    );
    assert.equal(await invoke('recovery_has_file', { id, key: 'source_1' }), true);
    assert.equal(await invoke('recovery_has_file', { id, key: 'missing' }), false);
    const [record, ...others] = await invoke('recovery_list');
    assert.deepEqual(others, []);
    assert.equal(record.id, id);
    assert.equal(record.title, 'Été report.pdf');
    assert.equal(record.byteLength, 13 + pdf.length);
    assert.equal(await invoke('recovery_load_snapshot', { id }), '{"version":1}');
    assert.deepEqual(await invoke('recovery_file_keys', { id }), ['source_1']);
    const loaded = await invoke('recovery_load_file', { id, key: 'source_1' });
    assert.ok(Buffer.isBuffer(loaded) && loaded.equals(pdf));
    assert.ok(existsSync(join(dataDir, 'recovery', id, 'snapshot.json')));

    const escape = await invoke('recovery_load_snapshot', { id: '../../etc' });
    assert.equal(escape.rejected?.code, 'invalid-name');
    await invoke('recovery_remove', { id });
    assert.deepEqual(await invoke('recovery_list'), []);
    assert.ok(!existsSync(join(dataDir, 'recovery', id)));
  });

  await test('a second launch opens its file in the running window and exits', async () => {
    assert.ok(session_bus, 'needs a D-Bus session on Linux');
    const before = await tabCount();
    const second = join(docs, 'second.pdf');
    copyFileSync(join(fixtures, 'outline-and-text.pdf'), second);
    const child = spawn(application, [second], { env, stdio: 'ignore' });
    assert.equal(await exitOf(child), 0);
    await waitFor(
      `return document.querySelectorAll('button[data-document-tab]').length === ${before + 1}`,
    );
    const names = await run(
      `return [...document.querySelectorAll('button[data-document-tab]')].map((tab) => tab.title)`,
    );
    assert.ok(names.includes('second.pdf'), JSON.stringify(names));
  });

  await test('documents from Chrome are spooled by the host and opened once accepted', async () => {
    // What the UI subscribes to through the adapter.
    await run(`
      window.__folioTransfers = [];
      window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
        event: 'folio://transfer-request',
        target: { kind: 'Any' },
        handler: window.__TAURI_INTERNALS__.transformCallback((event) => {
          window.__folioTransfers.push(event.payload);
        }),
      });
    `);
    const bytes = readFileSync(join(fixtures, 'outline-and-text.pdf'));
    const id = await sendFromChrome('From Chrome.pdf', bytes);
    // The host started Folio with --incoming, which the running app received.
    const request = await waitFor(
      `return window.__folioTransfers.find((request) => request.id === ${JSON.stringify(id)}) ?? null`,
    );
    assert.deepEqual(request, { id, name: 'From Chrome.pdf', size: bytes.length });
    assert.ok(existsSync(join(dataDir, 'incoming', id, 'document.pdf')));

    const opened = await invoke('answer_transfer', { id, accept: true });
    assert.equal(opened.files.length, 1, JSON.stringify(opened));
    const [file] = opened.files;
    assert.equal(file.name, 'From Chrome.pdf');
    const read = await invoke('read_granted_file', { token: file.token });
    assert.ok(read.equals(bytes));
    // There is no file to save back to: Save As is the way out.
    const save = await invoke(
      'write_granted_file',
      {},
      {
        raw: bytes,
        headers: { 'x-folio-token': file.token, 'x-folio-expected-sha256': sha256(bytes) },
      },
    );
    assert.equal(save.status, 'unavailable');
    const again = await invoke('answer_transfer', { id, accept: true });
    assert.equal(again.rejected?.code, 'unknown-transfer');
    assert.equal(await invoke('release_file', { token: file.token }), true);
    assert.ok(!existsSync(join(dataDir, 'incoming', id)), 'released documents are deleted');

    const declined = await sendFromChrome('Unwanted.pdf', bytes);
    await waitFor(
      `return window.__folioTransfers.some((request) => request.id === ${JSON.stringify(declined)})`,
    );
    assert.deepEqual(await invoke('answer_transfer', { id: declined, accept: false }), {
      files: [],
      skipped: [],
      unavailable: [],
      refused: [],
    });
    assert.ok(!existsSync(join(dataDir, 'incoming', declined)), 'declined documents are deleted');
  });

  await test("Folio's own data and spooled documents only open as transfers", async () => {
    // macOS hands Folio the document of a waiting transfer (LaunchServices):
    // it is offered like any transfer and not opened as a file.
    const bytes = readFileSync(join(fixtures, 'outline-and-text.pdf'));
    const id = randomUUID();
    const entry = join(dataDir, 'incoming', id);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'document.pdf'), bytes);
    writeFileSync(
      join(entry, 'meta.json'),
      JSON.stringify({
        name: 'Waiting.pdf',
        size: bytes.length,
        createdAt: new Date().toISOString(),
      }),
    );
    const before = await tabCount();
    const offering = spawn(application, [join(entry, 'document.pdf')], { env, stdio: 'ignore' });
    assert.equal(await exitOf(offering), 0);
    const request = await waitFor(
      `return window.__folioTransfers.find((request) => request.id === ${JSON.stringify(id)}) ?? null`,
    );
    assert.deepEqual(request, { id, name: 'Waiting.pdf', size: bytes.length });
    assert.equal(await tabCount(), before);
    await invoke('answer_transfer', { id, accept: false });
    assert.ok(!existsSync(entry), 'declined documents are deleted');

    // Anything else in the data folder or shaped like a spooled document is
    // refused with a notice, and never granted or listed as recent.
    const own = join(dataDir, 'notes.pdf');
    copyFileSync(join(fixtures, 'basic-3-pages.pdf'), own);
    const elsewhere = join(work, 'elsewhere', 'incoming', randomUUID());
    mkdirSync(elsewhere, { recursive: true });
    copyFileSync(join(fixtures, 'basic-3-pages.pdf'), join(elsewhere, 'document.pdf'));
    const refusing = spawn(application, [own, join(elsewhere, 'document.pdf')], {
      env,
      stdio: 'ignore',
    });
    assert.equal(await exitOf(refusing), 0);
    await waitFor(
      `return document.querySelectorAll('button[data-document-tab]').length === ${before + 2}`,
    );
    await waitFor(`return document.querySelector('main')?.innerText?.includes('own data folder')`);
    const recent = await invoke('recent_list');
    assert.ok(
      !recent.some((file) => ['notes.pdf', 'document.pdf'].includes(file.name)),
      JSON.stringify(recent),
    );
  });

  await test('the host refuses extensions Folio does not know', async () => {
    const before = readdirSync(join(dataDir, 'incoming')).length;
    const { host, next } = startHost(OTHER_EXTENSION_ID);
    const reply = await next();
    assert.equal(reply.type, 'error');
    assert.equal(reply.code, 'origin-not-allowed');
    host.stdin.end();
    assert.notEqual(await exitOf(host), 0);
    assert.equal(readdirSync(join(dataDir, 'incoming')).length, before);
  });

  await test('confirming or cancelling a close does nothing unless one was requested', async () => {
    assert.equal(await invoke('confirm_close'), false);
    assert.equal(await invoke('cancel_close'), false);
    assert.equal(await invoke('set_close_guard', { enabled: false }), null);
  });

  await test('closing the last tab returns to the start screen', async () => {
    while ((await tabCount()) > 0) {
      await run(
        `document.querySelector('nav[aria-label="Open documents"] button[aria-label^="Close "]').click()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await waitFor(
      `return document.querySelector('main')?.textContent?.includes('Open a PDF to get started')`,
    );
  });

  await test('only Folio itself can connect to Chrome, never the page', async () => {
    assert.deepEqual(await invoke('native_messaging_status'), {
      registered: false,
      extensionIds: [],
    });
    // Even with Chrome installed, the page has no way to register Folio.
    const chrome = join(configDir, 'google-chrome');
    mkdirSync(chrome, { recursive: true });
    for (const [command, args] of [
      ['register_native_messaging', { extensionIds: [OTHER_EXTENSION_ID] }],
      ['register_native_messaging', { extensionIds: [] }],
      ['unregister_native_messaging', {}],
    ]) {
      const outcome = await invoke(command, args);
      assert.ok(outcome?.rejected, `${command} is not available to the page`);
    }
    assert.deepEqual(readdirSync(chrome), [], 'no manifest was written');
    assert.ok(!existsSync(join(dataDir, 'native-messaging.json')));
    assert.deepEqual(await invoke('native_messaging_status'), {
      registered: false,
      extensionIds: [],
    });
  });
} catch (error) {
  failed = true;
  results.push(`✗ setup: ${error.message}`);
} finally {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => undefined);
  driver.kill();
  session_bus?.bus.kill();
  rmSync(work, { recursive: true, force: true });
}

console.log(results.join('\n'));
process.exit(failed ? 1 : 0);
