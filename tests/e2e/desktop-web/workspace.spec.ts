import { expect, test } from '@playwright/test';
import { chooseFiles, dropFiles, expectAccessible, pageRendered } from '../helpers';

/**
 * The desktop UI running in Chromium with the web adapter (`vite preview`).
 * Shared workspace behaviour is covered here; the Tauri-specific paths are
 * covered against the real binary by tests/desktop/tauri-driver.e2e.mjs.
 */
test.describe('desktop workspace (web adapter)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
  });

  test('welcome screen is accessible and keyboard reachable', async ({ page }) => {
    await expectAccessible(page, 'welcome');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Open PDF' })).toBeFocused();
    const focusOutline = await page
      .getByRole('button', { name: 'Open PDF' })
      .evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(focusOutline).toBe('solid');
  });

  test('opens several documents into tabs and switches between them', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
      'rotated-pages.pdf',
    ]);
    const tabs = page.getByRole('navigation', { name: 'Open documents' });
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await pageRendered(page);
    await tabs.getByRole('button', { name: /^rotated-pages\.pdf/ }).click();
    await expect(page.getByRole('toolbar').getByRole('heading')).toHaveText(
      'Folio Rotation Fixture',
    );
    await pageRendered(page);
    // Page 2 is stored with /Rotate 90, so it is shown in landscape.
    const rotatedPage = await page.locator('[data-page="2"]').boundingBox();
    expect(rotatedPage!.width).toBeGreaterThan(rotatedPage!.height);
    await expect(page).toHaveTitle('rotated-pages.pdf — Folio');
    await tabs.getByRole('button', { name: 'Close rotated-pages.pdf' }).click();
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectAccessible(page, 'workspace with document');
  });

  test('shows a focus ring on controls reached with the keyboard', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    // Controls that hide the browser's outline must draw their own when focused
    // from the keyboard (Tailwind's outline-none would hide that one too).
    const outlineOf = (name: string) =>
      page.getByRole('radio', { name, exact: true }).evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth };
      });
    const select = page.getByRole('radio', { name: 'Select', exact: true });
    await select.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Highlight', exact: true })).toBeFocused();
    const ring = await outlineOf('Highlight');
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBe('2px');
  });

  test('panels and theme follow the toolbar and persist across reloads', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    const pagesToggle = page.getByRole('button', { name: 'Sidebar', exact: true });
    const propertiesToggle = page.getByRole('button', { name: 'Properties panel', exact: true });
    await expect(pagesToggle).toHaveAttribute('aria-pressed', 'true');
    await pagesToggle.click();
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
    await expect(pagesToggle).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Control+Alt+1');
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
    await expect(pagesToggle).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Control+Alt+2');
    await expect(page.getByRole('complementary', { name: 'Properties' })).toBeHidden();
    await expect(propertiesToggle).toHaveAttribute('aria-pressed', 'false');

    const themeButton = page.getByRole('button', { name: /^Theme:/ });
    await themeButton.click(); // system → light
    await themeButton.click(); // light → dark
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'workspace (dark)');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await expect(page.getByRole('complementary', { name: 'Properties' })).toBeHidden();
  });

  test('copies document properties to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await page.getByRole('button', { name: 'Copy name' }).click();
    await expect(page.getByRole('button', { name: 'Copied name' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('basic-3-pages.pdf');
  });

  test('opens dropped PDFs and shows a drop target while dragging', async ({ page }) => {
    await dropFiles(page, 'main', [{ name: 'basic-3-pages.pdf' }]);
    await pageRendered(page);
    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['%PDF-1.7'], 'next.pdf', { type: 'application/pdf' }));
      return transfer;
    });
    await page.dispatchEvent('main', 'dragenter', { dataTransfer });
    await expect(page.getByText('Drop PDFs to open them')).toBeVisible();
    await page.dispatchEvent('main', 'dragleave', { dataTransfer });
    await expect(page.getByText('Drop PDFs to open them')).toBeHidden();
  });

  test('shows whichever page is selected in the thumbnails', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    const pages = page.getByRole('listbox', { name: 'Pages' });
    for (const number of [2, 3, 1]) {
      await pages.getByRole('option', { name: `Page ${number}` }).click();
      await pageRendered(page, number);
      await expect(page.getByRole('contentinfo')).toContainText(`Page ${number} of 3 · PDF 1.7`);
    }
  });
});
