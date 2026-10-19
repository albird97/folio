import { expect, test, type Page, type Route } from '@playwright/test';
import {
  answerBody,
  answerEvents,
  countTokensBody,
  errorBody,
  JSON_HEADERS,
  SSE_HEADERS,
  type MockAnswer,
} from '../../setup/anthropic';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';

/**
 * Ask Claude with the web adapter (the desktop UI in a browser): the setup
 * and consent, then questions whose requests go to a mocked Anthropic API.
 * Nothing reaches the real API.
 */

const KEY = 'sk-ant-api03-e2e-test-key-0000000000';

interface Sent {
  path: string;
  headers: Record<string, string>;
  body: {
    model: string;
    system: unknown;
    messages: Array<{ role: string; content: unknown }>;
    [key: string]: unknown;
  };
}

/** Answers Anthropic's API: token counts, then the next queued answer or error. */
async function mockAnthropic(page: Page, options: { tokens?: number } = {}) {
  const sent: Sent[] = [];
  const answers: Array<MockAnswer | { status: number; type: string }> = [];
  await page.route('https://api.anthropic.com/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    sent.push({
      path: `${url.pathname}${url.search}`,
      headers: await request.allHeaders(),
      body: request.postDataJSON() as Sent['body'],
    });
    const cors = { 'access-control-allow-origin': '*' };
    const next = url.pathname.endsWith('/count_tokens')
      ? null
      : (answers.shift() ?? { parts: [{ text: 'No answer was queued.' }] });
    if (next && 'status' in next) {
      await route.fulfill({
        status: next.status,
        headers: { ...JSON_HEADERS, ...cors },
        body: errorBody(next.type, 'Mocked error'),
      });
    } else if (next) {
      await route.fulfill({ headers: { ...SSE_HEADERS, ...cors }, body: answerBody(next) });
    } else {
      await route.fulfill({
        headers: { ...JSON_HEADERS, ...cors },
        body: countTokensBody(options.tokens ?? 1_234),
      });
    }
  });
  return { sent, answers, questions: () => sent.filter((entry) => !entry.path.includes('count')) };
}

/**
 * Answers that the test streams event by event: `fetch` calls to the
 * messages endpoint get a body the test writes to (route mocks deliver a
 * body all at once). Only while `window.folioManualAnswers` is set.
 */
function installManualAnswers(page: Page) {
  return page.addInitScript(() => {
    type Stream = { push(text: string): void; close(): void; aborted(): boolean };
    const target = window as unknown as { folioManualAnswers?: boolean; folioStreams: Stream[] };
    target.folioStreams = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!target.folioManualAnswers || !url.startsWith('https://api.anthropic.com/v1/messages?')) {
        return original(input, init);
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (value) => void (controller = value) });
      // As with a real request, aborting ends the body with an error.
      init?.signal?.addEventListener('abort', () =>
        controller.error(new DOMException('The request was cancelled.', 'AbortError')),
      );
      target.folioStreams.push({
        push: (text) => controller.enqueue(new TextEncoder().encode(text)),
        close: () => controller.close(),
        aborted: () => init?.signal?.aborted ?? false,
      });
      return Promise.resolve(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      );
    };
  });
}

const pushEvents = (page: Page, events: string[]) =>
  page.evaluate((texts) => {
    const streams = (window as unknown as { folioStreams: Array<{ push(text: string): void }> })
      .folioStreams;
    for (const text of texts) streams.at(-1)!.push(text);
  }, events);

async function openAskClaude(page: Page) {
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Ask Claude about this document…' }).click();
  return page.getByRole('dialog', { name: /^Ask Claude/ });
}

async function turnOn(page: Page) {
  const dialog = await openAskClaude(page);
  await dialog.getByLabel('Anthropic API key').fill(KEY);
  await dialog.getByRole('checkbox', { name: /I agree/ }).check();
  await dialog.getByRole('button', { name: 'Turn on Ask Claude' }).click();
  await expect(dialog.getByRole('button', { name: 'Summarize' })).toBeVisible();
  return dialog;
}

test.describe('Ask Claude', () => {
  test.beforeEach(async ({ page }) => {
    await installManualAnswers(page);
    await page.goto('/');
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
  });

  test('sets up with consent, summarizes, follows up, streams and stops', async ({ page }) => {
    const api = await mockAnthropic(page);
    let dialog = await openAskClaude(page);
    // Nothing is sent before the user agrees and asks.
    await expect(dialog.getByText(/Nothing is sent until you ask/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Turn on Ask Claude' })).toBeDisabled();
    await expectAccessible(page, 'Ask Claude setup');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    dialog = await turnOn(page);
    expect(api.sent).toEqual([]);
    await expectAccessible(page, 'Ask Claude, ready');

    // Summarize: counted, then answered with a citation of page 2.
    api.answers.push({
      parts: [
        { text: 'A test document of three pages.', pages: [1, 2] },
        { text: ' Each repeats one sentence.' },
      ],
      usage: { input_tokens: 40, cache_creation_input_tokens: 1_150, output_tokens: 12 },
    });
    await dialog.getByRole('button', { name: 'Summarize' }).click();
    const turns = dialog.getByRole('listitem');
    await expect(turns.first()).toContainText(
      'Claude answered: A test document of three pages.page 2 Each repeats one sentence.',
    );
    await expect(
      dialog.getByText(
        'Sent the text of 3 pages (about 1,200 tokens) to Anthropic with your first question.',
      ),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'page 2', exact: true })).toBeVisible();
    expect(api.sent.map((entry) => entry.path)).toEqual([
      '/v1/messages/count_tokens?beta=true',
      '/v1/messages?beta=true',
    ]);
    const [summary] = api.questions();
    expect(summary!.headers['x-api-key']).toBe(KEY);
    expect(summary!.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    });
    const document = (summary!.body.messages[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(document).toMatchObject({
      type: 'document',
      citations: { enabled: true },
      cache_control: { type: 'ephemeral' },
    });
    expect(JSON.stringify(document)).toContain('Page 3\\n\\nFolio fixture page 3');

    // A follow-up repeats the same prefix and the conversation so far.
    api.answers.push({
      parts: [{ text: 'Three.' }],
      usage: { input_tokens: 25, cache_read_input_tokens: 1_150, output_tokens: 2 },
    });
    await dialog.getByLabel('Your question').fill('How many pages are there?');
    await dialog.getByLabel('Your question').press('Enter');
    await expect(turns.nth(1)).toContainText('Claude answered: Three.');
    await expect(dialog.getByText(/1,175 tokens in \(1,150 from cache\), 2 out/)).toBeVisible();
    const [, followUp] = api.questions();
    expect(JSON.stringify(followUp!.body.system)).toBe(JSON.stringify(summary!.body.system));
    expect(followUp!.body.messages).toEqual([
      summary!.body.messages[0],
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'A test document of three pages. Each repeats one sentence.' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'How many pages are there?' }] },
    ]);
    // Counted once only, before the first question.
    expect(api.sent.filter((entry) => entry.path.includes('count'))).toHaveLength(1);

    // An answer appears as it streams in, and Stop cancels it.
    await page.evaluate(() => {
      (window as unknown as { folioManualAnswers: boolean }).folioManualAnswers = true;
    });
    await dialog.getByLabel('Your question').fill('Tell me more.');
    await dialog.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(dialog.getByText('Thinking…')).toBeVisible();
    const events = answerEvents({ parts: [{ text: 'The fox jumps over the dog again.' }] });
    const firstWord = events.findIndex((text) => text.includes('"text_delta"')) + 1;
    const answer = turns.nth(2);
    await pushEvents(page, events.slice(0, firstWord));
    await expect(answer).toContainText('Claude answered: The');
    await expect(answer).not.toContainText('fox');
    await pushEvents(page, events.slice(firstWord, firstWord + 2));
    await expect(answer).toContainText('The fox jumps');
    await expect(answer).not.toContainText('over');
    await expectAccessible(page, 'Ask Claude, answering');
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await expect(answer).toContainText('Stopped.');
    await expect(answer).toContainText('The fox jumps');
    await expect(answer).not.toContainText('over');
    expect(
      await page.evaluate(() =>
        (window as unknown as { folioStreams: Array<{ aborted(): boolean }> }).folioStreams
          .at(-1)!
          .aborted(),
      ),
    ).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();

    // The cited page is one click away.
    await dialog.getByRole('button', { name: 'page 2', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('textbox', { name: /^Page number/ })).toHaveValue('2');
  });

  test('explains a key Anthropic refuses and asks for another', async ({ page }) => {
    const api = await mockAnthropic(page);
    await page.route('https://api.anthropic.com/v1/messages/count_tokens**', (route) =>
      route.fulfill({
        status: 401,
        headers: { ...JSON_HEADERS, 'access-control-allow-origin': '*' },
        body: errorBody('authentication_error', 'invalid x-api-key'),
      }),
    );
    const dialog = await turnOn(page);
    await dialog.getByRole('button', { name: 'Summarize' }).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('Anthropic did not accept your API key.');
    await expectAccessible(page, 'Ask Claude, invalid key');
    await alert.getByRole('button', { name: 'Change key' }).click();
    await expect(dialog.getByLabel('Anthropic API key')).toBeVisible();
    await expect(dialog.getByText(/Anthropic did not accept your API key/)).toBeVisible();
    expect(api.questions()).toEqual([]);
  });

  test('refuses pages with too much text, saying how much', async ({ page }) => {
    const api = await mockAnthropic(page, { tokens: 912_345 });
    const dialog = await turnOn(page);
    await dialog.getByRole('button', { name: 'Summarize' }).click();
    await expect(
      dialog.getByText(
        'The text of these pages is about 910,000 tokens, more than Folio sends at once (800,000). Choose fewer pages.',
      ),
    ).toBeVisible();
    expect(api.questions()).toEqual([]);
    // Fewer pages can still be chosen.
    await expect(dialog.getByLabel('Pages')).toBeEditable();
  });
});
