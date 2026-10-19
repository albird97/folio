import type { PdfEngine, PdfPermissions } from '@folio/pdf-core';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import { createMemoryPlatformAdapter, memoryFile } from '@folio/platform-adapters';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  answerBody,
  countTokensBody,
  errorBody,
  JSON_HEADERS,
  SSE_HEADERS,
} from '../../../../../tests/setup/anthropic';
import { WorkspaceProvider } from '../../context';
import { createUiStore } from '../../store/ui';
import { createWorkspaceStore } from '../../store/workspace';
import { Dialogs } from '../dialogs';
import { approximately } from './ask-ai-chat';

const KEY = 'sk-ant-api03-test-key-0123456789';

async function setup(options: { permissions?: PdfPermissions; send?: typeof fetch } = {}) {
  const handle = fakeDocumentHandle({
    info: {
      pageCount: 3,
      ...(options.permissions
        ? { encryption: 'owner-restricted' as const, permissions: options.permissions }
        : {}),
    },
    getPageText: async (pageIndex) => ({
      items: [
        {
          str: `Text of page ${pageIndex + 1}.`,
          hasEOL: false,
          transform: [12, 0, 0, 12, 72, 700],
          width: 100,
          height: 12,
        },
      ],
    }),
  });
  const engine: PdfEngine = { open: async () => handle, destroy: () => undefined };
  const memory = createMemoryPlatformAdapter();
  const requests: Array<{ url: string; body: string }> = [];
  memory.answerAi(async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body) });
    return options.send
      ? options.send(input, init)
      : String(input).includes('count_tokens')
        ? new Response(countTokensBody(1_234), { headers: JSON_HEADERS })
        : new Response(
            answerBody({
              parts: [{ text: 'It has three pages.', pages: [1, 2] }],
              usage: { input_tokens: 50, cache_read_input_tokens: 1_200, output_tokens: 9 },
            }),
            { headers: SSE_HEADERS },
          );
  });
  const workspace = createWorkspaceStore(engine);
  const ui = createUiStore(memory.adapter.storage);
  await workspace.getState().openFiles([memoryFile('doc.pdf', new Uint8Array([37, 80, 68, 70]))]);
  const doc = () => workspace.getState().documents[0]!;
  render(
    <WorkspaceProvider
      adapter={memory.adapter}
      engine={engine}
      profile="desktop"
      stores={{ workspace, ui }}
    >
      <Dialogs />
    </WorkspaceProvider>,
  );
  const open = () => act(() => ui.getState().openDialog({ kind: 'ask-ai', docKey: doc().key }));
  return { memory, ui, workspace, doc, open, requests };
}

const dialog = () => screen.getByRole('dialog', { name: /Ask Claude/ });

/** Turns Ask Claude on through its setup screen. */
async function turnOn() {
  const setupScreen = await screen.findByRole('dialog', { name: 'Ask Claude' });
  fireEvent.change(within(setupScreen).getByLabelText('Anthropic API key'), {
    target: { value: KEY },
  });
  fireEvent.click(within(setupScreen).getByRole('checkbox'));
  fireEvent.click(within(setupScreen).getByRole('button', { name: 'Turn on Ask Claude' }));
  await within(dialog()).findByRole('button', { name: 'Summarize' });
}

describe('Ask Claude dialog', () => {
  it('asks for the key and consent first, and sends nothing while setting up', async () => {
    const { open, ui, memory, requests } = await setup();
    open();
    const setupScreen = await screen.findByRole('dialog', { name: 'Ask Claude' });
    expect(within(setupScreen).getByText(/sends the text of the document’s pages/)).toBeTruthy();
    expect(within(setupScreen).getByText(/Nothing is sent until you ask/)).toBeTruthy();
    expect(within(setupScreen).getByText('anthropic.com/legal/privacy')).toBeTruthy();
    const turnOnButton = within(setupScreen).getByRole('button', { name: 'Turn on Ask Claude' });
    const key = within(setupScreen).getByLabelText('Anthropic API key') as HTMLInputElement;
    expect(turnOnButton).toHaveProperty('disabled', true);

    fireEvent.change(key, { target: { value: KEY } });
    expect(key.type).toBe('password');
    fireEvent.click(within(setupScreen).getByRole('button', { name: 'Show key' }));
    expect(key.type).toBe('text');
    // Not without consent.
    expect(turnOnButton).toHaveProperty('disabled', true);
    fireEvent.click(within(setupScreen).getByRole('checkbox'));
    fireEvent.click(turnOnButton);

    await within(dialog()).findByRole('button', { name: 'Summarize' });
    expect(ui.getState().ai.enabled).toBe(true);
    expect(await memory.adapter.ai!.hasKey()).toBe(true);
    expect(requests).toEqual([]);
  });

  it('summarizes, shows what was sent, and links cited pages', async () => {
    const { open, memory, workspace, doc, requests } = await setup();
    open();
    await turnOn();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Summarize' }));

    const answer = await within(dialog()).findByText('It has three pages.');
    expect(within(dialog()).getByText('Summarize this document.')).toBeTruthy();
    expect(
      within(dialog()).getByText(
        'Sent the text of 3 pages (about 1,200 tokens) to Anthropic with your first question.',
      ),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/1,250 tokens in \(1,200 from cache\), 9 out/)).toBeTruthy();
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.anthropic.com/v1/messages/count_tokens?beta=true',
      'https://api.anthropic.com/v1/messages?beta=true',
    ]);

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Copy answer' }));
    await waitFor(() => expect(memory.clipboard).toEqual(['It has three pages.']));

    // The citation leads to page 2 and closes the dialog to show it.
    const navigate = vi.spyOn(workspace.getState(), 'navigate');
    const cited = within(answer).getByRole('button', { name: /^page\s2$/ });
    expect(cited.title).toBe('Go to page 2');
    fireEvent.click(cited);
    expect(navigate).toHaveBeenCalledWith(doc().key, { pageIndex: 1, align: 'top' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends with Enter and starts a new line with Shift+Enter', async () => {
    const { open, requests } = await setup();
    open();
    await turnOn();
    const question = within(dialog()).getByLabelText('Your question');
    fireEvent.change(question, { target: { value: 'How many pages?' } });
    fireEvent.keyDown(question, { key: 'Enter', shiftKey: true });
    expect(requests).toEqual([]);
    fireEvent.keyDown(question, { key: 'Enter' });
    await within(dialog()).findByText('It has three pages.');
    expect(within(dialog()).getByText('How many pages?')).toBeTruthy();
    expect((question as HTMLTextAreaElement).value).toBe('');
  });

  it('reports a key Anthropic refuses and lets the user set up another', async () => {
    const { open, memory } = await setup({
      send: async () =>
        new Response(errorBody('authentication_error', 'invalid x-api-key'), {
          status: 401,
          headers: JSON_HEADERS,
        }),
    });
    open();
    await turnOn();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Summarize' }));
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Anthropic did not accept your API key.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Change key' }));
    await within(dialog()).findByLabelText('Anthropic API key');
    expect(within(dialog()).getByText(/Anthropic did not accept your API key/)).toBeTruthy();
    await waitFor(async () => expect(await memory.adapter.ai!.hasKey()).toBe(false));
  });

  it('sends nothing from documents whose author does not allow copying', async () => {
    const { open } = await setup({
      permissions: {
        print: true,
        copy: false,
        modify: true,
        annotate: true,
        fillForms: true,
        assemble: true,
      },
    });
    open();
    await turnOn();
    expect(
      within(dialog()).getByText('The author of this document does not allow copying its content.'),
    ).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Summarize' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('turns off, forgetting the key, from its settings', async () => {
    const { open, ui, memory } = await setup();
    open();
    await turnOn();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Ask Claude settings' }));
    const settings = await screen.findByRole('dialog', { name: 'Ask Claude settings' });
    fireEvent.click(within(settings).getByRole('radio', { name: /Claude Haiku 5.5/ }));
    expect(ui.getState().ai.model).toBe('claude-haiku-5-5');
    fireEvent.click(within(settings).getByRole('button', { name: 'Turn off and forget key' }));
    await within(dialog()).findByLabelText('Anthropic API key');
    expect(ui.getState().ai.enabled).toBe(false);
    expect(await memory.adapter.ai!.hasKey()).toBe(false);
  });

  it('rounds token counts for display', () => {
    expect(approximately(42)).toBe('42');
    expect(approximately(9_123)).toBe('9,100');
    expect(approximately(812_345)).toBe('810,000');
    expect(approximately(1_234_567)).toBe('1,200,000');
  });
});
