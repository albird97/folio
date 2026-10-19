import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { makeLargePdf } from '../../setup/fixtures';
import { download, pageRendered } from '../helpers';

/**
 * Saving and compressing large documents keeps the page responsive: the
 * exporter runs in a worker, so the main thread has no long task anywhere
 * near the time the export takes. Times and the longest main-thread task are
 * recorded as annotations. The budget is generous so that it holds on slow CI
 * machines, yet well below what exporting on the main thread blocked it for
 * in these tests (about 0.55 s saving, 0.8 s compressing; none in a worker).
 */

/** No main-thread task while exporting may take longer than this. */
const LONGEST_TASK_BUDGET_MS = 250;

async function openBytes(page: Page, name: string, bytes: Uint8Array) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose PDF/ }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await pageRendered(page);
}

/**
 * Records the main thread's long tasks (Long Tasks API) while `action` runs
 * and returns how long the action took and the longest task.
 */
async function measure(page: Page, action: () => Promise<unknown>) {
  await page.evaluate(() => {
    const tasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration);
    });
    observer.observe({ type: 'longtask' });
    Object.assign(window, { folioLongTasks: { tasks, observer } });
  });
  const started = Date.now();
  const result = await action();
  const elapsed = Date.now() - started;
  const longest = await page.evaluate(async () => {
    // Entries are delivered after the task that ends them.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { tasks, observer } = (
      window as unknown as {
        folioLongTasks: { tasks: number[]; observer: PerformanceObserver };
      }
    ).folioLongTasks;
    observer.disconnect();
    return Math.round(Math.max(0, ...tasks));
  });
  return { result, elapsed, longest };
}

/** Shows a measurement in the test report. */
const record = (type: string, ms: number) =>
  test.info().annotations.push({ type, description: `${ms} ms` });

/**
 * Pages each showing a large photo-like Flate image (gradients with grain),
 * the kind "Reduce file size" re-encodes as JPEG.
 */
async function photosPdf(pageCount: number): Promise<Uint8Array> {
  const width = 4000;
  const height = 2700;
  const doc = await PDFDocument.create({ updateMetadata: false });
  let seed = 7;
  for (let index = 0; index < pageCount; index += 1) {
    const samples = new Uint8Array(width * height * 3);
    for (let at = 0; at < samples.length; at += 3) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = ((seed >> 16) % 13) - 6;
      const x = (at / 3) % width;
      samples[at] = 60 + (150 * x) / width + grain + index * 10;
      samples[at + 1] = 120 + grain;
      samples[at + 2] = 170 - (90 * x) / width + grain;
    }
    const image = doc.context.register(
      doc.context.stream(deflateSync(samples), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
      }),
    );
    const pdfPage = doc.addPage([720, 480]);
    pdfPage.node.setXObject(PDFName.of('Photo'), image);
    pdfPage.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 720 0 0 480 0 0 cm /Photo Do Q\n')),
    );
  }
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

test.describe('exporting large documents', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('saves 5,000 stamped pages without blocking the page', async ({ page }) => {
    test.slow();
    const pageCount = 5000;
    await openBytes(page, 'large.pdf', await makeLargePdf(pageCount));
    await expect(page.getByText('Reading page sizes…')).toBeHidden({ timeout: 30_000 });
    // Page numbers and a watermark give the exporter work on every page.
    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Page numbers…' }).click();
    const numbers = page.getByRole('dialog', { name: 'Page numbers' });
    await numbers.getByRole('button', { name: 'Apply' }).click();
    await expect(numbers).toBeHidden();
    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Watermark…' }).click();
    const watermark = page.getByRole('dialog', { name: 'Watermark' });
    await watermark.getByRole('textbox', { name: 'Text' }).fill('CONFIDENTIAL');
    await watermark.getByRole('button', { name: 'Apply' }).click();
    await expect(watermark).toBeHidden();
    await expect(page.locator('[data-stamp-layer="1"] [data-stamp="pageNumbers"]')).toBeVisible();
    await expect(page.locator('[data-stamp-layer="1"] [data-stamp="watermark"]')).toBeVisible();

    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    const { result, elapsed, longest } = await measure(page, () =>
      download(page, () => page.getByRole('button', { name: 'Download PDF' }).click()),
    );
    record('time to save', elapsed);
    record('longest main-thread task', longest);
    // Written by the export worker, a script of the app's own.
    expect(workers).toContainEqual(expect.stringMatching(/\/assets\/export\.worker-[\w-]+\.js$/));
    const saved = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(saved.getPageCount()).toBe(pageCount);
    expect(longest).toBeLessThan(LONGEST_TASK_BUDGET_MS);
  });

  test('compresses large photos without blocking the page', async ({ page }) => {
    test.slow();
    const original = await photosPdf(2);
    await openBytes(page, 'photos.pdf', original);
    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Reduce file size…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reduce file size' });
    await expect(dialog.getByRole('radio', { name: 'Balanced' })).toBeChecked();

    const { elapsed, longest } = await measure(page, async () => {
      await dialog.getByRole('button', { name: 'Reduce file size' }).click();
      await expect(dialog.getByRole('status')).toHaveText(/ MB → /, { timeout: 60_000 });
    });
    record('time to compress', elapsed);
    record('longest main-thread task', longest);
    const smaller = await download(page, () =>
      dialog.getByRole('button', { name: 'Save as…' }).click(),
    );
    expect(smaller.bytes.length).toBeLessThan(original.length / 2);
    expect((await PDFDocument.load(smaller.bytes)).getPageCount()).toBe(2);
    expect(longest).toBeLessThan(LONGEST_TASK_BUDGET_MS);
  });
});
