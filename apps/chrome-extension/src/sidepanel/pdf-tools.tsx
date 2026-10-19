import {
  applyOperation,
  createDocumentModel,
  type Rotation,
  type SourceId,
} from '@folio/document-model';
import { parsePageRange } from '@folio/editor';
import {
  exportPageImages,
  extractText,
  MAX_IMAGE_PAGES,
  sha256Hex,
  toSourceDescriptor,
  type PageImageFormat,
  type PdfDocumentHandle,
} from '@folio/pdf-core';
import { downloadBytes, fileNameFor } from '@folio/platform-adapters';
import { Button, cn, ICON, Input, Label, SegmentedControl, Spinner } from '@folio/shared-ui';
import { FileOutput, FileText, Images, RotateCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

type Tool = 'rotate' | 'extract' | 'images' | 'text';

const encoder = new TextEncoder();

const TOOLS: Array<{ id: Tool; label: string; icon: ReactNode }> = [
  {
    id: 'rotate',
    label: 'Rotate pages',
    icon: <RotateCw size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />,
  },
  {
    id: 'extract',
    label: 'Extract pages',
    icon: <FileOutput size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />,
  },
  {
    id: 'images',
    label: 'Pages to images',
    icon: <Images size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />,
  },
  {
    id: 'text',
    label: 'Extract text',
    icon: <FileText size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />,
  },
];

const ROTATIONS = [
  { value: '90', label: 'Right' },
  { value: '180', label: 'Half turn' },
  { value: '270', label: 'Left' },
] as const;

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
] as const;

const RESOLUTIONS = [
  { value: '72', label: '72 dpi' },
  { value: '150', label: '150 dpi' },
  { value: '300', label: '300 dpi' },
] as const;

/** "1-3, 5" → "1-3, 5"; all pages → "all". For file names. */
const rangeLabel = (text: string) => text.trim().replace(/\s+/g, '') || 'all';

/**
 * Quick tools for the PDF inspected in the side panel. Results are new
 * files, downloaded; the PDF itself is never changed. Tools that write a PDF
 * honour the document's permissions, and protected documents go to the
 * editor, which keeps their protection.
 */
export function PdfTools({
  name,
  bytes,
  handle,
}: {
  name: string;
  bytes: Uint8Array;
  handle: PdfDocumentHandle;
}) {
  const [tool, setTool] = useState<Tool | null>(null);
  const [range, setRange] = useState('');
  const [rotation, setRotation] = useState<'90' | '180' | '270'>('90');
  const [format, setFormat] = useState<PageImageFormat>('png');
  const [dpi, setDpi] = useState<'72' | '150' | '300'>('150');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const running = useRef<AbortController | null>(null);
  const id = useId();

  useEffect(() => () => running.current?.abort(), []);

  const count = handle.info.pageCount;
  const positions = range.trim()
    ? parsePageRange(range, count)
    : Array.from({ length: count }, (_, index) => index);
  const baseName = name.replace(/\.pdf$/i, '').trim() || 'Document';
  const { permissions } = handle.info;
  const protectedPdf = handle.info.encryption !== 'none';
  const canWrite = !protectedPdf;
  const canCopy = permissions?.copy ?? true;

  const blocked: Record<Tool, string | null> = {
    rotate: canWrite
      ? null
      : 'Protected PDFs can be changed in the editor, which keeps their protection.',
    extract: canWrite
      ? null
      : 'Protected PDFs can be changed in the editor, which keeps their protection.',
    images: canCopy ? null : 'The author of this document does not allow copying its content.',
    text: canCopy ? null : 'The author of this document does not allow copying its content.',
  };

  const run = async (label: string, work: (signal: AbortSignal) => Promise<void>) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setProblem(null);
    setBusy(label);
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setProblem(error instanceof Error && error.message ? error.message : 'That did not work.');
      }
    } finally {
      if (running.current === controller) {
        running.current = null;
        setBusy(null);
      }
    }
  };

  /** The document as a model, to write rotated pages or a page selection with the exporter. */
  const model = async () => {
    const descriptor = toSourceDescriptor(handle.info, {
      fileName: name,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      origin: { kind: 'generated' },
    });
    const created = createDocumentModel(descriptor);
    const sourceId = Object.keys(created.sources)[0] as SourceId;
    return { created, sources: new Map([[sourceId, { bytes }]]) };
  };

  const apply = () => {
    if (!tool || !positions || positions.length === 0) return;
    switch (tool) {
      case 'rotate':
        void run('Rotating…', async () => {
          const { exportInWorker } = await import('@folio/pdf-core/export');
          const { created, sources } = await model();
          const pageIds = positions.map((position) => created.pages[position]!.id);
          const { model: turned } = applyOperation(created, {
            type: 'pages/rotate',
            pageIds,
            delta: Number(rotation) as Rotation,
          });
          const { bytes: out } = await exportInWorker({
            model: turned,
            sources,
            assets: new Map(),
          });
          downloadBytes(fileNameFor('pdf', `${baseName} (rotated)`), out);
        });
        break;
      case 'extract':
        void run('Extracting…', async () => {
          const { exportInWorker } = await import('@folio/pdf-core/export');
          const { created, sources } = await model();
          const pageIds = positions.map((position) => created.pages[position]!.id);
          const { bytes: out } = await exportInWorker({
            model: created,
            sources,
            assets: new Map(),
            pageIds,
          });
          downloadBytes(fileNameFor('pdf', `${baseName} (pages ${rangeLabel(range)})`), out);
        });
        break;
      case 'images':
        if (positions.length > MAX_IMAGE_PAGES) {
          setProblem(`Choose up to ${MAX_IMAGE_PAGES} pages at a time.`);
          return;
        }
        void run(`Drawing page 1 of ${positions.length}…`, async (signal) => {
          const file = await exportPageImages(handle, {
            pages: positions.map((position) => ({ index: position, number: position + 1 })),
            pageCount: count,
            baseName,
            dpi: Number(dpi),
            format,
            signal,
            onProgress: (done, total) => {
              if (done < total) setBusy(`Drawing page ${done + 1} of ${total}…`);
            },
          });
          downloadBytes(fileNameFor(file.kind, file.name), file.bytes, file.kind);
        });
        break;
      case 'text':
        void run('Reading text…', async (signal) => {
          const result = await extractText(handle, {
            pageIndexes: positions,
            signal,
            onProgress: (done, total) => setBusy(`Reading page ${done} of ${total}…`),
          });
          setText(result);
          setCopied(false);
        });
        break;
    }
  };

  const copyText = () => {
    if (text === null) return;
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setProblem('The text could not be copied.'),
    );
  };

  const choose = (next: Tool) => {
    running.current?.abort();
    setTool((current) => (current === next ? null : next));
    setProblem(null);
    setText(null);
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h2 id={`${id}-title`} className="text-sm font-semibold">
        Tools
      </h2>
      <div className="grid grid-cols-2 gap-1.5">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-expanded={tool === entry.id}
            aria-controls={`${id}-panel`}
            onClick={() => choose(entry.id)}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-medium',
              'outline-hidden hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus',
              tool === entry.id
                ? 'border-accent bg-accent-soft text-accent-soft-ink'
                : 'border-line',
            )}
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </div>

      {tool ? (
        <div
          id={`${id}-panel`}
          role="group"
          aria-label={TOOLS.find((entry) => entry.id === tool)?.label}
          className="rounded-md bg-bg p-3"
        >
          {blocked[tool] ? (
            <p className="text-xs text-ink-muted">{blocked[tool]}</p>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                apply();
              }}
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-pages`}>Pages</Label>
                <Input
                  id={`${id}-pages`}
                  value={range}
                  placeholder={`All ${count} pages, or e.g. 1-3, 5`}
                  onChange={(event) => setRange(event.target.value)}
                  aria-invalid={positions === null || undefined}
                  aria-describedby={`${id}-pages-hint`}
                />
                <p id={`${id}-pages-hint`} className="text-2xs text-ink-muted">
                  {positions === null
                    ? `Enter pages like 1-3, 5 (from 1 to ${count}).`
                    : positions.length === count
                      ? `All ${count} ${count === 1 ? 'page' : 'pages'}`
                      : `${positions.length} of ${count} pages`}
                </p>
              </div>
              {tool === 'rotate' ? (
                <SegmentedControl
                  label="Turn"
                  value={rotation}
                  onValueChange={setRotation}
                  options={ROTATIONS}
                />
              ) : null}
              {tool === 'images' ? (
                <>
                  <SegmentedControl
                    label="Format"
                    value={format}
                    onValueChange={setFormat}
                    options={FORMATS}
                  />
                  <SegmentedControl
                    label="Resolution"
                    value={dpi}
                    onValueChange={setDpi}
                    options={RESOLUTIONS}
                  />
                </>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  disabled={!positions || busy !== null}
                >
                  {tool === 'text' ? 'Extract' : 'Download'}
                </Button>
                {busy ? (
                  <>
                    <span
                      role="status"
                      className="flex items-center gap-1.5 text-xs text-ink-muted"
                    >
                      <Spinner /> {busy}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => running.current?.abort()}
                    >
                      Stop
                    </Button>
                  </>
                ) : null}
              </div>
              {tool === 'images' ? (
                <p className="text-2xs text-ink-muted">
                  One page downloads as an image; several download as a ZIP file.
                </p>
              ) : null}
            </form>
          )}
          {problem ? (
            <p role="alert" className="mt-2 text-xs text-danger-ink">
              {problem}
            </p>
          ) : null}
          {tool === 'text' && text !== null ? (
            <div className="mt-3 flex flex-col gap-2">
              {text ? (
                <textarea
                  readOnly
                  aria-label="Extracted text"
                  value={text}
                  rows={10}
                  className="w-full resize-y rounded-md border border-line bg-surface p-2 font-mono text-2xs"
                />
              ) : (
                <p className="text-xs text-ink-muted">
                  No text found. Scanned pages contain pictures of text: open the document in the
                  editor and choose Tools › Recognize text (OCR) to read it.
                </p>
              )}
              {text ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={copyText}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      downloadBytes(
                        fileNameFor('text', `${baseName} (text)`),
                        encoder.encode(text),
                        'text',
                      )
                    }
                  >
                    Download .txt
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
