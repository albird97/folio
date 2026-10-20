import { isDirty, type PageId } from '@folio/document-model';
import type { TransferRequest } from '@folio/platform-adapters';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Label,
} from '@folio/shared-ui';
import { useId, useState, type FormEvent } from 'react';
import { useUi, useWorkspaceContext } from '../context';
import { formatBytes, formatDate, parsePageRange } from '../format';
import { insertFiles } from '../hooks/use-page-commands';
import { pagesLabel } from '../store/editing';
import { usePrint } from '../hooks/use-print';
import { useSave } from '../hooks/use-save';
import type { DialogRequest } from '../store/ui';
import { OpenUrlDialog } from './open-url-dialog';
import { AskAiDialog } from './tools/ask-ai-dialog';
import { ExportImagesDialog } from './tools/export-images-dialog';
import { ExportTextDialog } from './tools/export-text-dialog';
import { PageNumbersDialog } from './tools/page-numbers-dialog';
import { ProtectDialog } from './tools/protect-dialog';
import { RecognizeTextDialog } from './tools/recognize-text-dialog';
import { ReduceFileSizeDialog } from './tools/reduce-file-size-dialog';
import { SignatureDialog } from './tools/signature-dialog';
import { WatermarkDialog } from './tools/watermark-dialog';
import { claimRecord, releaseRecord } from '../store/recovery-locks';

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

function CopyPagesDialog({ request }: { request: Of<'copy-pages'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const id = useId();
  const [place, setPlace] = useState<'end' | 'after-current'>('end');
  const [busy, setBusy] = useState(false);
  const documents = workspace.getState().documents;
  const from = documents.find((entry) => entry.key === request.fromKey);
  const to = documents.find((entry) => entry.key === request.toKey);
  const pages = to?.editor?.model.pages ?? [];
  const current = Math.max(
    0,
    pages.findIndex((page) => page.id === to?.view?.currentPageId),
  );
  const count = request.pageIds.length;
  const close = () => ui.getState().closeDialog();
  if (!from || !to) return null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const state = workspace.getState();
    const before = state.notice?.id;
    void state
      .copyPagesToDocument(
        request.fromKey,
        request.pageIds,
        request.toKey,
        place === 'end' ? pages.length : current + 1,
      )
      .then((copied) => {
        // Say where they went, unless the copy had something else to say.
        if (copied && workspace.getState().notice?.id === before) {
          state.showNotice(`Copied ${pagesLabel(count)} to ${to.fileName}.`);
        }
      })
      .finally(close);
  };

  return (
    <DialogContent aria-describedby={`${id}-description`}>
      <form onSubmit={onSubmit}>
        <DialogTitle>
          Copy {pagesLabel(count)} to {to.fileName}
        </DialogTitle>
        <DialogDescription id={`${id}-description`}>
          The pages are copied with their comments. {from.fileName} is not changed.
        </DialogDescription>
        <fieldset className="mt-4 space-y-3 text-sm">
          <legend className="mb-2 font-medium">Where they go</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-place`}
              checked={place === 'end'}
              onChange={() => setPlace('end')}
            />
            At the end, after page {pages.length}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-place`}
              checked={place === 'after-current'}
              onChange={() => setPlace('after-current')}
            />
            After page {current + 1}, the page shown
          </label>
        </fieldset>
        <DialogFooter>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Copy
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function CloseDocumentDialog({ request }: { request: Of<'close-document'> }) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const save = useSave();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  const close = () => ui.getState().closeDialog();
  if (!doc) return null;
  const inPlace = adapter.features.saveInPlace && doc.saveTarget !== null;
  const discard = () => {
    ui.getState().closeDialog();
    void workspace.getState().close(doc.key);
  };
  const saveAndClose = () => {
    ui.getState().closeDialog();
    void save(doc.key).then((saved) => {
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
        <Button variant="primary" onClick={saveAndClose} autoFocus>
          {inPlace ? 'Save' : 'Save as…'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function SaveConflictDialog({ request }: { request: Of<'save-conflict'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  const answer = (choice: 'overwrite' | 'save-as' | 'cancel') => {
    request.resolve(choice);
    ui.getState().closeDialog();
  };
  return (
    <DialogContent>
      <DialogTitle>{doc?.saveTarget?.name ?? 'The file'} changed on disk</DialogTitle>
      <DialogDescription>
        Another program changed the file since Folio opened or saved it. Replacing it loses those
        changes; saving under a new name keeps both.
      </DialogDescription>
      <DialogFooter>
        <Button variant="danger" onClick={() => answer('overwrite')} className="mr-auto">
          Replace the file
        </Button>
        <Button onClick={() => answer('cancel')}>Cancel</Button>
        <Button variant="primary" onClick={() => answer('save-as')} autoFocus>
          Save as…
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function QuitDialog({ request }: { request: Of<'quit'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const dirty = workspace
    .getState()
    .documents.filter((doc) => doc.editor !== null && isDirty(doc.editor));
  const answer = (close: boolean) => {
    request.resolve(close);
    ui.getState().closeDialog();
  };
  return (
    <DialogContent>
      <DialogTitle>
        {dirty.length === 1
          ? `Close Folio without saving ${dirty[0]!.fileName}?`
          : `Close Folio without saving ${dirty.length} documents?`}
      </DialogTitle>
      <DialogDescription>
        {dirty.length > 1
          ? `${dirty.map((doc) => doc.fileName).join(', ')} have changes that are not saved.`
          : 'Its changes are not saved.'}{' '}
        Cancel to save them first.
      </DialogDescription>
      <DialogFooter>
        <Button variant="danger" onClick={() => answer(true)} className="mr-auto">
          Close without saving
        </Button>
        <Button variant="primary" onClick={() => answer(false)} autoFocus>
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RecoverDialog({ request }: { request: Of<'recover'> }) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const [records, setRecords] = useState(request.records);
  const [busy, setBusy] = useState<string | null>(null);
  const [password, setPassword] = useState<{
    recordId: string;
    sourceId: string;
    fileName: string;
    rejected: boolean;
    known: Record<string, string>;
  } | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const done = (recordId: string) => {
    const remaining = records.filter((record) => record.id !== recordId);
    setRecords(remaining);
    if (remaining.length === 0) ui.getState().closeDialog();
  };

  /** Takes a record from other windows; tells the user when one has it open. */
  const claim = async (recordId: string) => {
    if (await claimRecord(recordId)) return true;
    setError('This document is open in another Folio window.');
    done(recordId);
    return false;
  };

  const restore = async (recordId: string, passwords: Record<string, string> = {}) => {
    setBusy(recordId);
    setError(null);
    let restored = false;
    try {
      if (!(await claim(recordId))) return;
      const stored = await adapter.recovery.load(recordId);
      if (!stored) {
        setError('This recovered work is no longer available.');
        done(recordId);
        return;
      }
      const outcome = await workspace.getState().restoreDocument({
        snapshot: stored.snapshot,
        files: stored.files,
        passwords,
        recoveryId: recordId,
      });
      if (outcome.status === 'restored') {
        // The document keeps the record (and its lock) until it is saved or closed.
        restored = true;
        setPassword(null);
        done(recordId);
      } else if (outcome.status === 'needs-password') {
        setValue('');
        setPassword({
          recordId,
          sourceId: outcome.sourceId,
          fileName: outcome.fileName,
          rejected: outcome.rejected,
          known: passwords,
        });
      } else {
        setError(outcome.message);
      }
    } catch {
      setError('This recovered work could not be read.');
    } finally {
      if (!restored) releaseRecord(recordId);
      setBusy(null);
    }
  };

  const discard = async (recordId: string) => {
    setError(null);
    if (!(await claim(recordId))) return;
    await adapter.recovery.remove(recordId).catch(() => undefined);
    releaseRecord(recordId);
    done(recordId);
  };

  return (
    <DialogContent className="w-[min(32rem,calc(100vw-2rem))]">
      <DialogTitle>Recover unsaved changes</DialogTitle>
      <DialogDescription>
        Folio closed before these documents were saved. Their unsaved changes were kept on this
        device.
      </DialogDescription>
      <ul aria-label="Recovered documents" className="mt-4 space-y-2">
        {records.map((record) => (
          <li
            key={record.id}
            className="flex items-center gap-3 rounded-md bg-surface px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{record.title}</span>
              <span className="block text-xs text-ink-muted">
                Changed {formatDate(record.savedAt)}
              </span>
            </span>
            <Button size="sm" onClick={() => void discard(record.id)} disabled={busy !== null}>
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void restore(record.id)}
              disabled={busy !== null}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
      {password ? (
        <form
          className="mt-4 flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!value) return;
            void restore(password.recordId, { ...password.known, [password.sourceId]: value });
          }}
        >
          <Label htmlFor={`${id}-password`}>Password for {password.fileName}</Label>
          <div className="flex gap-2">
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="off"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={password.rejected || undefined}
            />
            <Button type="submit" variant="primary" disabled={!value || busy !== null}>
              Unlock
            </Button>
          </div>
          {password.rejected ? (
            <p role="alert" className="text-xs text-danger-ink">
              That password is incorrect.
            </p>
          ) : null}
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-danger-ink">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button>Decide later</Button>
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  );
}

function TransferDialog({ request }: { request: TransferRequest }) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const [busy, setBusy] = useState(false);
  const answer = async (accept: boolean) => {
    if (!adapter.answerTransfer) return;
    setBusy(true);
    try {
      const files = await adapter.answerTransfer(request.id, accept);
      // Opening shows in its own tab (with any error there), so the prompt can go.
      if (accept && files.length > 0) void workspace.getState().openFiles(files);
    } catch {
      workspace.getState().showNotice('The document from Chrome could not be opened.');
    } finally {
      ui.getState().finishTransfer(request.id);
    }
  };
  return (
    <DialogContent>
      <DialogTitle>Open a document from Chrome?</DialogTitle>
      <DialogDescription>
        The Folio extension in Chrome wants to open{' '}
        <span className="font-medium text-ink">{request.name}</span> ({formatBytes(request.size)})
        in Folio. Nothing is opened unless you allow it; a declined document is deleted.
      </DialogDescription>
      <DialogFooter>
        <Button onClick={() => void answer(false)} disabled={busy}>
          Decline
        </Button>
        <Button variant="primary" onClick={() => void answer(true)} disabled={busy} autoFocus>
          Open
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function PrintDialog({ request }: { request: Of<'print'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const print = usePrint();
  const id = useId();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  const pages = doc?.editor?.model.pages ?? [];
  const current = Math.max(
    0,
    pages.findIndex((page) => page.id === doc?.view?.currentPageId),
  );
  const [range, setRange] = useState<'all' | 'current' | 'custom'>('all');
  const [custom, setCustom] = useState(`1-${pages.length}`);
  const [comments, setComments] = useState(true);
  const positions =
    range === 'all'
      ? pages.map((_, index) => index)
      : range === 'current'
        ? [current]
        : parsePageRange(custom, pages.length);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!positions || !doc) return;
    ui.getState().closeDialog();
    void print(doc.key, {
      pageIds: positions.map((position) => pages[position]!.id),
      includeComments: comments,
    });
  };
  return (
    <DialogContent aria-describedby={`${id}-description`}>
      <form onSubmit={onSubmit}>
        <DialogTitle>Print</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Folio prepares the pages, then opens your system’s print dialog.
        </DialogDescription>
        <fieldset className="mt-4 space-y-2 text-sm">
          <legend className="mb-1 text-xs font-semibold">Pages</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-range`}
              checked={range === 'all'}
              onChange={() => setRange('all')}
            />
            All {pages.length} pages
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-range`}
              checked={range === 'current'}
              onChange={() => setRange('current')}
            />
            Current page ({current + 1})
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-range`}
              checked={range === 'custom'}
              onChange={() => setRange('custom')}
            />
            Pages
            <Input
              aria-label="Pages to print"
              className="h-7 w-40"
              value={custom}
              onFocus={() => setRange('custom')}
              onChange={(event) => setCustom(event.target.value)}
              aria-invalid={(range === 'custom' && !positions) || undefined}
            />
          </label>
        </fieldset>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={comments}
            onChange={(event) => setComments(event.target.checked)}
          />
          Print comments and drawings
        </label>
        {range === 'custom' && !positions ? (
          <p role="alert" className="mt-2 text-xs text-danger-ink">
            Enter pages like 1-3, 5 (from 1 to {pages.length}).
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={!positions}>
            Print…
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function DesktopMissingDialog() {
  return (
    <DialogContent>
      <DialogTitle>Folio for desktop is not connected</DialogTitle>
      <DialogDescription>
        Chrome could not reach the Folio desktop app. To open documents from Chrome there:
      </DialogDescription>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm">
        <li>Install Folio for desktop on this computer (macOS or Windows) and open it.</li>
        <li>
          Choose <span className="font-medium">Connect to Chrome…</span> in its File menu and allow
          it.
        </li>
        <li>Try again here. Folio for desktop asks you before it opens anything.</li>
      </ol>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="primary">OK</Button>
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  );
}

/** The dialog the workspace asked for, if any; then documents sent from Chrome. */
export function Dialogs() {
  const dialog = useUi((state) => state.dialog);
  const transfer = useUi((state) => state.transfers[0] ?? null);
  // Questions waiting for an answer get the cautious one (see the ui store).
  const closeDialog = useUi((state) => state.closeDialog);
  if (!dialog && transfer) {
    return (
      <Dialog open onOpenChange={() => undefined}>
        <TransferDialog key={transfer.id} request={transfer} />
      </Dialog>
    );
  }
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
      {dialog?.kind === 'insert-password' ? (
        <InsertPasswordDialog key={dialog.file.name} request={dialog} />
      ) : dialog?.kind === 'split' ? (
        <SplitDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'copy-pages' ? (
        <CopyPagesDialog key={dialog.toKey} request={dialog} />
      ) : dialog?.kind === 'close-document' ? (
        <CloseDocumentDialog request={dialog} />
      ) : dialog?.kind === 'save-conflict' ? (
        <SaveConflictDialog request={dialog} />
      ) : dialog?.kind === 'quit' ? (
        <QuitDialog request={dialog} />
      ) : dialog?.kind === 'recover' ? (
        <RecoverDialog request={dialog} />
      ) : dialog?.kind === 'print' ? (
        <PrintDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'open-url' ? (
        <OpenUrlDialog request={dialog} />
      ) : dialog?.kind === 'desktop-missing' ? (
        <DesktopMissingDialog />
      ) : dialog?.kind === 'signature' ? (
        <SignatureDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'page-numbers' ? (
        <PageNumbersDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'watermark' ? (
        <WatermarkDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'recognize-text' ? (
        <RecognizeTextDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'export-images' ? (
        <ExportImagesDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'export-text' ? (
        <ExportTextDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'reduce-file-size' ? (
        <ReduceFileSizeDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'protect' ? (
        <ProtectDialog key={dialog.docKey} request={dialog} />
      ) : dialog?.kind === 'ask-ai' ? (
        <AskAiDialog key={dialog.docKey} request={dialog} />
      ) : null}
    </Dialog>
  );
}
