import { PdfError, type PdfEngine } from '@folio/pdf-core';
import {
  createMemoryPlatformAdapter,
  memoryFile,
  type IncomingFile,
  type PlatformAdapter,
} from '@folio/platform-adapters';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ShortcutProfile } from '../commands';
import { WorkspaceProvider } from '../context';
import { createUiStore } from '../store/ui';
import { createWorkspaceStore } from '../store/workspace';
import { Workspace } from './workspace';

/** Never finishes opening, so documents stay in their loading state. */
const pendingEngine: PdfEngine = {
  open: () => new Promise(() => undefined),
  destroy: () => undefined,
};

const file = (name: string): IncomingFile => memoryFile(name, new Uint8Array([1, 2, 3]));

function setup({
  profile = 'desktop',
  os = 'windows',
}: { profile?: ShortcutProfile; os?: PlatformAdapter['os'] } = {}) {
  const adapter: PlatformAdapter = { ...createMemoryPlatformAdapter().adapter, os };
  // Opens nothing: every file fails, after asking for a password while `locked`.
  const opening = { locked: false };
  const engine: PdfEngine = {
    open: (_bytes, options) =>
      Promise.reject(
        new PdfError(
          opening.locked && options?.password === undefined ? 'password-required' : 'invalid-pdf',
        ),
      ),
    destroy: () => undefined,
  };
  const stores = { workspace: createWorkspaceStore(engine), ui: createUiStore(adapter.storage) };
  render(
    <WorkspaceProvider adapter={adapter} engine={engine} profile={profile} stores={stores}>
      <Workspace />
    </WorkspaceProvider>,
  );
  return { ...stores, opening };
}

const tab = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name.replaceAll('.', '\\.')}`) });

describe('workspace', () => {
  it('keeps files that arrived before mounting in StrictMode', async () => {
    const memory = createMemoryPlatformAdapter();
    const release = vi.fn();
    memory.deliver([{ ...file('launch.pdf'), release }]);
    const { unmount } = render(
      <StrictMode>
        <WorkspaceProvider adapter={memory.adapter} engine={pendingEngine} profile="desktop">
          <Workspace />
        </WorkspaceProvider>
      </StrictMode>,
    );
    expect(await screen.findByRole('button', { name: /^launch\.pdf/ })).toBeTruthy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(screen.getByRole('button', { name: /^launch\.pdf/ })).toBeTruthy();
    expect(release).not.toHaveBeenCalled();

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(release).toHaveBeenCalledOnce();
  });

  describe('closing a document from its own controls', () => {
    it('moves focus to the tab shown next', async () => {
      const { workspace } = setup();
      await act(() => workspace.getState().openFiles([file('a.pdf'), file('b.pdf')]));
      const close = screen.getByRole('button', { name: 'Close a.pdf' });
      close.focus();
      fireEvent.click(close);
      expect(document.activeElement).toBe(tab('b.pdf'));
      expect(tab('b.pdf').getAttribute('aria-current')).toBe('page');
    });

    it('moves focus to the Welcome screen once no document is left', async () => {
      const { workspace } = setup();
      await act(() => workspace.getState().openFiles([file('broken.pdf')]));
      const close = await screen.findByRole('button', { name: 'Close tab' });
      close.focus();
      fireEvent.click(close);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Choose PDF/ }));
    });

    it('moves focus from the password screen to the tab shown next', async () => {
      const { workspace, opening } = setup();
      opening.locked = true;
      await act(() => workspace.getState().openFiles([file('locked.pdf')]));
      opening.locked = false;
      await act(() => workspace.getState().openFiles([file('other.pdf')]));
      fireEvent.click(tab('locked.pdf'));
      const close = await screen.findByRole('button', { name: 'Close' });
      close.focus();
      fireEvent.click(close);
      expect(document.activeElement).toBe(tab('other.pdf'));
    });

    it('leaves focus alone when it is outside the closed document', async () => {
      const { workspace } = setup();
      await act(() => workspace.getState().openFiles([file('a.pdf'), file('b.pdf')]));
      const open = screen.getByRole('button', { name: 'Open PDF' });
      open.focus();
      act(() => {
        fireEvent.keyDown(open, { key: 'w', code: 'KeyW', ctrlKey: true });
      });
      expect(workspace.getState().documents).toHaveLength(1);
      expect(document.activeElement).toBe(open);
    });
  });

  describe('shortcuts while typing a password', () => {
    async function passwordField(options: Parameters<typeof setup>[0]) {
      const stores = setup(options);
      stores.opening.locked = true;
      await act(() => stores.workspace.getState().openFiles([file('locked.pdf')]));
      const field = await screen.findByLabelText('Password');
      return { ...stores, field };
    }

    it('lets AltGr type characters instead of toggling panels', async () => {
      const { ui, field } = await passwordField({ os: 'windows' });
      // Windows reports AltGr as Ctrl+Alt; Chromium also sets AltGraph.
      const typed = fireEvent.keyDown(field, {
        key: '@',
        code: 'Digit2',
        ctrlKey: true,
        altKey: true,
        modifierAltGraph: true,
      });
      expect(typed).toBe(true);
      // Left Ctrl + left Alt types "@" too, without AltGraph.
      expect(
        fireEvent.keyDown(field, { key: '@', code: 'Digit2', ctrlKey: true, altKey: true }),
      ).toBe(true);
      // …and starts dead-key characters ("~" on French AZERTY is AltGr+2).
      expect(
        fireEvent.keyDown(field, { key: 'Dead', code: 'Digit2', ctrlKey: true, altKey: true }),
      ).toBe(true);
      expect(ui.getState().rightPanelOpen).toBe(true);
    });

    it('still runs Ctrl/⌘ shortcuts that type nothing', async () => {
      const { ui, field } = await passwordField({ os: 'windows' });
      expect(
        fireEvent.keyDown(field, { key: '2', code: 'Digit2', ctrlKey: true, altKey: true }),
      ).toBe(false);
      expect(ui.getState().rightPanelOpen).toBe(false);
    });

    it('lets Option type characters on a Mac instead of closing the document', async () => {
      const { workspace, field } = await passwordField({ profile: 'browser', os: 'macos' });
      expect(fireEvent.keyDown(field, { key: '∑', code: 'KeyW', altKey: true })).toBe(true);
      expect(workspace.getState().documents).toHaveLength(1);
      // Outside the field, ⌥W is the browser profile's close shortcut.
      field.blur();
      act(() => {
        fireEvent.keyDown(document.body, { key: '∑', code: 'KeyW', altKey: true });
      });
      expect(workspace.getState().documents).toHaveLength(0);
    });
  });
});
