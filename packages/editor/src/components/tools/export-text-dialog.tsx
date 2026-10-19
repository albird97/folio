import { joinPageTexts } from '@folio/pdf-core';
import {
  Banner,
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@folio/shared-ui';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useUi, useWorkspace, useWorkspaceContext } from '../../context';
import { documentPageText } from '../../ocr/page-text';
import { PERMISSION_MESSAGES } from '../../store/editing';
import type { DialogOf } from '../../store/ui';
import { baseName, type WorkspaceDocument } from '../../store/workspace';
import { ExportProgress, savedNotice } from './export-progress';
import { PageScopeField, usePageScope } from './page-scope';

type Run =
  | { status: 'choosing' }
  | { status: 'running'; done: number; total: number }
  | { status: 'done'; text: string; copied: boolean }
  | { status: 'failed'; message: string };

const encoder = new TextEncoder();

/**
 * Export text: the text of pages, including text recognized in scans, shown
 * to copy or save as a plain text file. The document does not change.
 */
export function ExportTextDialog({ request }: { request: DialogOf<'export-text'> }) {
  const doc = useWorkspace(
    (state) =>
      state.documents.find((entry) => entry.key === request.docKey && entry.editor) ?? null,
  );
  const closeDialog = useUi((state) => state.closeDialog);
  // A document closed meanwhile closes the dialog.
  useEffect(() => {
    if (!doc) closeDialog();
  }, [doc, closeDialog]);
  return doc ? <ExportText doc={doc} /> : null;
}

function ExportText({ doc }: { doc: WorkspaceDocument }) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const id = useId();
  const scope = usePageScope(doc);
  const [run, setRun] = useState<Run>({ status: 'choosing' });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reading = useRef<AbortController | null>(null);

  // Closing the dialog stops reading.
  useEffect(() => () => reading.current?.abort(), []);

  const { positions, pages } = scope;
  const allowed = doc.permissions.extract;
  const ready = allowed && positions !== null && positions.length > 0;

  const read = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !positions) return;
    const controller = new AbortController();
    reading.current = controller;
    setRun({ status: 'running', done: 0, total: positions.length });
    try {
      const text = await joinPageTexts(
        positions.map((position) => pages[position]!),
        (page) => documentPageText(workspace, doc.key, page),
        {
          signal: controller.signal,
          onProgress: (done, total) => {
            if (!controller.signal.aborted) setRun({ status: 'running', done, total });
          },
        },
      );
      if (!controller.signal.aborted) setRun({ status: 'done', text, copied: false });
    } catch {
      if (!controller.signal.aborted) {
        setRun({ status: 'failed', message: 'The text could not be read.' });
      }
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  };

  const copy = (text: string) => {
    setProblem(null);
    void adapter.writeClipboardText(text).then(
      () => setRun({ status: 'done', text, copied: true }),
      () => setProblem('The text could not be copied.'),
    );
  };

  const save = async (text: string) => {
    setProblem(null);
    setSaving(true);
    try {
      const result = await adapter.saveFileAs({
        suggestedName: `${baseName(doc.fileName)} (text).txt`,
        bytes: encoder.encode(text),
        kind: 'text',
      });
      if (result.status === 'cancelled') return;
      workspace.getState().showNotice(savedNotice(result));
      ui.getState().closeDialog();
    } catch {
      setProblem('The text could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent
      aria-describedby={`${id}-description`}
      className={run.status === 'done' ? 'w-[min(40rem,calc(100vw-2rem))]' : undefined}
    >
      <form onSubmit={(event) => void read(event)}>
        <DialogTitle>Export text</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Shows the text of pages, including text recognized in scans, to copy or save as a text
          file.
        </DialogDescription>
        {!allowed ? (
          <Banner tone="warning" title={PERMISSION_MESSAGES.extract} className="mt-4" />
        ) : null}
        {run.status === 'choosing' ? (
          <fieldset disabled={!allowed}>
            <PageScopeField state={scope} rangeLabel="Pages to export" />
          </fieldset>
        ) : run.status === 'running' ? (
          <ExportProgress
            label="Reading text"
            status={`Reading page ${Math.min(run.done + 1, run.total)} of ${run.total}…`}
            fraction={run.done / run.total}
          />
        ) : run.status === 'done' ? (
          run.text ? (
            <textarea
              readOnly
              aria-label="Text of the pages"
              value={run.text}
              rows={14}
              className="mt-4 w-full resize-y rounded-md border border-line bg-surface p-2 font-mono text-xs"
            />
          ) : (
            <Banner tone="info" title="These pages have no text." className="mt-4">
              Scanned pages contain pictures of text. Recognize their text first (Tools › Recognize
              text), then export it.
            </Banner>
          )
        ) : (
          <Banner tone="danger" title={run.message} className="mt-4" />
        )}
        {problem ? (
          <p role="alert" className="mt-2 text-xs text-danger-ink">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          {run.status === 'choosing' ? (
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={!ready}>
                Show text
              </Button>
            </>
          ) : run.status === 'running' ? (
            <DialogClose asChild>
              <Button autoFocus>Cancel</Button>
            </DialogClose>
          ) : run.status === 'done' && run.text ? (
            <>
              <Button className="mr-auto" onClick={() => setRun({ status: 'choosing' })}>
                Other pages…
              </Button>
              <Button onClick={() => copy(run.text)}>{run.copied ? 'Copied' : 'Copy'}</Button>
              <Button variant="primary" disabled={saving} onClick={() => void save(run.text)}>
                Save as .txt…
              </Button>
            </>
          ) : run.status === 'done' ? (
            <>
              <Button onClick={() => setRun({ status: 'choosing' })}>Other pages…</Button>
              <Button
                variant="primary"
                autoFocus
                onClick={() =>
                  ui.getState().openDialog({ kind: 'recognize-text', docKey: doc.key })
                }
              >
                Recognize text…
              </Button>
            </>
          ) : (
            <>
              <DialogClose asChild>
                <Button>Close</Button>
              </DialogClose>
              <Button variant="primary" autoFocus onClick={() => setRun({ status: 'choosing' })}>
                Try again
              </Button>
            </>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
