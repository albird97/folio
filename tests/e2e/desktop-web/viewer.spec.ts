import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeLargePdf } from '../../setup/fixtures';
import { chooseFiles, expectAccessible, fixture, pageRendered } from '../helpers';

/**
 * The Phase 2 viewer in the shared workspace (desktop UI with the web
 * adapter; the extension editor renders the same components).
 */
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function open(page: Page, name: string) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [name]);
  await pageRendered(page);
}

const viewer = (page: Page) => page.getByRole('region', { name: 'Page view' });
const pageField = (page: Page) => page.getByRole('textbox', { name: /^Page number/ });
const zoomButton = (page: Page) => page.getByRole('button', { name: /^Zoom, / });
const findBar = (page: Page) => page.getByRole('search', { name: 'Find in document' });

async function zoomPercent(page: Page): Promise<number> {
  return Number.parseInt((await zoomButton(page).innerText()).replace('%', ''), 10);
}

/** Where page `pageNumber`'s top edge is, relative to the top of the page view. */
async function pageTopInView(page: Page, pageNumber: number): Promise<number> {
  const region = (await viewer(page).boundingBox())!;
  const box = (await page.locator(`[data-page="${pageNumber}"]`).boundingBox())!;
  return box.y - region.y;
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element is not visible');
  return box;
}

test.describe('document viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
  });

  test('scrolls through all pages continuously and tracks the current page', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await expect(pageField(page)).toHaveValue('1');
    await viewer(page).evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(pageField(page)).toHaveValue('3');
    await expect(page.getByRole('contentinfo')).toContainText('Page 3 of 3');
    await pageRendered(page, 3);
  });

  test('navigates with the keyboard', async ({ page }) => {
    await open(page, 'outline-and-text.pdf');
    await viewer(page).focus();
    await page.keyboard.press('End');
    await expect(pageField(page)).toHaveValue('6');
    await page.keyboard.press('Home');
    await expect(pageField(page)).toHaveValue('1');
    // Without horizontal scrolling, left and right turn pages.
    await page.keyboard.press('ArrowRight');
    await expect(pageField(page)).toHaveValue('2');
    await page.keyboard.press('ArrowLeft');
    await expect(pageField(page)).toHaveValue('1');
    await page.keyboard.press('PageDown');
    await expect
      .poll(() => viewer(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(200);

    // Go to page: the shortcut focuses the page field.
    await page.keyboard.press('Control+Alt+G');
    await expect(pageField(page)).toBeFocused();
    await page.keyboard.type('5');
    await page.keyboard.press('Enter');
    await expect(pageField(page)).toHaveValue('5');
    await pageRendered(page, 5);
    await expect.poll(() => pageTopInView(page, 5)).toBeLessThanOrEqual(24);
    await expect.poll(() => pageTopInView(page, 5)).toBeGreaterThanOrEqual(0);
    // Out-of-range numbers go to the nearest page.
    await pageField(page).fill('99');
    await page.keyboard.press('Enter');
    await expect(pageField(page)).toHaveValue('6');
  });

  test('zooms with the toolbar, the menu and the keyboard', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const initial = await zoomPercent(page);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => zoomPercent(page)).toBeGreaterThan(initial);
    await page.keyboard.press('Control+0');
    await expect(zoomButton(page)).toHaveText('100%');
    const pageBox = await boxOf(page.locator('[data-page="1"]'));
    expect(Math.round(pageBox.width)).toBe(612);
    await page.keyboard.press('Control+-');
    await expect(zoomButton(page)).toHaveText('90%');
    await page.keyboard.press('Control+=');
    await expect(zoomButton(page)).toHaveText('100%');

    await zoomButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Fit page' }).click();
    const region = await boxOf(viewer(page));
    const fitted = await boxOf(page.locator('[data-page="1"]'));
    expect(fitted.height).toBeLessThanOrEqual(region.height);
    expect(fitted.height).toBeGreaterThan(region.height - 80);
    await zoomButton(page).click();
    await expect(page.getByRole('menuitemradio', { name: 'Fit page' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('menuitemradio', { name: 'Fit width' }).click();
    await expect
      .poll(async () => (await boxOf(page.locator('[data-page="1"]'))).width)
      .toBeGreaterThan(region.width - 80);
    await pageRendered(page);
  });

  test('ctrl+wheel and pinch zoom keep the point under the pointer in place', async ({ page }) => {
    await open(page, 'outline-and-text.pdf');
    const line = page
      .locator('[data-page="1"] .textLayer span')
      .filter({ hasText: 'The Quick brown fox' });
    const before = await boxOf(line);
    const x = before.x + before.width * 0.75;
    const y = before.y + before.height / 2;
    const fractionAt = async () => {
      const box = await boxOf(line);
      return [(x - box.x) / box.width, (y - box.y) / box.height];
    };
    const [fx, fy] = await fractionAt();

    // A mouse wheel notch with Ctrl held steps to the next zoom level.
    const start = await zoomPercent(page);
    await page.mouse.move(x, y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(() => zoomPercent(page)).toBeGreaterThan(start);
    await expect.poll(async () => (await fractionAt())[0]).toBeCloseTo(fx!, 1);
    expect((await fractionAt())[1]).toBeCloseTo(fy!, 1);

    // Trackpad pinches arrive as ctrl+wheel without a Ctrl key press: smooth zoom.
    const stepped = await zoomPercent(page);
    await viewer(page).dispatchEvent('wheel', {
      ctrlKey: true,
      deltaY: -20,
      deltaMode: 0,
      clientX: x,
      clientY: y,
    });
    await expect.poll(() => zoomPercent(page)).toBeGreaterThan(stepped);
    await expect.poll(async () => (await fractionAt())[0]).toBeCloseTo(fx!, 1);
    // The browser's own page zoom stayed untouched.
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });

  test('rotates the view without changing the document', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const portrait = await boxOf(page.locator('[data-page="1"]'));
    expect(portrait.height).toBeGreaterThan(portrait.width);
    await page.getByRole('button', { name: 'Rotate clockwise' }).click();
    await expect
      .poll(async () => {
        const box = await boxOf(page.locator('[data-page="1"]'));
        return box.width > box.height;
      })
      .toBe(true);
    await pageRendered(page);
    // ⌘R/Ctrl+R rotates in the desktop app (browsers keep it for reload).
    await page.keyboard.press('Control+R');
    await page.keyboard.press('Control+L');
    await page.getByRole('button', { name: 'Rotate counterclockwise' }).click();
    await expect
      .poll(async () => {
        const box = await boxOf(page.locator('[data-page="1"]'));
        return box.height > box.width;
      })
      .toBe(true);
    await pageRendered(page);
  });

  test('follows bookmarks to their destination', async ({ page }) => {
    await open(page, 'outline-and-text.pdf');
    await page.getByRole('tab', { name: 'Bookmarks' }).click();
    const tree = page.getByRole('tree', { name: 'Bookmarks' });
    await expect(tree.getByRole('treeitem')).toHaveCount(5);
    const chapter = tree.getByRole('treeitem', { name: /Chapter 1: Foxes/ });
    await expect(chapter).toHaveAttribute('aria-expanded', 'false');
    await tree.getByRole('treeitem', { name: /Introduction/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(chapter).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(chapter).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    const section = tree.getByRole('treeitem', { name: /Section 1.1: Habitat/ });
    await expect(section).toBeFocused();
    await expect(section).toHaveAttribute('aria-level', '2');
    await page.keyboard.press('Enter');
    await expect(pageField(page)).toHaveValue('3');
    // The destination is (72, 540) on a 792-point-high page: that point is
    // at the top of the window.
    const scale = (await boxOf(page.locator('[data-page="3"]'))).height / 792;
    await expect
      .poll(async () => Math.abs((await pageTopInView(page, 3)) + (792 - 540) * scale))
      .toBeLessThan(3);
    await page.keyboard.press('ArrowLeft');
    await expect(chapter).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pageField(page)).toHaveValue('2');
    // Named destinations resolve too (Chapter 2 → page 5).
    await tree.getByRole('treeitem', { name: /Chapter 2: Plants/ }).click();
    await expect(pageField(page)).toHaveValue('5');
    // Web links are listed but not followed.
    await expect(tree.getByRole('treeitem', { name: /Folio on the web/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('finds text, highlights matches and steps through them', async ({ page }) => {
    await open(page, 'outline-and-text.pdf');
    await page.keyboard.press('Control+F');
    const input = findBar(page).getByRole('searchbox');
    await expect(input).toBeFocused();
    await input.fill('fox');
    await expect(findBar(page)).toContainText('1 of 8');
    await expect(page.locator('[data-page="1"] .folio-hit')).toHaveCount(1);
    await expect(page.locator('[data-page="1"] .folio-hit[data-active]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(findBar(page)).toContainText('2 of 8');
    await expect(pageField(page)).toHaveValue('2');
    await page.keyboard.press('Shift+Enter');
    await expect(findBar(page)).toContainText('1 of 8');
    await page.keyboard.press('F3');
    await expect(findBar(page)).toContainText('2 of 8');

    // Accuracy: case, whole words, accents and text drawn in separate runs.
    // The announcement only describes a finished search for the typed text.
    const status = findBar(page).getByRole('status');
    const expectCount = async (query: string, expected: string) => {
      await input.fill(query);
      await expect(status).toHaveText(expected);
    };
    await expectCount('quick', '3 results');
    await findBar(page).getByRole('button', { name: 'Match case' }).click();
    await expect(status).toHaveText('2 results');
    await expectCount('Quick', '1 result');
    await findBar(page).getByRole('button', { name: 'Match case' }).click();
    await expectCount('cat', '3 results');
    await findBar(page).getByRole('button', { name: 'Whole words' }).click();
    await expect(status).toHaveText('2 results');
    await findBar(page).getByRole('button', { name: 'Whole words' }).click();
    await expectCount('cafe', '1 result');
    await expectCount('naive fox', '1 result');
    await expectCount('photosynthesis', '1 result');
    await expectCount('zebra', 'No results');

    // All results, with their context.
    await input.fill('fox');
    await expect(findBar(page)).toContainText('of 8');
    await findBar(page).getByRole('button', { name: 'Show all results' }).click();
    const results = page.getByRole('list', { name: 'Search results' });
    await expect(results.getByRole('listitem')).toHaveCount(8);
    await results.getByRole('button').nth(5).click();
    await expect(pageField(page)).toHaveValue('3');
    await expect(findBar(page)).toContainText('6 of 8');
    await expect(page.locator('[data-page="3"] .folio-hit[data-active]')).toHaveCount(1);

    await expectAccessible(page, 'viewer with search results');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'viewer with search results (dark)');

    await input.focus();
    await page.keyboard.press('Escape');
    await expect(findBar(page)).toBeHidden();
    await expect(viewer(page)).toBeFocused();
    await expect(page.locator('.folio-hit')).toHaveCount(0);
  });

  test('selects and copies page text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'outline-and-text.pdf');
    const line = page
      .locator('[data-page="1"] .textLayer span')
      .filter({ hasText: 'The Quick brown fox opens this guide.' });
    const box = await boxOf(line);
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
      'Quick brown fox opens this guide',
    );
    await page.keyboard.press('Control+C');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('Quick brown fox opens this guide');
  });

  test('saves an exact copy of the original file', async ({ page }) => {
    await open(page, 'outline-and-text.pdf');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'More ways to save' }).click();
    await page.getByRole('menuitem', { name: 'Download the original' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('outline-and-text.pdf');
    const original = readFileSync(fixture('outline-and-text.pdf'));
    expect(sha256(readFileSync((await file.path())!))).toBe(sha256(original));
    await expect(page.getByRole('status').filter({ hasText: 'Downloading a copy' })).toBeVisible();

    // The same command twice within 120 ms counts once (a native menu
    // accelerator and the page can both see one key press).
    await page.waitForTimeout(150);
    const viaShortcut = page.waitForEvent('download');
    await page.keyboard.press('Control+Alt+S');
    expect((await viaShortcut).suggestedFilename()).toBe('outline-and-text.pdf');
  });

  test('opens a 1,500-page document within budget and keeps memory bounded', async ({ page }) => {
    test.slow();
    const pageCount = 1500;
    const bytes = await makeLargePdf(pageCount, (index) =>
      index % 97 === 50 ? [792, 612] : [612, 792],
    );
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Choose PDF/ }).click();
    const started = Date.now();
    await (
      await chooser
    ).setFiles({ name: 'large.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
    await pageRendered(page);
    const firstPage = Date.now() - started;
    test.info().annotations.push({ type: 'time to first page', description: `${firstPage} ms` });
    expect(firstPage).toBeLessThan(5000);
    await expect(page.getByText('Reading page sizes…')).toBeHidden({ timeout: 15000 });
    // Sizes read in the background reach the layout: page 245 is landscape.
    await pageField(page).fill('245');
    await page.keyboard.press('Enter');
    await pageRendered(page, 245);
    const landscape = await boxOf(page.locator('[data-page="245"]'));
    expect(landscape.width).toBeGreaterThan(landscape.height);

    // Only pages near the window exist in the DOM.
    await expect(page.locator('.folio-page')).not.toHaveCount(0);
    expect(await page.locator('.folio-page').count()).toBeLessThanOrEqual(8);
    expect(
      await page.getByRole('listbox', { name: 'Pages' }).getByRole('option').count(),
    ).toBeLessThanOrEqual(16);

    await viewer(page).focus();
    await page.keyboard.press('End');
    await pageRendered(page, pageCount);
    await expect(pageField(page)).toHaveValue(String(pageCount));
    await pageField(page).fill('1234');
    await page.keyboard.press('Enter');
    await pageRendered(page, 1234);

    // Fling through hundreds of pages: renders are dropped, not queued up.
    for (let step = 0; step < 40; step += 1) {
      await viewer(page).evaluate((element) => element.scrollBy(0, -3000));
    }
    // Scroll events arrive with the next frames.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const settled = Number(await pageField(page).inputValue());
    expect(settled).toBeLessThan(1234);
    await pageRendered(page, settled);
    const usage = await page.evaluate(() => ({
      pages: document.querySelectorAll('.folio-page').length,
      canvases: document.querySelectorAll('canvas').length,
      nodes: document.getElementsByTagName('*').length,
      heapMB: Math.round(
        ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? 0) / 1e6,
      ),
    }));
    test.info().annotations.push({ type: 'memory', description: JSON.stringify(usage) });
    expect(usage.pages).toBeLessThanOrEqual(8);
    expect(usage.canvases).toBeLessThanOrEqual(40);
    expect(usage.nodes).toBeLessThan(2000);
    expect(usage.heapMB).toBeLessThan(250);

    // Search reaches the last page.
    await page.keyboard.press('Control+F');
    await findBar(page)
      .getByRole('searchbox')
      .fill(`marker-${pageCount - 1}`);
    await expect(findBar(page)).toContainText('1 of 1', { timeout: 30000 });
    await expect(pageField(page)).toHaveValue(String(pageCount - 1));
  });
});
