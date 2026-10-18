import {
  chooseFiles,
  dropFiles,
  expectAccessible,
  FIXTURE_PASSWORD,
  pageRendered,
} from '../helpers';
import { expect, test } from './fixtures';

test.describe('extension editor', () => {
  test.beforeEach(async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('editor.html'));
  });

  test('starts accessible in light and dark themes', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
    await expectAccessible(page, 'editor welcome (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'editor welcome (dark)');
  });

  test('opens, renders and describes a PDF', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    await expect(page.getByRole('toolbar').getByRole('heading')).toHaveText('Folio Basic Fixture');
    const properties = page.getByRole('complementary', { name: 'Properties' });
    await expect(properties).toContainText('Folio Test Suite');
    await expect(properties).toContainText('1.7');
    await expect(
      page.getByRole('complementary', { name: 'Pages' }).getByRole('button'),
    ).toHaveCount(3);
    await expectAccessible(page, 'editor with document');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'editor with document (dark)');
  });

  test('navigates pages from the pages panel with the keyboard', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    const pages = page.getByRole('complementary', { name: 'Pages' });
    await pages.getByRole('button', { name: /Page 3/ }).click();
    await expect(page.getByRole('img', { name: 'Page 3 of 3' })).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('img', { name: 'Page 2 of 3' })).toBeVisible();
    await expect(pages.getByRole('button', { name: /Page 2/ })).toBeFocused();
    await pageRendered(page);
  });

  test('unlocks password-protected PDFs', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'encrypted-user-password.pdf',
    ]);
    await expect(
      page.getByRole('heading', { name: 'This PDF is password protected' }),
    ).toBeVisible();
    const password = page.getByRole('textbox', { name: 'Password' });
    await expect(password).toBeFocused();
    await password.fill('wrong');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('That password is incorrect');
    await expectAccessible(page, 'password prompt with error');
    await password.fill(FIXTURE_PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await pageRendered(page);
    await expect(page.getByRole('complementary', { name: 'Properties' })).toContainText(
      'Password required to open',
    );
  });

  test('explains files that are not PDFs', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'not-a-pdf.pdf',
    ]);
    await expect(page.getByRole('heading', { name: 'This isn’t a PDF' })).toBeVisible();
    await page.getByRole('button', { name: 'Close tab' }).click();
    await expect(page.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
  });

  test('opens dropped PDFs and skips other dropped files', async ({ page }) => {
    await dropFiles(page, 'main', [
      { name: 'basic-3-pages.pdf' },
      { name: 'rotated-pages.pdf' },
      { name: 'photo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' },
    ]);
    const tabs = page.getByRole('navigation', { name: 'Open documents' });
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toBeVisible();
    await expect(tabs.getByRole('button', { name: /^rotated-pages\.pdf/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Skipped 1 file' })).toBeVisible();
    await pageRendered(page);
  });

  test('supports keyboard shortcuts that do not clash with Chrome', async ({ page }) => {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+O');
    await (
      await chooser
    ).setFiles([
      `${import.meta.dirname}/../../fixtures/basic-3-pages.pdf`,
      `${import.meta.dirname}/../../fixtures/rotated-pages.pdf`,
    ]);
    const tabs = page.getByRole('navigation', { name: 'Open documents' });
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('Alt+PageDown');
    await expect(tabs.getByRole('button', { name: /^rotated-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('ControlOrMeta+Alt+1');
    await expect(page.getByRole('complementary', { name: 'Pages' })).toBeHidden();
    await page.keyboard.press('ControlOrMeta+Alt+2');
    await expect(page.getByRole('complementary', { name: 'Properties' })).toBeHidden();
    await page.keyboard.press('Alt+W');
    await expect(tabs.getByRole('button', { name: /^rotated-pages\.pdf/ })).toHaveCount(0);
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
