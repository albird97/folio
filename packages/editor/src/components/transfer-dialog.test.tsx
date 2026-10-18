import type { PdfEngine } from '@folio/pdf-core';
import {
  createMemoryPlatformAdapter,
  memoryFile,
  type PlatformAdapter,
  type TransferRequest,
} from '@folio/platform-adapters';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context';
import { createUiStore } from '../store/ui';
import { createWorkspaceStore } from '../store/workspace';
import { Workspace } from './workspace';

/** Never finishes opening: the test only checks that a document was opened. */
const pendingEngine: PdfEngine = {
  open: () => new Promise(() => undefined),
  destroy: () => undefined,
};

async function setup() {
  let deliver: (request: TransferRequest) => void = () => undefined;
  const answerTransfer = vi.fn(async (id: string, accept: boolean) =>
    accept ? [memoryFile(`${id}.pdf`, new Uint8Array([1, 2, 3]))] : [],
  );
  const adapter: PlatformAdapter = {
    ...createMemoryPlatformAdapter({ nativeMessaging: true }).adapter,
    platform: 'desktop',
    onTransferRequest: (listener) => {
      deliver = listener;
      return () => undefined;
    },
    answerTransfer,
  };
  const workspace = createWorkspaceStore(pendingEngine);
  render(
    <WorkspaceProvider
      adapter={adapter}
      engine={pendingEngine}
      profile="desktop"
      stores={{ workspace, ui: createUiStore(adapter.storage) }}
    >
      <Workspace />
    </WorkspaceProvider>,
  );
  // The workspace shows (and listens) once its settings are loaded.
  await screen.findByRole('heading', { name: 'Open a PDF to get started' });
  return {
    send: (request: TransferRequest) => act(() => deliver(request)),
    answerTransfer,
    workspace,
  };
}

const prompt = () => screen.queryByRole('dialog', { name: 'Open a document from Chrome?' });

describe('documents sent from Chrome', () => {
  it('opens nothing until the user agrees, one request at a time', async () => {
    const { send, answerTransfer, workspace } = await setup();
    send({ id: 'first', name: 'Invoice.pdf', size: 2048 });
    send({ id: 'second', name: 'Contract.pdf', size: 4096 });
    expect(prompt()?.textContent).toContain('Invoice.pdf');
    expect(prompt()?.textContent).toContain('(2.0 KB)');
    expect(answerTransfer).not.toHaveBeenCalled();
    expect(workspace.getState().documents).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    expect(answerTransfer).toHaveBeenCalledWith('first', true);
    expect(workspace.getState().documents.map((doc) => doc.fileName)).toEqual(['first.pdf']);

    // The next request is asked about next; declining deletes it.
    expect(prompt()?.textContent).toContain('Contract.pdf');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    });
    expect(answerTransfer).toHaveBeenLastCalledWith('second', false);
    expect(workspace.getState().documents).toHaveLength(1);
    expect(prompt()).toBeNull();
  });

  it('asks once for a request that is announced twice', async () => {
    const { send } = await setup();
    send({ id: 'same', name: 'Twice.pdf', size: 10 });
    send({ id: 'same', name: 'Twice.pdf', size: 10 });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
