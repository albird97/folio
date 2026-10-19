import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
export const fixture = (name: string) => join(FIXTURES, name);
export const FIXTURE_PASSWORD = 'folio-test';

/** Fails on any WCAG 2.1 A/AA violation. */
export async function expectAccessible(page: Page, label = 'page') {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

/** Opens files through the file chooser that `trigger` causes. */
export async function chooseFiles(page: Page, trigger: () => Promise<unknown>, names: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await trigger();
  await (await chooser).setFiles(names.map(fixture));
}

/** Simulates dropping files from the OS onto `selector`. */
export async function dropFiles(
  page: Page,
  selector: string,
  files: Array<{ name: string; bytes?: Buffer; type?: string }>,
) {
  const payload = files.map((file) => ({
    name: file.name,
    type: file.type ?? 'application/pdf',
    base64: (file.bytes ?? readFileSync(fixture(file.name))).toString('base64'),
  }));
  const dataTransfer = await page.evaluateHandle((items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      const bytes = Uint8Array.from(atob(item.base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], item.name, { type: item.type }));
    }
    return transfer;
  }, payload);
  for (const type of ['dragenter', 'dragover', 'drop']) {
    await page.dispatchEvent(selector, type, { dataTransfer });
  }
}

/** Waits until page `pageNumber` (1-based) of the active document has been drawn. */
export const pageRendered = (page: Page, pageNumber = 1) =>
  expect(page.locator(`[data-page="${pageNumber}"] [data-testid="page-canvas"]`)).toHaveAttribute(
    'data-render-state',
    'done',
  );

/** Records in Folio's recovery store (IndexedDB) for this origin. */
export const recoveryRecords = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('folio-recovery', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('records')) {
            db.close();
            resolve(0);
            return;
          }
          const count = db.transaction('records').objectStore('records').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
      }),
  );

/** Runs `action` and returns the name and bytes of the file it downloads. */
export async function download(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('download');
  await action();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

/** Entries of a stored (uncompressed) ZIP archive, read from its central directory. */
export function unzip(zip: Buffer): Array<{ name: string; bytes: Buffer }> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  for (let index = 0; index < count; index += 1) {
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    entries.push({ name, bytes: zip.subarray(data, data + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Width and height from a PNG's header. */
export const pngSize = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];
