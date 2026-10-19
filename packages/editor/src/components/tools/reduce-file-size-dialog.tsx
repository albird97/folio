import type { CompressionPreset, ExportWarning } from '@folio/pdf-core/export';
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
import { formatBytes } from '../../format';
import { exportFailureMessage, saveNotes } from '../../hooks/use-save-as';
import type { DialogOf } from '../../store/ui';
import { baseName, type WorkspaceDocument } from '../../store/workspace';
import { ExportProgress, savedNotice } from './export-progress';

const PRESETS: ReadonlyArray<{ value: CompressionPreset; label: string; description: string }> = [
  {
    value: 'high-quality',
    label: 'High quality',
    description: 'Keeps every image as it is and leaves out data nobody sees.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Also saves large images as JPEG, at most 2000 pixels wide or high.',
  },
  {
    value: 'small',
    label: 'Small',
    description: 'Saves large images as smaller JPEGs, at most 1400 pixels: for email.',
  },
];

type Run =
  | { status: 'choosing' }
  /** `done` is null until the images are being re-encoded. */
  | { status: 'running'; done: number | null; total: number }
  | { status: 'done'; bytes: Uint8Array; warnings: ExportWarning[] }
  | { status: 'failed'; message: string };

/** "12.4 MB → 3.1 MB (−75%)". */
function sizeChange(before: number, after: number): string {
  const saved = Math.round((1 - after / before) * 100);
  return `${formatBytes(before)} → ${formatBytes(after)} (−${saved}%)`;
}

/**
 * Reduce file size: writes a smaller copy of the document as it is now and
 * offers to save it. The document itself does not change, and protected
 * documents stay protected.
 */
export function ReduceFileSizeDialog({ request }: { request: DialogOf<'reduce-file-size'> }) {
  const doc = useWorkspace(
    (state) =>
      state.documents.find((entry) => entry.key === request.docKey && entry.editor) ?? null,
  );
  const closeDialog = useUi((state) => state.closeDialog);
  // A document closed meanwhile closes the dialog.
  useEffect(() => {
    if (!doc) closeDialog();
  }, [doc, closeDialog]);
  return doc ? <ReduceFileSize doc={doc} /> : null;
}

function ReduceFileSize({ doc }: { doc: WorkspaceDocument }) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const id = useId();
  // Re-encoding images changes what pages show.
  const lossy = doc.permissions.modify;
  const [preset, setPreset] = useState<CompressionPreset>(lossy ? 'balanced' : 'high-quality');
  const [run, setRun] = useState<Run>({ status: 'choosing' });
  const [saving, setSaving] = useState(false);
  const running = useRef<AbortController | null>(null);

  // Closing the dialog stops compressing.
  useEffect(() => () => running.current?.abort(), []);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (run.status === 'running') return;
    const controller = new AbortController();
    running.current = controller;
    const { signal } = controller;
    setRun({ status: 'running', done: null, total: 0 });
    try {
      // Loaded with the exporter, which the workspace loads on first use.
      const { COMPRESSION_PRESETS } = await import('@folio/pdf-core/export');
      const { bytes, warnings } = await workspace.getState().exportDocument(doc.key, {
        compression: {
          images: COMPRESSION_PRESETS[preset],
          signal,
          onProgress: (done, total) => {
            if (!signal.aborted) setRun({ status: 'running', done, total });
          },
        },
      });
      if (!signal.aborted) setRun({ status: 'done', bytes, warnings });
    } catch (error) {
      if (!signal.aborted) setRun({ status: 'failed', message: exportFailureMessage(error) });
    } finally {
      if (running.current === controller) running.current = null;
    }
  };

  const save = async (bytes: Uint8Array, warnings: ExportWarning[]) => {
    setSaving(true);
    try {
      const result = await adapter.saveFileAs({
        suggestedName: `${baseName(doc.fileName)} (compressed).pdf`,
        bytes,
      });
      if (result.status === 'cancelled') return;
      workspace
        .getState()
        .showNotice(savedNotice(result, saveNotes(warnings, doc.info?.hasSignatures ?? false)));
      ui.getState().closeDialog();
    } catch {
      setRun({ status: 'failed', message: 'The copy could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  const smaller = run.status === 'done' && run.bytes.length < doc.byteLength;
  return (
    <DialogContent aria-describedby={`${id}-description`}>
      <form onSubmit={(event) => void start(event)}>
        <DialogTitle>Reduce file size</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Makes a smaller copy of the document as it is now; this document stays as it is. Protected
          documents stay protected.
        </DialogDescription>
        {run.status === 'choosing' ? (
          <>
            <fieldset className="mt-4 space-y-3 text-sm">
              <legend className="mb-1 text-xs font-semibold">Quality</legend>
              {PRESETS.map((option) => {
                const disabled = option.value !== 'high-quality' && !lossy;
                return (
                  <div
                    key={option.value}
                    className={disabled ? 'flex gap-2 opacity-45' : 'flex gap-2'}
                  >
                    <input
                      id={`${id}-${option.value}`}
                      type="radio"
                      name={`${id}-preset`}
                      className="mt-1"
                      checked={preset === option.value}
                      disabled={disabled}
                      onChange={() => setPreset(option.value)}
                      aria-describedby={`${id}-${option.value}-description`}
                    />
                    <div>
                      <label htmlFor={`${id}-${option.value}`} className="font-medium">
                        {option.label}
                      </label>
                      <p
                        id={`${id}-${option.value}-description`}
                        className="text-xs text-ink-muted"
                      >
                        {option.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </fieldset>
            {!lossy ? (
              <p className="mt-3 text-xs text-ink-muted">
                The author of this document does not allow changing it, so its images stay as they
                are.
              </p>
            ) : null}
          </>
        ) : run.status === 'running' ? (
          <ExportProgress
            label="Reduce file size"
            status={
              run.done === null || run.total === 0
                ? 'Making a smaller copy…'
                : `Re-encoding image ${Math.min(run.done + 1, run.total)} of ${run.total}…`
            }
            fraction={run.done === null || run.total === 0 ? null : run.done / run.total}
          />
        ) : run.status === 'done' ? (
          <p role="status" className="mt-4 text-sm">
            {smaller
              ? sizeChange(doc.byteLength, run.bytes.length)
              : 'This document is already as small as Folio can make it.'}
          </p>
        ) : (
          <Banner tone="danger" title={run.message} className="mt-4" />
        )}
        <DialogFooter>
          {run.status === 'choosing' ? (
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary">
                Reduce file size
              </Button>
            </>
          ) : run.status === 'running' ? (
            <DialogClose asChild>
              <Button autoFocus>Cancel</Button>
            </DialogClose>
          ) : run.status === 'done' && smaller ? (
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                variant="primary"
                autoFocus
                disabled={saving}
                onClick={() => void save(run.bytes, run.warnings)}
              >
                Save as…
              </Button>
            </>
          ) : (
            <>
              <DialogClose asChild>
                <Button>Close</Button>
              </DialogClose>
              <Button variant="primary" autoFocus onClick={() => setRun({ status: 'choosing' })}>
                {run.status === 'done' ? 'Choose another quality' : 'Try again'}
              </Button>
            </>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
