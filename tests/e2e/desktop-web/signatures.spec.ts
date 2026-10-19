import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
} from '@cantoo/pdf-lib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';

/**
 * Signatures: drawn, typed or imported pictures of a signature, placed on a
 * page or into a signature field, remembered on the device when asked.
 * Saved files are read back with pdf-lib.
 */

async function open(page: Page, name: string) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [name]);
  await pageRendered(page);
}

const tool = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: 'Comment and drawing tools' }).getByRole('radio', { name });
const signatureDialog = (page: Page) => page.getByRole('dialog', { name: 'Add a signature' });
const annotationGroups = (page: Page, pageNumber = 1) =>
  page.locator(`[data-annotation-layer="${pageNumber}"] [data-annotation-id]`);
const pageView = (page: Page) => page.getByRole('region', { name: 'Page view' });

async function openSignatureDialog(page: Page) {
  await tool(page, 'Sign').click();
  const dialog = signatureDialog(page);
  await expect(dialog.getByRole('tablist', { name: 'How to sign' })).toBeVisible();
  return dialog;
}

/** Confirms the dialog: the Sign tool then waits for the signature to be placed. */
async function startPlacing(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Place on page' }).click();
  await expect(dialog).toBeHidden();
}

async function pageBox(page: Page, pageNumber = 1) {
  const box = await page.locator(`[data-page="${pageNumber}"]`).boundingBox();
  if (!box) throw new Error(`page ${pageNumber} is not visible`);
  return box;
}

/** Signs the pad with a wave, as a mouse would. */
async function drawOnPad(page: Page, dialog: Locator) {
  const pad = (await dialog.getByRole('img', { name: 'Signature pad' }).boundingBox())!;
  await page.mouse.move(pad.x + 40, pad.y + pad.height * 0.6);
  await page.mouse.down();
  for (let step = 1; step <= 30; step += 1) {
    const t = step / 30;
    await page.mouse.move(
      pad.x + 40 + t * (pad.width - 80),
      pad.y + pad.height * (0.6 - 0.25 * Math.sin(t * Math.PI * 3)),
    );
  }
  await page.mouse.up();
}

/** Runs `action` and returns the bytes of the file it downloads. */
async function download(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('download');
  await action();
  return readFileSync((await (await pending).path())!);
}

const saveAs = (page: Page) =>
  download(page, () => page.getByRole('button', { name: 'Download PDF' }).click());

const saveFlattened = async (page: Page) => {
  await page.getByRole('button', { name: 'More ways to save' }).click();
  return download(page, () =>
    page.getByRole('menuitem', { name: 'Download with comments flattened' }).click(),
  );
};

interface SavedImage {
  width: number;
  height: number;
  /** It has an alpha channel (pdf-lib writes a PNG's alpha as a soft mask). */
  transparent: boolean;
  /** The colour of its most opaque pixel (both channels are deflated, unfiltered bytes). */
  ink: [number, number, number] | null;
}

function imageIn(form: PDFStream): SavedImage {
  const resources = form.dict.lookup(PDFName.of('Resources'), PDFDict);
  const image = resources.lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('Im0'));
  if (!(image instanceof PDFRawStream)) throw new Error('No image');
  expect(image.dict.get(PDFName.of('Subtype'))?.toString()).toBe('/Image');
  const number = (key: string) => image.dict.lookup(PDFName.of(key), PDFNumber).asNumber();
  const width = number('Width');
  const height = number('Height');
  const mask = image.dict.lookup(PDFName.of('SMask'));
  let ink: SavedImage['ink'] = null;
  if (mask instanceof PDFRawStream) {
    const rgb = inflateSync(image.contents);
    const alpha = inflateSync(mask.contents);
    let best = 0;
    for (let index = 1; index < alpha.length; index += 1) {
      if (alpha[index]! > alpha[best]!) best = index;
    }
    ink = [rgb[best * 3]!, rgb[best * 3 + 1]!, rgb[best * 3 + 2]!];
  }
  return { width, height, transparent: mask !== undefined, ink };
}

/** The signatures saved as annotations, by page. */
async function savedSignatures(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((pdfPage) => {
    const annots = pdfPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const found: Array<{ name: string; rect: number[]; rotate: number; image: SavedImage }> = [];
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const annot = annots!.lookup(index, PDFDict);
      if (annot.get(PDFName.of('Subtype'))?.toString() !== '/Stamp') continue;
      const appearance = annot.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
      if (!(appearance instanceof PDFStream)) throw new Error('No appearance');
      found.push({
        name: annot.get(PDFName.of('Name'))!.toString(),
        rect: annot
          .lookup(PDFName.of('Rect'), PDFArray)
          .asArray()
          .map((value) => (value as PDFNumber).asNumber()),
        rotate: annot.lookupMaybe(PDFName.of('Rotate'), PDFNumber)?.asNumber() ?? 0,
        image: imageIn(appearance),
      });
    }
    return found;
  });
}

/** Images drawn by Folio into the page content (flattened annotations), by page. */
async function flattenedImages(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((pdfPage) => {
    const xobjects = pdfPage.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const images: SavedImage[] = [];
    for (const [name, value] of xobjects?.entries() ?? []) {
      if (!name.toString().startsWith('/FolioAnnot')) continue;
      const form = doc.context.lookup(value);
      if (form instanceof PDFStream) images.push(imageIn(form));
    }
    return images;
  });
}

/**
 * Opens the signature dialog for a signature field, as signing a form field
 * does. No control in this build opens it that way, so the test reaches the
 * workspace's UI store through React's internals.
 */
async function signFieldDialog(
  page: Page,
  rect: { x: number; y: number; width: number; height: number },
) {
  await page.evaluate((field) => {
    interface Stores {
      ui: { getState(): { openDialog(request: unknown): void } };
      workspace: {
        getState(): {
          activeKey: string;
          documents: Array<{ key: string; editor: { model: { pages: Array<{ id: string }> } } }>;
        };
      };
    }
    interface Fiber {
      memoizedProps?: { value?: Partial<Stores> } | null;
      child: Fiber | null;
      sibling: Fiber | null;
    }
    const root = document.getElementById('root') as unknown as Record<string, Fiber>;
    const container = Object.keys(root).find((key) => key.startsWith('__reactContainer$'))!;
    const pending: Array<Fiber | null> = [root[container]!];
    while (pending.length > 0) {
      const fiber = pending.pop();
      if (!fiber) continue;
      const value = fiber.memoizedProps?.value;
      if (value?.ui && value.workspace) {
        const { activeKey, documents } = value.workspace.getState();
        const doc = documents.find((entry) => entry.key === activeKey)!;
        value.ui.getState().openDialog({
          kind: 'signature',
          docKey: activeKey,
          field: { pageId: doc.editor.model.pages[0]!.id, rect: field },
        });
        return;
      }
      pending.push(fiber.child, fiber.sibling);
    }
    throw new Error('The workspace was not found.');
  }, rect);
  const dialog = signatureDialog(page);
  await expect(dialog.getByRole('tablist', { name: 'How to sign' })).toBeVisible();
  return dialog;
}

/** A photo of a dark blue signature on grey paper, as a JPEG. */
const photographedSignature = (page: Page) =>
  page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 500;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e4e2dc';
    context.fillRect(0, 0, 900, 500);
    context.strokeStyle = '#1b2f7a';
    context.lineWidth = 9;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(200, 300);
    context.bezierCurveTo(300, 120, 380, 420, 460, 240);
    context.bezierCurveTo(520, 120, 600, 380, 700, 220);
    context.stroke();
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((result) => resolve(result!), 'image/jpeg', 0.9),
    );
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });

/** Size and corner transparency of the picture an <img> shows. */
const pictureOf = (image: Locator) =>
  image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(element, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      cornerAlpha: context.getImageData(0, 0, 1, 1).data[3],
    };
  });

test.describe('signatures', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('draws a signature, places it where clicked, saves it and undoes it', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const dialog = await openSignatureDialog(page);
    await expect(dialog).toContainText('not as a digital (certificate) signature');
    await expect(dialog.getByRole('button', { name: 'Place on page' })).toBeDisabled();
    await expectAccessible(page, 'signature dialog');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'signature dialog (dark)');
    await page.emulateMedia({ colorScheme: 'light' });
    await drawOnPad(page, dialog);
    await startPlacing(dialog);
    await expect(tool(page, 'Sign')).toHaveAttribute('aria-checked', 'true');
    await expect(
      page.getByRole('status').filter({ hasText: 'Click where the signature goes' }),
    ).toBeVisible();

    // A preview follows the pointer; a click puts the signature there.
    const box = await pageBox(page);
    await page.mouse.move(box.x + 280, box.y + 500);
    await page.mouse.move(box.x + 300, box.y + 520);
    const preview = page.locator('[data-signature-layer="1"] img');
    await expect(preview).toBeVisible();
    const shown = (await preview.boundingBox())!;
    await page.mouse.click(box.x + 300, box.y + 520);
    await expect(annotationGroups(page)).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Selected comment' })).toContainText('Signature');
    await expect(tool(page, 'Select')).toHaveAttribute('aria-checked', 'true');
    await expect(pageView(page)).toBeFocused();
    const placed = (await annotationGroups(page).first().locator('image').boundingBox())!;
    expect(placed.x).toBeCloseTo(shown.x, -1);
    expect(placed.y).toBeCloseTo(shown.y, -1);
    expect(placed.x + placed.width / 2).toBeCloseTo(box.x + 300, -1);

    const [first] = await savedSignatures(await saveAs(page));
    expect(first).toHaveLength(1);
    const [signature] = first!;
    expect(signature!.name).toBe('/FolioSignature');
    expect(signature!.image.transparent).toBe(true);
    // About 150 pt wide, with the drawing's proportions.
    const [x1, y1, x2, y2] = signature!.rect as [number, number, number, number];
    expect(x2 - x1).toBeCloseTo(150, 0);
    expect((x2 - x1) / (y2 - y1)).toBeCloseTo(signature!.image.width / signature!.image.height, 1);

    // Flattened, the picture is drawn into the page itself.
    const flat = await saveFlattened(page);
    expect((await savedSignatures(flat))[0]).toEqual([]);
    expect((await flattenedImages(flat))[0]).toEqual([
      expect.objectContaining({ width: signature!.image.width, transparent: true }),
    ]);

    await pageView(page).focus();
    await page.keyboard.press('Control+Z');
    await expect(annotationGroups(page)).toHaveCount(0);
    expect((await savedSignatures(await saveAs(page)))[0]).toEqual([]);
  });

  test('types a signature in the handwriting font and places it with the keyboard', async ({
    page,
  }) => {
    await open(page, 'basic-3-pages.pdf');
    await pageView(page).focus();
    // S opens the dialog, like the toolbar's Sign button.
    await page.keyboard.press('s');
    const dialog = signatureDialog(page);
    await dialog.getByRole('tab', { name: 'Type' }).click();
    const name = dialog.getByRole('textbox', { name: 'Your name' });
    await name.fill('Ada Lovelace');
    await dialog.getByRole('radio', { name: 'Dark blue' }).click();
    // The bundled font is loaded only now, for the preview.
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.fonts].some(
            (face) => face.family === 'Folio Signature' && face.status === 'loaded',
          ),
        ),
      )
      .toBe(true);
    await expectAccessible(page, 'typed signature');
    await name.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(pageView(page)).toBeFocused();

    // Escape gives up placing; Enter puts the signature in the middle of the page.
    await page.keyboard.press('Escape');
    await expect(tool(page, 'Select')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('s');
    await expect(dialog.getByRole('tab', { name: 'Type' })).toBeVisible();
    await dialog.getByRole('tab', { name: 'Type' }).click();
    await expect(name).toHaveValue('');
    await name.fill('Ada Lovelace');
    await dialog.getByRole('radio', { name: 'Dark blue' }).click();
    await startPlacing(dialog);
    await page.keyboard.press('Enter');
    await expect(annotationGroups(page)).toHaveCount(1);
    // In the middle of the page, scrolled into view.
    await expect(annotationGroups(page).first().locator('image')).toBeInViewport();
    const offset = await page.evaluate(() => {
      const middle = (rect: DOMRect) => [rect.x + rect.width / 2, rect.y + rect.height / 2];
      const [pageX, pageY] = middle(
        document.querySelector('[data-page="1"]')!.getBoundingClientRect(),
      );
      const [x, y] = middle(
        document.querySelector('[data-annotation-layer="1"] image')!.getBoundingClientRect(),
      );
      return [x! - pageX!, y! - pageY!];
    });
    expect(Math.abs(offset[0]!)).toBeLessThan(2);
    expect(Math.abs(offset[1]!)).toBeLessThan(2);

    const [signature] = (await savedSignatures(await saveAs(page)))[0]!;
    expect(signature!.name).toBe('/FolioSignature');
    // Typed names are wide; the ink is dark blue.
    expect(signature!.image.width).toBeGreaterThan(signature!.image.height * 3);
    const [red, green, blue] = signature!.image.ink!;
    expect(blue).toBeGreaterThan(red + 60);
    expect(blue).toBeGreaterThan(green + 40);
  });

  test('imports a picture of a signature and makes its paper transparent', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const jpeg = Buffer.from(await photographedSignature(page));
    const dialog = await openSignatureDialog(page);
    await dialog.getByRole('tab', { name: 'Image' }).click();
    const removeBackground = dialog.getByRole('checkbox', { name: 'Remove the background' });
    await expect(removeBackground).toBeChecked();
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Choose a picture…' }).click();
    await (await chooser).setFiles({ name: 'signature.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    const preview = dialog.getByRole('img', { name: 'Preview of your signature' });
    await expect(preview).toBeVisible();
    // Cropped to the ink, with the paper gone.
    const cropped = await pictureOf(preview);
    expect(cropped.width).toBeLessThan(600);
    expect(cropped.height).toBeLessThan(300);
    expect(cropped.cornerAlpha).toBe(0);
    await expectAccessible(page, 'signature picture');

    // Kept as it is, the paper stays.
    await removeBackground.uncheck();
    await expect.poll(async () => (await pictureOf(preview)).width).toBe(900);
    expect((await pictureOf(preview)).cornerAlpha).toBe(255);
    await removeBackground.check();
    await expect.poll(async () => (await pictureOf(preview)).width).toBe(cropped.width);

    await startPlacing(dialog);
    const box = await pageBox(page);
    await page.mouse.click(box.x + 200, box.y + 400);
    await expect(annotationGroups(page)).toHaveCount(1);
    const [signature] = (await savedSignatures(await saveAs(page)))[0]!;
    expect(signature!.image).toMatchObject({
      width: cropped.width,
      height: cropped.height,
      transparent: true,
    });
  });

  test('remembers a signature on this device and offers it after a reload', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    let dialog = await openSignatureDialog(page);
    await drawOnPad(page, dialog);
    await dialog.getByRole('checkbox', { name: 'Remember on this device' }).check();
    await startPlacing(dialog);
    await page.keyboard.press('Escape');
    // Stored as one PNG, in this browser's storage only.
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('folio:remembered-signatures') ?? 'null'),
    );
    expect(stored.signatures).toHaveLength(1);
    expect(stored.signatures[0]).toMatch(/^iVBORw0KGgo/);

    await page.reload();
    await open(page, 'basic-3-pages.pdf');
    dialog = await openSignatureDialog(page);
    await expect(dialog.getByRole('tab', { name: 'Saved' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const saved = dialog.getByRole('radio', { name: 'Saved signature 1' });
    await expect(saved).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('checkbox', { name: 'Remember on this device' })).toHaveCount(0);
    await expectAccessible(page, 'saved signatures');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'saved signatures (dark)');
    await startPlacing(dialog);
    const box = await pageBox(page);
    await page.mouse.click(box.x + 300, box.y + 300);
    await expect(annotationGroups(page)).toHaveCount(1);
    const [signature] = (await savedSignatures(await saveAs(page)))[0]!;
    expect(signature!.image.transparent).toBe(true);

    // Deleting it forgets it.
    dialog = await openSignatureDialog(page);
    await dialog.getByRole('button', { name: 'Delete saved signature 1' }).click();
    await expect(dialog.getByRole('tab', { name: 'Saved' })).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Draw' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(dialog.getByRole('tab', { name: 'Draw' })).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('folio:remembered-signatures'))).toBe(
      null,
    );
  });

  test('signs a signature field: the signature fits the field', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const field = { x: 100, y: 100, width: 200, height: 60 };
    const dialog = await signFieldDialog(page, field);
    await expect(dialog).toContainText('for the signature field');
    await dialog.getByRole('tab', { name: 'Type' }).click();
    await dialog.getByRole('textbox', { name: 'Your name' }).fill('Grace Hopper');
    await dialog.getByRole('button', { name: 'Sign' }).click();
    await expect(dialog).toBeHidden();
    // No placing: it is in the field at once, and selected.
    await expect(annotationGroups(page)).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Selected comment' })).toContainText('Signature');
    await expect(tool(page, 'Select')).toHaveAttribute('aria-checked', 'true');

    const [signature] = (await savedSignatures(await saveAs(page)))[0]!;
    const [x1, y1, x2, y2] = signature!.rect as [number, number, number, number];
    expect(x1).toBeGreaterThan(field.x);
    expect(y1).toBeGreaterThan(field.y);
    expect(x2).toBeLessThan(field.x + field.width);
    expect(y2).toBeLessThan(field.y + field.height);
    expect((x1 + x2) / 2).toBeCloseTo(field.x + field.width / 2, 0);
    expect((y1 + y2) / 2).toBeCloseTo(field.y + field.height / 2, 0);
    expect((x2 - x1) / (y2 - y1)).toBeCloseTo(signature!.image.width / signature!.image.height, 1);
  });

  test('keeps a signature placed on a turned page level', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Rotate page clockwise' }).click();
    await pageRendered(page);
    const dialog = await openSignatureDialog(page);
    await drawOnPad(page, dialog);
    await startPlacing(dialog);
    const box = await pageBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + 200);
    await expect(annotationGroups(page)).toHaveCount(1);
    // Level on screen: wider than tall, like the drawing.
    const shown = (await annotationGroups(page).first().locator('image').boundingBox())!;
    expect(shown.width).toBeGreaterThan(shown.height * 2);

    // The saved page is turned, so in page space the box stands up and the
    // stamp turns with the page.
    const [signature] = (await savedSignatures(await saveAs(page)))[0]!;
    const [x1, y1, x2, y2] = signature!.rect as [number, number, number, number];
    expect(y2 - y1).toBeGreaterThan((x2 - x1) * 2);
    expect(signature!.rotate).toBe(90);
  });

  test('copies a signature and keeps its proportions when it is resized', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'basic-3-pages.pdf');
    const dialog = await openSignatureDialog(page);
    await drawOnPad(page, dialog);
    await startPlacing(dialog);
    const box = await pageBox(page);
    await page.mouse.click(box.x + 250, box.y + 400);
    await expect(annotationGroups(page)).toHaveCount(1);
    const image = annotationGroups(page).first().locator('image');
    const before = (await image.boundingBox())!;

    const handle = (await page.locator('[data-handle="se"]').boundingBox())!;
    const grip: [number, number] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
    await page.mouse.move(...grip);
    await page.mouse.down();
    await page.mouse.move(grip[0] + 90, grip[1] + 10, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await image.boundingBox())!.width)
      .toBeGreaterThan(before.width + 40);
    const after = (await image.boundingBox())!;
    expect(after.width / after.height).toBeCloseTo(before.width / before.height, 1);

    // Copied and pasted like any comment (the browser's own keys: ⌘ on a Mac).
    await page.keyboard.press('ControlOrMeta+C');
    await page.keyboard.press('ControlOrMeta+V');
    await expect(annotationGroups(page)).toHaveCount(2);
    const saved = (await savedSignatures(await saveAs(page)))[0]!;
    expect(saved.map((signature) => signature.name)).toEqual([
      '/FolioSignature',
      '/FolioSignature',
    ]);
  });

  test('honours documents that do not allow comments', async ({ page }) => {
    await open(page, 'encrypted-owner-restricted.pdf');
    await expect(tool(page, 'Sign')).toBeDisabled();
    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Add a signature…' }).click();
    const dialog = signatureDialog(page);
    await expect(dialog).toContainText('does not allow adding or changing comments');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toBeHidden();
  });
});
