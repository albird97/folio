import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import {
  chooseFiles,
  download,
  expectAccessible,
  FIXTURE_PASSWORD,
  pageRendered,
  pngSize,
  unzip,
} from '../helpers';

/**
 * The export tools: pages as images, text (recognized text included),
 * reduce file size and password protection. Files arrive as downloads and
 * are read back here.
 */

async function open(page: Page, name: string) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [name]);
  await pageRendered(page);
}

/** Opens bytes made in the test as if the user had chosen the file. */
async function openBytes(page: Page, name: string, bytes: Uint8Array) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose PDF/ }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
}

async function tool(page: Page, item: string, dialog: string) {
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: item }).click();
  const opened = page.getByRole('dialog', { name: dialog });
  await expect(opened).toBeVisible();
  return opened;
}

const notice = (page: Page, text: string | RegExp) =>
  expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();

/** axe in the light theme, then the dark one (once the app has switched), then light again. */
async function expectAccessibleInBothThemes(page: Page, label: string) {
  const root = page.locator('html');
  await expectAccessible(page, label);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expectAccessible(page, `${label} (dark)`);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'light');
}

/** A large JPEG photo at high quality, made by the browser (gradients with grain). */
async function browserJpeg(page: Page, width: number, height: number): Promise<Uint8Array> {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext('2d')!;
      const image = context.createImageData(w, h);
      for (let index = 0; index < w * h; index += 1) {
        const grain = Math.random() * 16 - 8;
        const x = index % w;
        image.data.set(
          [90 + (x / w) * 120 + grain, 140 + grain, 200 - (x / w) * 90, 255],
          index * 4,
        );
      }
      context.putImageData(image, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    [width, height],
  );
  return new Uint8Array(bytes);
}

/**
 * A page with two large photo-like images (gradients with grain): one stored
 * as Flate, the way scanners and many apps do, the other as a high-quality
 * JPEG. Both are bigger than they need to be.
 */
async function photoPdf(jpeg: Uint8Array): Promise<Uint8Array> {
  const width = 2400;
  const height = 1600;
  const samples = new Uint8Array(width * height * 3);
  let seed = 11;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = ((seed >> 16) % 13) - 6;
      const at = (y * width + x) * 3;
      samples[at] = 60 + (150 * x) / width + grain;
      samples[at + 1] = 80 + (120 * y) / height + grain;
      samples[at + 2] = 170 - (90 * (x + y)) / (width + height) + grain;
    }
  }
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pdfPage = doc.addPage([720, 480]);
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
  pdfPage.node.setXObject(PDFName.of('Photo'), image);
  const scan = doc.context.register(
    doc.context.stream(jpeg, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2600,
      Height: 1700,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
    }),
  );
  pdfPage.node.setXObject(PDFName.of('Scan'), scan);
  pdfPage.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        'q 360 0 0 240 0 240 cm /Photo Do Q\nq 360 0 0 240 360 0 cm /Scan Do Q\n',
      ),
    ),
  );
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

test.describe('export tools', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('exports pages as PNG images in a ZIP archive, or one page as a JPEG', async ({ page }) => {
    await open(page, 'outline-and-text.pdf');
    let dialog = await tool(page, 'Export pages as images…', 'Export pages as images');
    await expect(dialog.getByRole('radio', { name: 'All 6 pages' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /Include comments/ })).toBeChecked();
    await expectAccessibleInBothThemes(page, 'export images dialog');

    await dialog.getByRole('textbox', { name: 'Pages to export' }).fill('2-3');
    await expect(dialog.getByRole('radio', { name: /^Pages/ })).toBeChecked();
    await dialog.getByRole('radio', { name: '72 dpi' }).click();
    await expect(dialog.getByText('Saved as one ZIP file of images.')).toBeVisible();
    const zip = await download(page, () => dialog.getByRole('button', { name: 'Export…' }).click());
    expect(zip.name).toBe('outline-and-text (images).zip');
    const entries = unzip(zip.bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      'outline-and-text-page-2.png',
      'outline-and-text-page-3.png',
    ]);
    for (const entry of entries) {
      expect([...entry.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // Letter at 72 dpi.
      expect(pngSize(entry.bytes)).toEqual([612, 792]);
    }
    await expect(dialog).toBeHidden();
    await notice(page, 'Downloading outline-and-text (images).zip.');

    dialog = await tool(page, 'Export pages as images…', 'Export pages as images');
    await dialog.getByRole('radio', { name: /^Current page/ }).check();
    await dialog.getByRole('radio', { name: 'JPEG' }).click();
    await expect(dialog.getByRole('slider', { name: 'Quality' })).toHaveValue('85');
    await expectAccessible(page, 'export images dialog, JPEG');
    const jpeg = await download(page, () =>
      dialog.getByRole('button', { name: 'Export…' }).click(),
    );
    expect(jpeg.name).toBe('outline-and-text-page-1.jpg');
    expect([...jpeg.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  test('exports the text of pages, recognized text included', async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'scanned-pages.pdf');

    // Pictures of text only: the dialog says how to read them.
    let dialog = await tool(page, 'Export text…', 'Export text');
    await expectAccessible(page, 'export text dialog');
    await dialog.getByRole('button', { name: 'Show text' }).click();
    await expect(dialog.getByText('These pages have no text.')).toBeVisible();
    await expectAccessible(page, 'export text dialog, no text');
    await dialog.getByRole('button', { name: 'Recognize text…' }).click();

    const recognize = page.getByRole('dialog', { name: 'Recognize text' });
    await recognize.getByRole('radio', { name: /^Current page/ }).check();
    await recognize.getByRole('button', { name: 'Recognize text' }).click();
    await expect(recognize.getByText(/^Found \d+ words on 1 page\.$/)).toBeVisible({
      timeout: 90_000,
    });
    await recognize.getByRole('button', { name: 'Done' }).click();

    dialog = await tool(page, 'Export text…', 'Export text');
    await dialog.getByRole('button', { name: 'Show text' }).click();
    const text = dialog.getByRole('textbox', { name: 'Text of the pages' });
    await expect(text).toHaveValue(/lighthouse keeper/);
    await expectAccessible(page, 'export text dialog, text');
    const shown = await text.inputValue();
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
    const saved = await download(page, () =>
      dialog.getByRole('button', { name: 'Save as .txt…' }).click(),
    );
    expect(saved.name).toBe('scanned-pages (text).txt');
    expect(saved.bytes.toString('utf8')).toBe(shown);
    await notice(page, 'Downloading scanned-pages (text).txt.');
  });

  test('reduces the size of a document with a large photo', async ({ page }) => {
    const original = await photoPdf(await browserJpeg(page, 2600, 1700));
    await openBytes(page, 'photo.pdf', original);
    await pageRendered(page);
    const dialog = await tool(page, 'Reduce file size…', 'Reduce file size');
    await expect(dialog.getByRole('radio', { name: 'Balanced' })).toBeChecked();
    await expectAccessibleInBothThemes(page, 'reduce file size dialog');

    await dialog.getByRole('button', { name: 'Reduce file size' }).click();
    await expect(dialog.getByRole('status')).toHaveText(/^[\d.]+ MB → [\d.]+ (KB|MB) \(−\d+%\)$/, {
      timeout: 30_000,
    });
    await expectAccessible(page, 'reduce file size dialog, result');
    const smaller = await download(page, () =>
      dialog.getByRole('button', { name: 'Save as…' }).click(),
    );
    expect(smaller.name).toBe('photo (compressed).pdf');
    expect(smaller.bytes.length).toBeLessThan(original.length / 2);

    // The same page, its photo now a JPEG at most 2000 pixels wide.
    const pdf = await PDFDocument.load(smaller.bytes, { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(1);
    const xobjects = pdf.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const photo = xobjects.lookup(PDFName.of('Photo'), PDFRawStream);
    expect(photo.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
    expect(photo.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(2000);
    expect(photo.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(1333);
    // The JPEG went through the browser's decoder too, and got smaller.
    const scan = xobjects.lookup(PDFName.of('Scan'), PDFRawStream);
    expect(scan.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(2000);
    expect(scan.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(1308);
    expect([...scan.contents.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await notice(page, 'Downloading photo (compressed).pdf.');
  });

  test('saves a copy that needs a password and restricts what readers may do', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const dialog = await tool(page, 'Password protection…', 'Password protection');
    await expect(dialog.getByText('This document is not protected.')).toBeVisible();
    const save = dialog.getByRole('button', { name: 'Save protected copy…' });
    await expect(save).toBeDisabled();

    await dialog.getByLabel('Password', { exact: true }).fill('folio');
    await expect(dialog.getByText(/^Weak:/)).toBeVisible();
    await dialog.getByLabel('Password', { exact: true }).fill('Lighthouse keeper 7');
    await expect(dialog.getByText('Strong.')).toBeVisible();
    await dialog.getByLabel('Confirm password').fill('Lighthouse keeper');
    await expect(dialog.getByRole('alert')).toHaveText('The passwords do not match.');
    await expect(save).toBeDisabled();
    await dialog.getByLabel('Confirm password').fill('Lighthouse keeper 7');
    await dialog.getByRole('button', { name: 'Show passwords' }).click();
    await expect(dialog.getByLabel('Confirm password')).toHaveAttribute('type', 'text');

    await dialog.getByRole('checkbox', { name: 'Restrict printing, copying and changes' }).check();
    await dialog.getByRole('checkbox', { name: 'Printing', exact: true }).check();
    await expect(dialog.getByText(/nobody can lift the restrictions/)).toBeVisible();
    await expectAccessibleInBothThemes(page, 'password protection dialog');

    const copy = await download(page, () => save.click());
    expect(copy.name).toBe('basic-3-pages (protected).pdf');
    await notice(page, 'Downloading basic-3-pages (protected).pdf.');
    await expect(PDFDocument.load(copy.bytes, { updateMetadata: false })).rejects.toThrow();
    const pdf = await PDFDocument.load(copy.bytes, {
      updateMetadata: false,
      password: 'Lighthouse keeper 7',
    });
    expect(pdf.getPageCount()).toBe(3);
    // AES-256 (V 5, R 6), allowing printing (bit 3, and 12 for high quality)
    // and extraction for accessibility (bit 10, always allowed), nothing else.
    // The encryption dictionary itself is never encrypted.
    const raw = copy.bytes.toString('latin1');
    const start = raw.indexOf('/Filter /Standard');
    const encrypt = raw.slice(start, start + 800);
    expect(encrypt).toMatch(/\/V 5\b/);
    expect(encrypt).toMatch(/\/R 6\b/);
    const flags = Number(/\/P (-?\d+)/.exec(encrypt)![1]);
    expect(flags & 0b1111_0011_1100).toBe(0b1010_0000_0100);
    // The open document did not change.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  test('changes and removes the password of a protected document', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'encrypted-user-password.pdf',
    ]);
    await page.getByLabel('Password', { exact: true }).fill(FIXTURE_PASSWORD);
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await pageRendered(page);

    let dialog = await tool(page, 'Password protection…', 'Password protection');
    await expect(dialog.getByText('This document needs a password to open.')).toBeVisible();
    await dialog.getByLabel('Password', { exact: true }).fill('a brand new password');
    await dialog.getByLabel('Confirm password').fill('a brand new password');
    const changed = await download(page, () =>
      dialog.getByRole('button', { name: 'Save protected copy…' }).click(),
    );
    await expect(
      PDFDocument.load(changed.bytes, { updateMetadata: false, password: FIXTURE_PASSWORD }),
    ).rejects.toThrow();
    const reopened = await PDFDocument.load(changed.bytes, {
      updateMetadata: false,
      password: 'a brand new password',
    });
    expect(reopened.getPageCount()).toBe(3);

    dialog = await tool(page, 'Password protection…', 'Password protection');
    await dialog.getByRole('radio', { name: 'Remove password protection' }).check();
    await expectAccessible(page, 'password protection dialog, remove');
    const plain = await download(page, () =>
      dialog.getByRole('button', { name: 'Save without protection…' }).click(),
    );
    expect(plain.name).toBe('encrypted-user-password (unprotected).pdf');
    const pdf = await PDFDocument.load(plain.bytes, { updateMetadata: false });
    expect(pdf.isEncrypted).toBe(false);
    expect(pdf.getPageCount()).toBe(3);
  });

  test('cannot remove restrictions set by the author', async ({ page }) => {
    await open(page, 'encrypted-owner-restricted.pdf');
    const dialog = await tool(page, 'Password protection…', 'Password protection');
    await expect(dialog.getByText(/opens without a password, but does not allow/)).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Remove password protection' })).toBeDisabled();
    await expect(dialog.getByText(/Only the author can remove its restrictions/)).toBeVisible();
    // Its restrictions stay in a copy with a password to open.
    await expect(
      dialog.getByRole('checkbox', { name: 'Restrict printing, copying and changes' }),
    ).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: 'Printing', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: 'Printing', exact: true })).not.toBeChecked();
    await expectAccessible(page, 'password protection dialog, restricted');
  });
});
