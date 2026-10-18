import { isDirty, type PageId } from '@folio/document-model';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Label,
} from '@folio/shared-ui';
import { useId, useState, type FormEvent } from 'react';
import { useUi, useWorkspaceContext } from '../context';
import { insertFiles } from '../hooks/use-page-commands';
import { useSaveAs } from '../hooks/use-save-as';
import type { DialogRequest } from '../store/ui';

type Of<K extends DialogRequest['kind']> = Extract<DialogRequest, { kind: K }>;

function InsertPasswordDialog({ request }: { request: Of<'insert-password'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const close = () => ui.getState().closeDialog();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    ui.getState().closeDialog();
    void insertFiles(
      workspace,
      ui,
      request.docKey,
      [request.file, ...request.rest],
      request.index,
      password,
    );
  };

  return (
    <DialogContent aria-describedby={`${id}-description`}>
      <form onSubmit={onSubmit}>
        <DialogTitle>Insert pages from a protected PDF</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Enter the password of <span className="font-medium text-ink">{request.file.name}</span>.
          It is only kept in memory on this device.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor={`${id}-password`}>Password</Label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={request.rejected || undefined}
            aria-describedby={request.rejected ? `${id}-error` : undefined}
          />
          {request.rejected ? (
            <p id={`${id}-error`} role="alert" className="text-xs text-danger-ink">
              That password is incorrect. Check it and try again.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!password || busy}>
            Insert pages
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** Splits into parts of `size` pages, or before each page in `starts`. */
export function splitParts(
  pageIds: readonly PageId[],
  mode: { every: number } | { before: ReadonlySet<PageId> },
): PageId[][] {
  const parts: PageId[][] = [];
  pageIds.forEach((id, index) => {
    const start =
      'every' in mode ? index % Math.max(1, mode.every) === 0 : index === 0 || mode.before.has(id);
    if (start) parts.push([id]);
    else parts.at(-1)!.push(id);
  });
  return parts;
}

function SplitDialog({ request }: { request: Of<'split'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const id = useId();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  const pageIds = doc?.editor?.model.pages.map((page) => page.id) ?? [];
  const selection = new Set(doc?.selection.pages ?? []);
  const canUseSelection = pageIds.slice(1).some((pageId) => selection.has(pageId));
  const [mode, setMode] = useState<'every' | 'selected'>(canUseSelection ? 'selected' : 'every');
  const [every, setEvery] = useState(Math.max(1, Math.min(10, Math.ceil(pageIds.length / 2))));
  const [busy, setBusy] = useState(false);
  const parts =
    mode === 'every' ? splitParts(pageIds, { every }) : splitParts(pageIds, { before: selection });
  const close = () => ui.getState().closeDialog();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (parts.length < 2 || busy) return;
    setBusy(true);
    void workspace
      .getState()
      .splitDocument(request.docKey, parts)
      .finally(() => ui.getState().closeDialog());
  };

  return (
    <DialogContent aria-describedby={`${id}-description`}>
      <form onSubmit={onSubmit}>
        <DialogTitle>Split document</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Each part opens as a new document you can review and save. This document is not changed.
        </DialogDescription>
        <fieldset className="mt-4 space-y-3 text-sm">
          <legend className="sr-only">How to split</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === 'every'}
              onChange={() => setMode('every')}
            />
            Every
            <Input
              type="number"
              min={1}
              max={Math.max(1, pageIds.length - 1)}
              aria-label="Pages per part"
              className="h-7 w-16"
              value={every}
              onFocus={() => setMode('every')}
              onChange={(event) => {
                const value = Math.floor(Number(event.target.value));
                if (Number.isFinite(value) && value >= 1) setEvery(value);
              }}
            />
            pages
          </label>
          <label
            className={
              canUseSelection ? 'flex items-center gap-2' : 'flex items-center gap-2 opacity-45'
            }
          >
            <input
              type="radio"
              name={`${id}-mode`}
              disabled={!canUseSelection}
              checked={mode === 'selected'}
              onChange={() => setMode('selected')}
            />
            Before each selected page
          </label>
        </fieldset>
        <p className="mt-3 text-xs text-ink-muted" role="status">
          {parts.length < 2
            ? 'This would leave the document in one piece.'
            : `Creates ${parts.length} documents.`}
        </p>
        <DialogFooter>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={parts.length < 2 || busy}>
            Split
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function CloseDocumentDialog({ request }: { request: Of<'close-document'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const saveAs = useSaveAs();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  const close = () => ui.getState().closeDialog();
  if (!doc) return null;
  const discard = () => {
    ui.getState().closeDialog();
    void workspace.getState().close(doc.key);
  };
  const save = () => {
    ui.getState().closeDialog();
    void saveAs(doc.key).then((saved) => {
      if (saved) void workspace.getState().close(doc.key);
    });
  };
  return (
    <DialogContent>
      <DialogTitle>Save changes to {doc.fileName}?</DialogTitle>
      <DialogDescription>
        Your changes will be lost if you close the document without saving them.
      </DialogDescription>
      <DialogFooter>
        <Button variant="danger" onClick={discard} className="mr-auto">
          Don’t save
        </Button>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={save} autoFocus>
          Save as…
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** The dialog the workspace asked for, if any. */
export function Dialogs() {
  const dialog = useUi((state) => state.dialog);
  const closeDialog = useUi((state) => state.closeDialog);
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
      {dialog?.kind === 'insert-password' ? (
        <InsertPasswordDialog key={dialog.file.name} request={dialog} />
      ) : dialog?.kind === 'split' ? (
        <SplitDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'close-document' ? (
        <CloseDocumentDialog request={dialog} />
      ) : null}
    </Dialog>
  );
}

/** Whether closing would lose changes. */
export function hasUnsavedChanges(doc: { editor: Parameters<typeof isDirty>[0] | null }): boolean {
  return doc.editor !== null && isDirty(doc.editor);
}
