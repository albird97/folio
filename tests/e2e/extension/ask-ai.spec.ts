import { answerBody, countTokensBody, JSON_HEADERS, SSE_HEADERS } from '../../setup/anthropic';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';
import { expect, stubPermissions, test } from './fixtures';

/**
 * Ask Claude in the extension: the editor page hands the key to the service
 * worker and asks through it; only the worker reaches (a mocked) Anthropic
 * API. Playwright sees and routes a service worker's requests only with an
 * experimental switch, read when the worker attaches: it is set before this
 * test's browser starts, and only for it.
 */
const SERVICE_WORKER_NETWORK = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';
test.beforeAll(() => {
  process.env[SERVICE_WORKER_NETWORK] = '1';
});
test.afterAll(() => {
  delete process.env[SERVICE_WORKER_NETWORK];
});

const KEY = 'sk-ant-api03-e2e-test-key-0000000000';

test('asks Claude through the service worker, which alone holds the key', async ({
  context,
  page,
  serviceWorker,
  extensionUrl,
}) => {
  // Routing service-worker requests makes the worker's extension APIs arrive late,
  // and the test waits for them: under a loaded machine that alone can take 20 s.
  test.slow();
  const sent: Array<{ path: string; key: string | undefined; fromWorker: boolean }> = [];
  await context.route('https://api.anthropic.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    sent.push({
      path: `${url.pathname}${url.search}`,
      key: (await request.allHeaders())['x-api-key'],
      fromWorker: request.serviceWorker() !== null,
    });
    const cors = { 'access-control-allow-origin': '*' };
    await route.fulfill(
      url.pathname.endsWith('/count_tokens')
        ? { headers: { ...JSON_HEADERS, ...cors }, body: countTokensBody(1_234) }
        : {
            headers: { ...SSE_HEADERS, ...cors },
            body: answerBody({ parts: [{ text: 'Three pages about a fox.', pages: [0, 1] }] }),
          },
    );
  });
  // Chrome's access prompt cannot be clicked in tests: allowed, in the page and the worker.
  await context.addInitScript(stubPermissions({ allow: true }));
  // Attached that early, the worker gets its extension APIs a moment later.
  await expect
    .poll(() => serviceWorker.evaluate(() => typeof chrome.permissions?.contains))
    .toBe('function');
  await serviceWorker.evaluate(() => {
    chrome.permissions.contains = async () => true;
  });
  const pageRequests: string[] = [];
  page.on('request', (request) => pageRequests.push(request.url()));

  await page.goto(extensionUrl('editor.html'));
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
    'basic-3-pages.pdf',
  ]);
  await pageRendered(page);
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Ask Claude about this document…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Ask Claude/ });
  await expect(dialog.getByText(/kept in this browser profile’s storage/)).toBeVisible();
  await dialog.getByLabel('Anthropic API key').fill(KEY);
  await dialog.getByRole('checkbox', { name: /I agree/ }).check();
  await dialog.getByRole('button', { name: 'Turn on Ask Claude' }).click();
  await dialog.getByRole('button', { name: 'Summarize' }).click();
  await expect(dialog.getByRole('listitem').first()).toContainText(
    'Claude answered: Three pages about a fox.',
  );
  await expectAccessible(page, 'Ask Claude in the extension');

  // Only the worker talked to Anthropic, with the key it keeps.
  expect(sent).toEqual([
    { path: '/v1/messages/count_tokens?beta=true', key: KEY, fromWorker: true },
    { path: '/v1/messages?beta=true', key: KEY, fromWorker: true },
  ]);
  expect(pageRequests.filter((url) => url.includes('anthropic'))).toEqual([]);
  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get(null));
  expect(stored['ai-api-key']).toBe(KEY);
  expect(JSON.stringify(stored['workspace-ui'])).not.toContain(KEY);
  expect(stored['workspace-ui']).toMatchObject({ ai: { enabled: true } });

  // The options page turns it off and forgets the key.
  const options = await context.newPage();
  await options.goto(extensionUrl('options.html'));
  const section = options.getByRole('region', { name: 'Ask Claude' });
  await expect(section.getByRole('status')).toHaveText(/^On\./);
  await section.getByRole('button', { name: 'Turn off and forget key' }).click();
  await expect(section.getByRole('status')).toHaveText(/^Off\. To turn it on/);
  await expect
    .poll(
      async () =>
        (await serviceWorker.evaluate(() => chrome.storage.local.get(null)))['ai-api-key'],
    )
    .toBeUndefined();
});
