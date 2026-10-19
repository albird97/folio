import {
  sourcePageKey,
  type DocumentModel,
  type PageModel,
  type RecognizedTextData,
  type SourceId,
} from '@folio/document-model';
import {
  Banner,
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Spinner,
} from '@folio/shared-ui';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useUi, useWorkspace, useWorkspaceContext } from '../../context';
import { parsePageRange } from '../../format';
import { OCR_LANGUAGES, type OcrLanguage } from '../../ocr/languages';
import {
  recognizePages,
  type PageToRecognize,
  type RecognitionProgress,
} from '../../ocr/recognize';
import { pagesToRecognize, type RecognitionScope } from '../../ocr/selection';
import {
  bundledTesseractPaths,
  createTesseractRecognizer,
  RecognizerError,
} from '../../ocr/tesseract';
import { PERMISSION_MESSAGES } from '../../store/editing';
import type { DialogOf } from '../../store/ui';
import type { WorkspaceStore } from '../../store/workspace';

type Run =
  | { status: 'choosing' }
  | { status: 'running'; progress: RecognitionProgress }
  | { status: 'done'; words: number; pages: number; empty: number; added: boolean }
  | { status: 'failed'; message: string };

const NO_PAGES: readonly PageModel[] = [];

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/**
 * Which source pages have text of their own, read in the background while
 * the dialog is open (as a search would), with a flag once every page is
 * known.
 */
function useOwnText(workspace: WorkspaceStore, key: string, pages: readonly PageModel[]) {
  const [state, setState] = useState<{
    pages: readonly PageModel[];
    known: ReadonlyMap<string, boolean>;
    done: boolean;
  }>({ pages, known: new Map(), done: false });
  useEffect(() => {
    let cancelled = false;
    const known = new Map<string, boolean>();
    void (async () => {
      let shown = performance.now();
      for (const page of pages) {
        if (cancelled) return;
        if (page.source.kind !== 'source') continue;
        const { sourceId, pageIndex } = page.source;
        const id = sourcePageKey(sourceId, pageIndex);
        if (known.has(id)) continue;
        const handle = workspace.getSourceHandle(key, sourceId);
        const text = await handle?.getPageText(pageIndex).catch(() => null);
        known.set(id, text?.items.some((item) => item.str.trim() !== '') ?? false);
        // The counts follow along, without a render for every page.
        if (performance.now() - shown > 150) {
          shown = performance.now();
          if (!cancelled) setState({ pages, known: new Map(known), done: false });
        }
      }
      if (!cancelled) setState({ pages, known, done: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, key, pages]);
  // Pages changed since: nothing is known about them yet.
  return state.pages === pages ? state : { pages, known: new Map<string, boolean>(), done: false };
}

/** What a run of recognition reads, and the source page each result belongs to. */
function targetsOf(workspace: WorkspaceStore, key: string, pages: readonly PageModel[]) {
  const targets: Array<PageToRecognize & { sourceId: SourceId }> = [];
  for (const page of pages) {
    if (page.source.kind !== 'source') continue;
    const handle = workspace.getSourceHandle(key, page.source.sourceId);
    if (!handle) continue;
    targets.push({
      handle,
      sourceId: page.source.sourceId,
      pageIndex: page.source.pageIndex,
      rotation: page.rotation,
    });
  }
  return targets;
}

function Progress({ progress }: { progress: RecognitionProgress }) {
  const reading = progress.stage === 'reading' && progress.done < progress.total;
  return (
    <div className="mt-4 flex flex-col gap-2">
      <p role="status" className="flex items-center gap-2 text-sm">
        <Spinner />
        {reading
          ? `Reading page ${progress.done + 1} of ${progress.total}…`
          : progress.stage === 'starting'
            ? 'Preparing text recognition…'
            : 'Adding the text…'}
      </p>
      <div
        role="progressbar"
        aria-label="Text recognition"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.fraction * 100)}
        className="h-1.5 overflow-hidden rounded-full bg-hover"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${(progress.fraction * 100).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}

function Choices({
  model,
  current,
  scope,
  setScope,
  range,
  setRange,
  rangePositions,
  includeText,
  setIncludeText,
  languages,
  setLanguages,
  withoutText,
}: {
  model: DocumentModel;
  current: number;
  scope: RecognitionScope;
  setScope(scope: RecognitionScope): void;
  range: string;
  setRange(range: string): void;
  rangePositions: number[] | null;
  includeText: boolean;
  setIncludeText(include: boolean): void;
  languages: OcrLanguage[];
  setLanguages(languages: OcrLanguage[]): void;
  /** How many pages have no text (null while that is being found out). */
  withoutText: number | null;
}) {
  const id = useId();
  const count = model.pages.length;
  return (
    <>
      <fieldset className="mt-4 space-y-2 text-sm">
        <legend className="mb-1 text-xs font-semibold">Pages</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === 'without-text'}
            onChange={() => setScope('without-text')}
          />
          Pages without text
          <span className="text-ink-muted">
            {withoutText === null
              ? '(checking…)'
              : `(${withoutText === 0 ? 'none' : withoutText.toLocaleString()})`}
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === 'current'}
            onChange={() => setScope('current')}
          />
          Current page ({current + 1})
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === 'range'}
            onChange={() => setScope('range')}
          />
          Pages
          <Input
            aria-label="Pages to recognize"
            className="h-7 w-40"
            value={range}
            onFocus={() => setScope('range')}
            onChange={(event) => setRange(event.target.value)}
            aria-invalid={(scope === 'range' && !rangePositions) || undefined}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === 'all'}
            onChange={() => setScope('all')}
          />
          {count === 1 ? 'The page' : `All ${count.toLocaleString()} pages`}
        </label>
      </fieldset>
      <label
        className={
          scope === 'without-text'
            ? 'mt-3 flex items-center gap-2 text-sm opacity-45'
            : 'mt-3 flex items-center gap-2 text-sm'
        }
      >
        <input
          type="checkbox"
          disabled={scope === 'without-text'}
          checked={includeText && scope !== 'without-text'}
          onChange={(event) => setIncludeText(event.target.checked)}
        />
        Include pages that already have text
      </label>
      {scope === 'range' && !rangePositions ? (
        <p role="alert" className="mt-2 text-xs text-danger-ink">
          Enter pages like 1-3, 5 (from 1 to {count}).
        </p>
      ) : null}
      <fieldset className="mt-4 text-sm">
        <legend className="mb-1 text-xs font-semibold">Languages</legend>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {OCR_LANGUAGES.map((language) => (
            <label key={language.code} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={languages.includes(language.code)}
                onChange={(event) =>
                  setLanguages(
                    event.target.checked
                      ? OCR_LANGUAGES.map((entry) => entry.code).filter(
                          (code) => code === language.code || languages.includes(code),
                        )
                      : languages.filter((code) => code !== language.code),
                  )
                }
              />
              {language.label}
            </label>
          ))}
        </div>
      </fieldset>
      {languages.length === 0 ? (
        <p role="alert" className="mt-2 text-xs text-danger-ink">
          Choose at least one language.
        </p>
      ) : null}
    </>
  );
}

/**
 * Recognize text (OCR): reads the text in the images of pages on this device
 * and adds it to the document as one change, so it can be searched, selected
 * and copied, and is saved as invisible text. Closing the dialog while it
 * reads stops it, and nothing changes.
 */
export function RecognizeTextDialog({ request }: { request: DialogOf<'recognize-text'> }) {
  const { workspace, ui } = useWorkspaceContext();
  const key = request.docKey;
  const id = useId();
  const doc = useWorkspace(
    (state) => state.documents.find((entry) => entry.key === key && entry.editor) ?? null,
  );
  const model = doc?.editor?.model ?? null;
  const pages = model?.pages ?? NO_PAGES;
  const current = Math.max(
    0,
    pages.findIndex((page) => page.id === doc?.view?.currentPageId),
  );
  const [scope, setScope] = useState<RecognitionScope>('without-text');
  const [range, setRange] = useState(`1-${pages.length}`);
  const [includeText, setIncludeText] = useState(false);
  const [languages, setLanguages] = useState<OcrLanguage[]>(() => ui.getState().ocrLanguages);
  const [run, setRun] = useState<Run>({ status: 'choosing' });
  const ownText = useOwnText(workspace, key, pages);
  const reading = useRef<AbortController | null>(null);
  const closeDialog = useUi((state) => state.closeDialog);

  // Closing the dialog stops recognition; a document closed meanwhile closes it.
  useEffect(() => () => reading.current?.abort(), []);
  useEffect(() => {
    if (!doc) closeDialog();
  }, [doc, closeDialog]);
  if (!doc || !model) return null;

  const rangePositions = parsePageRange(range, pages.length);
  const positions = scope === 'current' ? [current] : (rangePositions ?? []);
  const hasOwnText = (pageKey: string) => ownText.known.get(pageKey);
  const chosen = pagesToRecognize(
    model,
    { scope, positions, includePagesWithText: includeText },
    hasOwnText,
  );
  const withoutText = ownText.done
    ? pagesToRecognize(
        model,
        { scope: 'without-text', positions: [], includePagesWithText: false },
        hasOwnText,
      ).pages.length
    : null;
  const allowed = doc.permissions.modify;
  const ready =
    allowed &&
    languages.length > 0 &&
    !chosen.unknown &&
    chosen.pages.length > 0 &&
    !(scope === 'range' && !rangePositions);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    ui.getState().setOcrLanguages(languages);
    const controller = new AbortController();
    reading.current = controller;
    const targets = targetsOf(workspace, key, chosen.pages);
    setRun({
      status: 'running',
      progress: { done: 0, total: targets.length, stage: 'starting', fraction: 0 },
    });
    try {
      const results = await recognizePages(targets, {
        languages,
        createRecognizer: (onProgress) =>
          createTesseractRecognizer(languages, bundledTesseractPaths(), onProgress),
        onProgress: (progress) => {
          if (!controller.signal.aborted) setRun({ status: 'running', progress });
        },
        signal: controller.signal,
      });
      const found: Array<{ sourceId: SourceId; pageIndex: number; data: RecognizedTextData }> = [];
      results.forEach((data, index) => {
        const target = targets[index]!;
        if (data) found.push({ sourceId: target.sourceId, pageIndex: target.pageIndex, data });
      });
      const added = found.length > 0 && (await workspace.getState().addRecognizedText(key, found));
      if (controller.signal.aborted) return;
      setRun({
        status: 'done',
        words: found.reduce((total, entry) => total + entry.data.words.length, 0),
        pages: found.length,
        empty: results.length - found.length,
        added,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setRun({
        status: 'failed',
        message: error instanceof RecognizerError ? error.message : 'Text recognition failed.',
      });
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  };

  const summary =
    run.status !== 'done'
      ? null
      : run.pages === 0
        ? 'No text was found. Check that the right languages are chosen and that the pages show their text upright.'
        : !run.added
          ? 'The text could not be added to the document.'
          : `Found ${plural(run.words, 'word', 'words')} on ${plural(run.pages, 'page', 'pages')}.${
              run.empty > 0
                ? ` No text was found on ${plural(run.empty, 'other page', 'other pages')}.`
                : ''
            }`;

  return (
    <DialogContent aria-describedby={`${id}-description`}>
      <form onSubmit={(event) => void start(event)}>
        <DialogTitle>Recognize text</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Reads the text in pictures of pages, such as scans, so you can search, select and copy it.
          Saving adds it to the pages as invisible text. Recognition runs on this device; nothing is
          uploaded.
        </DialogDescription>
        {!allowed ? (
          <Banner tone="warning" title={PERMISSION_MESSAGES.modify} className="mt-4" />
        ) : null}
        {run.status === 'choosing' ? (
          <>
            <Choices
              model={model}
              current={current}
              scope={scope}
              setScope={setScope}
              range={range}
              setRange={setRange}
              rangePositions={rangePositions}
              includeText={includeText}
              setIncludeText={setIncludeText}
              languages={languages}
              setLanguages={setLanguages}
              withoutText={withoutText}
            />
            <p role="status" className="mt-3 text-xs text-ink-muted">
              {chosen.unknown
                ? 'Checking which pages have text…'
                : chosen.pages.length > 0
                  ? `Reads ${plural(chosen.pages.length, 'page', 'pages')}.`
                  : scope === 'without-text'
                    ? 'Every page has text already. To read pages anyway, choose them and include pages that already have text.'
                    : scope === 'range' && !rangePositions
                      ? ''
                      : 'These pages have text already. Include pages that already have text to read them anyway.'}
            </p>
          </>
        ) : run.status === 'running' ? (
          <Progress progress={run.progress} />
        ) : run.status === 'done' ? (
          <p role="status" className="mt-4 text-sm">
            {summary}
          </p>
        ) : (
          <Banner tone="danger" title={run.message} className="mt-4">
            Try again, or with fewer pages or languages.
          </Banner>
        )}
        <DialogFooter>
          {run.status === 'choosing' ? (
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={!ready}>
                Recognize text
              </Button>
            </>
          ) : run.status === 'running' ? (
            <DialogClose asChild>
              <Button autoFocus>Cancel</Button>
            </DialogClose>
          ) : run.status === 'done' ? (
            <DialogClose asChild>
              <Button variant="primary" autoFocus>
                Done
              </Button>
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
