import { exportPageImages, MAX_IMAGE_PAGES, type PageImageFormat } from '@folio/pdf-core';
import {
  Banner,
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  SegmentedControl,
} from '@folio/shared-ui';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useUi, useWorkspace, useWorkspaceContext } from '../../context';
import { PERMISSION_MESSAGES } from '../../store/editing';
import type { DialogOf } from '../../store/ui';
import { baseName, type WorkspaceDocument } from '../../store/workspace';
import { ExportProgress, savedNotice } from './export-progress';
import { PageScopeField, usePageScope } from './page-scope';
import { ROW_LABEL } from './stamp-dialog';

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
] as const;

const RESOLUTIONS = [
  { value: '72', label: '72 dpi' },
  { value: '150', label: '150 dpi' },
  { value: '300', label: '300 dpi' },
] as const;

type Run =
  | { status: 'choosing' }
  /** `done` is null while the document is being prepared. */
  | { status: 'running'; done: number | null; total: number }
  | { status: 'failed'; message: string };

/**
 * Export pages as images: each page the way it looks now (with comments,
 * form values and stamps, or as its file has it) as a PNG or JPEG image,
 * several in one ZIP archive. The document does not change.
 */
export function ExportImagesDialog({ request }: { request: DialogOf<'export-images'> }) {
  const doc = useWorkspace(
    (state) =>
      state.documents.find((entry) => entry.key === request.docKey && entry.editor) ?? null,
  );
  const closeDialog = useUi((state) => state.closeDialog);
  // A document closed meanwhile closes the dialog.
  useEffect(() => {
    if (!doc) closeDialog();
  }, [doc, closeDialog]);
  return doc ? <ExportImages doc={doc} /> : null;
}

function ExportImages({ doc }: { doc: WorkspaceDocument }) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const id = useId();
  const scope = usePageScope(doc);
  const [format, setFormat] = useState<PageImageFormat>('png');
  const [quality, setQuality] = useState(85);
  const [dpi, setDpi] = useState<'72' | '150' | '300'>('150');
  const [additions, setAdditions] = useState(true);
  const [run, setRun] = useState<Run>({ status: 'choosing' });
  const running = useRef<AbortController | null>(null);

  // Closing the dialog stops the export.
  useEffect(() => () => running.current?.abort(), []);

  const { positions, pages } = scope;
  const allowed = doc.permissions.extract;
  const tooMany = (positions?.length ?? 0) > MAX_IMAGE_PAGES;
  const ready = allowed && positions !== null && positions.length > 0 && !tooMany;

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !positions) return;
    const controller = new AbortController();
    running.current = controller;
    const { signal } = controller;
    setRun({ status: 'running', done: null, total: positions.length });
    try {
      // The pages as they look now, written in memory only (never saved
      // like this, so without the file's password); or as their files have
      // them, without what was added in Folio.
      const { bytes } = await workspace.getState().exportDocument(doc.key, {
        pageIds: positions.map((position) => pages[position]!.id),
        unprotected: true,
        ...(additions
          ? { flatten: true }
          : { withoutAnnotations: true, withoutStamps: true, withoutFormValues: true }),
      });
      signal.throwIfAborted();
      const handle = await workspace.engine.open(bytes);
      let file;
      try {
        file = await exportPageImages(handle, {
          pages: positions.map((position, index) => ({ index, number: position + 1 })),
          pageCount: pages.length,
          baseName: baseName(doc.fileName),
          dpi: Number(dpi),
          format,
          quality: quality / 100,
          signal,
          onProgress: (done, total) => {
            if (!signal.aborted) setRun({ status: 'running', done, total });
          },
        });
      } finally {
        await handle.destroy();
      }
      const result = await adapter.saveFileAs({
        suggestedName: file.name,
        bytes: file.bytes,
        kind: file.kind,
      });
      if (signal.aborted) return;
      if (result.status === 'cancelled') {
        setRun({ status: 'choosing' });
        return;
      }
      workspace.getState().showNotice(savedNotice(result));
      ui.getState().closeDialog();
    } catch {
      if (signal.aborted) return;
      setRun({ status: 'failed', message: 'The pages could not be exported.' });
    } finally {
      if (running.current === controller) running.current = null;
    }
  };

  const several = (positions?.length ?? 0) > 1;
  return (
    <DialogContent aria-describedby={`${id}-description`}>
      <form onSubmit={(event) => void start(event)}>
        <DialogTitle>Export pages as images</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Saves pages as pictures, the way they look now. Several pages are saved together in one
          ZIP file.
        </DialogDescription>
        {!allowed ? (
          <Banner tone="warning" title={PERMISSION_MESSAGES.extract} className="mt-4" />
        ) : null}
        {run.status === 'choosing' ? (
          <fieldset disabled={!allowed}>
            <PageScopeField state={scope} rangeLabel="Pages to export" />
            {tooMany ? (
              <p role="alert" className="mt-2 text-xs text-danger-ink">
                Choose up to {MAX_IMAGE_PAGES} pages at a time.
              </p>
            ) : null}
            <div className="mt-4 grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-3">
              <span className={ROW_LABEL} aria-hidden>
                Format
              </span>
              <SegmentedControl
                className="justify-self-start"
                label="Format"
                value={format}
                onValueChange={setFormat}
                options={FORMATS}
              />
              {format === 'jpeg' ? (
                <>
                  <label htmlFor={`${id}-quality`} className={ROW_LABEL}>
                    Quality
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id={`${id}-quality`}
                      type="range"
                      min={50}
                      max={100}
                      step={5}
                      value={quality}
                      onChange={(event) => setQuality(Number(event.target.value))}
                      aria-valuetext={`${quality}%`}
                      className="w-40 accent-accent"
                    />
                    <span className="w-10 text-xs text-ink-muted tabular-nums">{quality}%</span>
                  </div>
                </>
              ) : null}
              <span className={ROW_LABEL} aria-hidden>
                Resolution
              </span>
              <SegmentedControl
                className="justify-self-start"
                label="Resolution"
                value={dpi}
                onValueChange={setDpi}
                options={RESOLUTIONS}
              />
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={additions}
                onChange={(event) => setAdditions(event.target.checked)}
              />
              Include comments, form values and stamps
            </label>
            <p className="mt-3 text-xs text-ink-muted">
              {several ? 'Saved as one ZIP file of images.' : 'Saved as one image.'}
            </p>
          </fieldset>
        ) : run.status === 'running' ? (
          <ExportProgress
            label="Export"
            status={
              run.done === null
                ? 'Preparing the pages…'
                : run.done < run.total
                  ? `Drawing page ${run.done + 1} of ${run.total}…`
                  : 'Saving…'
            }
            fraction={run.done === null ? null : run.done / run.total}
          />
        ) : (
          <Banner tone="danger" title={run.message} className="mt-4">
            Try again with fewer pages or a lower resolution.
          </Banner>
        )}
        <DialogFooter>
          {run.status === 'choosing' ? (
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={!ready}>
                Export…
              </Button>
            </>
          ) : run.status === 'running' ? (
            <DialogClose asChild>
              <Button autoFocus>Cancel</Button>
            </DialogClose>
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
