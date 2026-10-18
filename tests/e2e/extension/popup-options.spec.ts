import { chooseFiles, expectAccessible, pageRendered } from '../helpers';
import { expect, test } from './fixtures';

test.describe('popup, options and activity', () => {
  test('popup offers quick actions and opens the editor', async ({
    page,
    context,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('popup.html'));
    await expect(page.getByRole('heading', { name: 'Folio' })).toBeVisible();
    await expect(page.getByText('Nothing yet.')).toBeVisible();
    await expectAccessible(page, 'popup');
    // Keyboard: Settings is first, then the quick actions.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /Open a PDF/ })).toBeFocused();
    const editorPromise = context.waitForEvent('page');
    await page.keyboard.press('Enter');
    const editor = await editorPromise;
    await expect(editor).toHaveURL(/editor\.html$/);
    await editor.close();
  });

  test('records activity without file names unless the user opts in', async ({
    page,
    context,
    extensionUrl,
  }) => {
    const editor = await context.newPage();
    await editor.goto(extensionUrl('editor.html'));
    await chooseFiles(editor, () => editor.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(editor);

    await page.goto(extensionUrl('popup.html'));
    const activity = page.getByRole('list', { name: 'Recent activity' });
    await expect(activity).toContainText('Opened a PDF · 3 pages');
    await expect(activity).not.toContainText('basic-3-pages.pdf');

    const options = await context.newPage();
    await options.goto(extensionUrl('options.html'));
    await options.getByRole('switch', { name: 'Include file names in activity' }).click();
    await chooseFiles(
      editor,
      () => editor.getByRole('button', { name: 'Open PDF', exact: true }).click(),
      ['rotated-pages.pdf'],
    );
    await expect(activity).toContainText('rotated-pages.pdf');

    // Turning the option off removes names that were stored.
    await options.getByRole('switch', { name: 'Include file names in activity' }).click();
    await expect(activity).not.toContainText('rotated-pages.pdf');

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Nothing yet.')).toBeVisible();

    await options.getByRole('switch', { name: 'Keep recent activity' }).click();
    await expect(page.getByText('Activity history is turned off in settings.')).toBeVisible();
    await options.close();
    await editor.close();
  });

  test('options explain every permission and change the theme everywhere', async ({
    page,
    context,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('options.html'));
    const permissions = page.getByRole('region', { name: 'Permissions' });
    await expect(permissions.locator('dt')).toHaveText(['storage', 'sidePanel']);
    await expect(permissions).not.toContainText('Required by Folio.');
    await expectAccessible(page, 'options');

    const editor = await context.newPage();
    await editor.goto(extensionUrl('editor.html'));
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(editor.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'options (dark)');
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(editor.locator('html')).toHaveAttribute('data-theme', 'light');
    await editor.close();
  });
});
