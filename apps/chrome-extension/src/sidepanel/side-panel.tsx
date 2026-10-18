import { formatBytes, formatPageSize } from '@folio/editor';
import { isPdfError, type PdfDocumentHandle, type PdfEngine } from '@folio/pdf-core';
import { incomingFromFile, pickFilesWithInput } from '@folio/platform-adapters';
import { Banner, Button, cn, FolioWordmark, ICON, Spinner } from '@folio/shared-ui';
import { ExternalLink, FileUp, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { sendMessage } from '../shared/messages';
import { deleteHandoff, putHandoff } from '../shared/handoff';
import { openEditor } from '../shared/surface';
import { PdfTools } from './pdf-tools';
import { ThisTab } from './this-tab';

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string }
  | { kind: 'ready'; name: string; bytes: Uint8Array; handle: PdfDocumentHandle }
  | { kind: 'locked'; name: string; bytes: Uint8Array }
  | { kind: 'error'; name: string; message: string };

function Thumbnail({ handle }: { handle: PdfDocumentHandle }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    const first = handle.info.pages[0];
    if (!canvas || !first) return;
    const rotated = first.rotation % 180 !== 0;
    const width = rotated ? first.size.height : first.size.width;
    const job = handle.renderPage(0, canvas, {
      scale: 132 / width,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    job.promise.then(
      (completed) => setDone(completed),
      () => setDone(false),
    );
    return () => job.cancel();
  }, [handle]);
  return (
    <div className="relative shrink-0">
      <canvas
        ref={canvasRef}
        data-testid="sidepanel-thumbnail"
        data-render-state={done ? 'done' : 'rendering'}
        role="img"
        aria-label="First page"
        className="block bg-page shadow-page"
      />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-xs">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right" data-selectable>
        {value}
      </dd>
    </div>
  );
}

export function SidePanel({ engine }: { engine: PdfEngine }) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [hovering, setHovering] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const current = useRef<PanelState>(state);
  /** Counts inspect() calls, so a slower, older load cannot replace a newer one. */
  const latestInspect = useRef(0);

  useEffect(() => {
    const previous = current.current;
    current.current = state;
    if (previous.kind === 'ready' && previous !== state) void previous.handle.destroy();
  }, [state]);

  useEffect(
    () => () => {
      if (current.current.kind === 'ready') void current.current.handle.destroy();
    },
    [],
  );

  const inspect = async (file: File) => {
    const request = ++latestInspect.current;
    const isLatest = () => request === latestInspect.current;
    setSendFailed(false);
    setState({ kind: 'loading', name: file.name });
    let bytes: Uint8Array;
    try {
      bytes = await incomingFromFile(file).read();
    } catch {
      if (isLatest()) {
        setState({ kind: 'error', name: file.name, message: 'The file could not be read.' });
      }
      return;
    }
    if (!isLatest()) return;
    try {
      const handle = await engine.open(bytes);
      if (!isLatest()) {
        void handle.destroy();
        return;
      }
      setState({ kind: 'ready', name: file.name, bytes, handle });
      void sendMessage({
        type: 'activity/record',
        kind: 'inspected',
        pageCount: handle.info.pageCount,
        fileName: file.name,
      });
    } catch (error) {
      if (!isLatest()) return;
      if (isPdfError(error, 'password-required')) {
        setState({ kind: 'locked', name: file.name, bytes });
      } else {
        setState({
          kind: 'error',
          name: file.name,
          message: isPdfError(error) ? error.message : 'The PDF could not be opened.',
        });
      }
    }
  };

  const choose = async () => {
    const [file] = await pickFilesWithInput();
    if (file) await inspect(file);
  };

  const sendToEditor = async (name: string, bytes: Uint8Array, pageCount?: number) => {
    setSending(true);
    setSendFailed(false);
    try {
      const id = await putHandoff(name, bytes);
      const response = await openEditor(id);
      if (!response.ok) {
        // No editor will read the record, so the document must not stay on disk.
        await deleteHandoff(id);
        setSendFailed(true);
        return;
      }
      void sendMessage({
        type: 'activity/record',
        kind: 'sent-to-editor',
        pageCount,
        fileName: name,
      });
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  const dropHandlers = {
    onDragOver(event: DragEvent) {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setHovering(true);
    },
    onDragLeave(event: DragEvent) {
      if (event.currentTarget === event.target) setHovering(false);
    },
    onDrop(event: DragEvent) {
      event.preventDefault();
      setHovering(false);
      const [file] = Array.from(event.dataTransfer.files);
      if (file) void inspect(file);
    },
  };

  return (
    <div className="folio-chrome flex min-h-full flex-col bg-surface text-ink" {...dropHandlers}>
      <header className="flex h-12 shrink-0 items-center border-b border-line px-4">
        <FolioWordmark />
      </header>

      <main className="flex flex-1 flex-col gap-4 p-4">
        <h1 className="sr-only">Folio side panel</h1>
        <ThisTab />
        <div
          className={cn(
            'flex flex-col items-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors duration-200',
            hovering ? 'border-accent bg-accent-soft/60' : 'border-line-strong',
          )}
        >
          <FileUp size={ICON.lg} strokeWidth={ICON.stroke} className="text-ink-muted" aria-hidden />
          <p className="mt-2 text-sm font-medium">Inspect a PDF</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Drop a file here or choose one from your computer.
          </p>
          <Button className="mt-3" variant="primary" size="sm" onClick={() => void choose()}>
            Choose PDF…
          </Button>
        </div>

        {state.kind === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-ink-muted" role="status">
            <Spinner /> Reading {state.name}…
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <Banner tone="danger" title={`Couldn’t open ${state.name}`}>
            {state.message}
          </Banner>
        ) : null}

        {state.kind === 'locked' ? (
          <section aria-label="Password protected document" className="rounded-lg bg-bg p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <LockKeyhole size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
              {state.name} is password protected
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Open it in the editor to enter the password.
            </p>
            <Button
              className="mt-3"
              size="sm"
              disabled={sending}
              onClick={() => void sendToEditor(state.name, state.bytes)}
            >
              <ExternalLink size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
              Open in editor
            </Button>
          </section>
        ) : null}

        {state.kind === 'ready' ? (
          <section aria-label="Document summary" className="flex flex-col gap-3">
            <div className="flex gap-3">
              <Thumbnail handle={state.handle} />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold break-words">
                  {state.handle.info.metadata.title || state.name}
                </h2>
                {state.handle.info.metadata.title ? (
                  <p className="mt-0.5 truncate text-xs text-ink-muted">{state.name}</p>
                ) : null}
                <p className="mt-1 text-xs text-ink-muted tabular">
                  {state.handle.info.pageCount}{' '}
                  {state.handle.info.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                  {formatBytes(state.bytes.byteLength)}
                </p>
              </div>
            </div>
            <dl className="rounded-md bg-bg px-3 py-1.5">
              {state.handle.info.metadata.author ? (
                <Fact label="Author" value={state.handle.info.metadata.author} />
              ) : null}
              <Fact
                label="First page"
                value={formatPageSize({
                  size: state.handle.info.pages[0]!.size,
                  sourceRotation: state.handle.info.pages[0]!.rotation,
                  rotation: 0,
                })}
              />
              <Fact label="PDF version" value={state.handle.info.pdfVersion ?? '—'} />
              <Fact
                label="Security"
                value={
                  state.handle.info.encryption === 'none'
                    ? 'Not encrypted'
                    : 'Encrypted, with restrictions'
                }
              />
              <Fact
                label="Forms"
                value={
                  state.handle.info.forms === 'none'
                    ? 'None'
                    : state.handle.info.forms === 'xfa'
                      ? 'XFA'
                      : 'Interactive'
                }
              />
            </dl>
            <Button
              variant="primary"
              disabled={sending}
              onClick={() =>
                void sendToEditor(state.name, state.bytes, state.handle.info.pageCount)
              }
            >
              <ExternalLink size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
              Open in editor
            </Button>
            <PdfTools
              key={`${state.name}:${state.bytes.byteLength}`}
              name={state.name}
              bytes={state.bytes}
              handle={state.handle}
            />
          </section>
        ) : null}

        {sendFailed ? (
          <Banner tone="danger" title="Couldn’t open the editor">
            Try again in a moment.
          </Banner>
        ) : null}
      </main>

      <footer className="flex items-center gap-1 border-t border-line bg-bg px-4 py-2 text-2xs text-ink-muted">
        <ShieldCheck size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
        Read on this device. Nothing is uploaded.
      </footer>
    </div>
  );
}
