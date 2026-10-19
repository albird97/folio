import {
  pageStamps,
  stampedRange,
  type DocumentStamps,
  type FontFamily,
  type StampPageRange,
  type StampPosition,
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
  Label,
  SegmentedControl,
} from '@folio/shared-ui';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useWorkspaceContext } from '../../context';
import { PERMISSION_MESSAGES } from '../../store/editing';
import type { WorkspaceDocument } from '../../store/workspace';
import { displaySize, pageSource } from '../../viewer/geometry';
import { PRIORITY, renderCacheKey } from '../../viewer/resources';
import { StampMarks } from '../../viewer/stamp-layer';
import { ThumbnailView } from '../../viewer/thumbnail-view';
import { useDevicePixelRatio } from '../../viewer/use-device-pixel-ratio';

/*
 * What the page numbers and watermark dialogs share. Fields keep what was
 * typed; it is checked, with a message per field, before it reaches the
 * document.
 */

export const SELECT =
  'h-8 w-full rounded-md bg-raised px-2 text-sm text-ink shadow-[inset_0_0_0_1px_var(--folio-border-strong)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--folio-focus)] focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus/35';

/** A label in the form's left column. */
export const ROW_LABEL = 'text-xs font-medium text-ink-muted';

/** The number typed in a field, or null when it is not one within the limits. */
export function parseNumber(
  text: string,
  { min, max, whole = false }: { min: number; max: number; whole?: boolean },
): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  if (whole && !Number.isInteger(value)) return null;
  return value;
}

/**
 * The value last seen valid, so a preview keeps showing while a field is
 * retyped. Values are compared by content: an equal value (even a new object)
 * changes nothing, so rendering settles.
 */
export function useLastValid<T>(value: T | null, initial: T): T {
  const [last, setLast] = useState(initial);
  if (value !== null && JSON.stringify(value) !== JSON.stringify(last)) setLast(value);
  return value ?? last;
}

export const FONT_LABELS: Record<FontFamily, string> = {
  sans: 'Sans serif',
  serif: 'Serif',
  mono: 'Monospace',
};

/** A number field with its unit and, when what was typed is not allowed, why. */
export function NumberField({
  label,
  value,
  onChange,
  unit,
  error,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  unit?: string;
  /** Shown when the value is invalid. */
  error: string | null;
  min: number;
  max: number;
  step?: number;
}) {
  const id = useId();
  return (
    <>
      <Label htmlFor={id} className={ROW_LABEL}>
        {label}
      </Label>
      <div>
        <div className="flex items-center gap-1.5">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            className="w-20"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          {unit ? <span className="text-xs text-ink-muted">{unit}</span> : null}
        </div>
        {error ? (
          <p id={`${id}-error`} className="mt-1 text-xs text-danger-ink">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

type Vertical = 'top' | 'middle' | 'bottom';
type Horizontal = 'left' | 'center' | 'right';

const partsOf = (position: StampPosition): [Vertical, Horizontal] =>
  position === 'center' ? ['middle', 'center'] : (position.split('-') as [Vertical, Horizontal]);

const positionOf = (vertical: Vertical, horizontal: Horizontal): StampPosition =>
  vertical === 'middle'
    ? horizontal === 'center'
      ? 'center'
      : `middle-${horizontal}`
    : `${vertical}-${horizontal}`;

const VERTICAL_LABELS: Record<Vertical, string> = {
  top: 'Top',
  middle: 'Middle',
  bottom: 'Bottom',
};

/** Where on the page, as it is shown: an edge (or the middle), and a side (or the centre). */
export function PositionField({
  value,
  onChange,
  vertical,
}: {
  value: StampPosition;
  onChange(position: StampPosition): void;
  vertical: readonly Vertical[];
}) {
  const [up, across] = partsOf(value);
  return (
    <>
      <span className={ROW_LABEL}>Position</span>
      <div className="flex flex-wrap gap-2">
        <SegmentedControl
          label="Vertical position"
          value={up}
          options={vertical.map((option) => ({ value: option, label: VERTICAL_LABELS[option] }))}
          onValueChange={(next) => onChange(positionOf(next, across))}
        />
        <SegmentedControl
          label="Horizontal position"
          value={across}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
          onValueChange={(next) => onChange(positionOf(up, next))}
        />
      </div>
    </>
  );
}

export interface PagesForm {
  all: boolean;
  from: string;
  to: string;
}

export const pagesForm = (pages: StampPageRange, pageCount: number): PagesForm => ({
  all: pages.from <= 1 && pages.to === null,
  from: String(pages.from),
  to: String(pages.to ?? pageCount),
});

/** The pages chosen: all of them (including pages added later), or a fixed range. */
export function parsePages(form: PagesForm, pageCount: number): StampPageRange | null {
  if (form.all) return { from: 1, to: null };
  const from = parseNumber(form.from, { min: 1, max: pageCount, whole: true });
  const to = parseNumber(form.to, { min: 1, max: pageCount, whole: true });
  return from !== null && to !== null && from <= to ? { from, to } : null;
}

export function PagesField({
  value,
  onChange,
  pageCount,
}: {
  value: PagesForm;
  onChange(value: PagesForm): void;
  pageCount: number;
}) {
  const id = useId();
  const invalid = parsePages(value, pageCount) === null;
  return (
    <>
      <span id={`${id}-label`} className={ROW_LABEL}>
        Pages
      </span>
      <div role="group" aria-labelledby={`${id}-label`} className="space-y-1.5 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-pages`}
            checked={value.all}
            onChange={() => onChange({ ...value, all: true })}
          />
          All pages
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-pages`}
              checked={!value.all}
              onChange={() => onChange({ ...value, all: false })}
            />
            From
          </label>
          {/* Typing a page chooses a range; focus alone does not, as Tab passes through. */}
          <Input
            type="number"
            min={1}
            max={pageCount}
            aria-label="First page"
            className="h-7 w-16"
            value={value.from}
            onChange={(event) => onChange({ ...value, all: false, from: event.target.value })}
            aria-invalid={(!value.all && invalid) || undefined}
            aria-describedby={!value.all && invalid ? `${id}-error` : undefined}
          />
          to
          <Input
            type="number"
            min={1}
            max={pageCount}
            aria-label="Last page"
            className="h-7 w-16"
            value={value.to}
            onChange={(event) => onChange({ ...value, all: false, to: event.target.value })}
            aria-invalid={(!value.all && invalid) || undefined}
            aria-describedby={!value.all && invalid ? `${id}-error` : undefined}
          />
        </div>
        {!value.all && invalid ? (
          <p id={`${id}-error`} className="text-xs text-danger-ink">
            Enter pages from 1 to {pageCount}, the first no later than the last.
          </p>
        ) : null}
      </div>
    </>
  );
}

const PREVIEW = { width: 168, height: 216 };

/**
 * One page with `stamps` drawn over it, as it will be saved: the current
 * page when the stamp covers it, otherwise the first page it covers.
 */
function StampPreview({
  doc,
  stamps,
  range,
  caption,
}: {
  doc: WorkspaceDocument;
  stamps: DocumentStamps;
  range: StampPageRange;
  caption(position: number): ReactNode;
}) {
  const { workspace } = useWorkspaceContext();
  const ratio = useDevicePixelRatio();
  const pages = doc.editor!.model.pages;
  const current = Math.max(
    0,
    pages.findIndex((page) => page.id === doc.view?.currentPageId),
  );
  const covered = stampedRange(range, pages.length);
  const position =
    !covered || (current >= covered.first && current <= covered.last) ? current : covered.first;
  const page = pages[position]!;
  const source = pageSource(page);
  const size = displaySize(page, 0);
  const scale = Math.min(PREVIEW.width / size.width, PREVIEW.height / size.height);
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  return (
    <figure className="flex flex-col items-center gap-2">
      <div
        aria-hidden
        className="relative overflow-hidden bg-page shadow-page"
        style={{ width, height }}
      >
        <ThumbnailView
          cacheKey={renderCacheKey(doc.key, source?.sourceId ?? 'blank')}
          handle={source ? workspace.getSourceHandle(doc.key, source.sourceId) : null}
          sourceIndex={source?.pageIndex ?? 0}
          rotation={page.rotation}
          width={width}
          height={height}
          scale={scale}
          ratio={ratio}
          priority={PRIORITY.visiblePage}
        />
        <StampMarks
          page={page}
          viewRotation={0}
          stamps={pageStamps(page, stamps, position, pages.length)}
          className="absolute inset-0 size-full"
        />
      </div>
      <figcaption className="max-w-[168px] text-center text-xs text-ink-muted">
        {caption(position)}
      </figcaption>
    </figure>
  );
}

/**
 * The frame of a stamp dialog: what it is, the fields next to a preview,
 * and Remove (when the document has one), Cancel and Apply. Apply and Remove
 * change the document through its history, so both can be undone.
 */
export function StampDialog<K extends keyof DocumentStamps>({
  doc,
  kind,
  title,
  description,
  noun,
  draft,
  preview,
  previewCaption,
  children,
}: {
  doc: WorkspaceDocument;
  kind: K;
  title: string;
  description: string;
  /** "page numbers" or "watermark", for the history ("Add page numbers"). */
  noun: string;
  /** The settings as typed, or null while a field is invalid. */
  draft: DocumentStamps[K];
  /** The settings the preview shows. */
  preview: NonNullable<DocumentStamps[K]>;
  previewCaption(position: number): ReactNode;
  children: ReactNode;
}) {
  const { workspace, ui } = useWorkspaceContext();
  const id = useId();
  const model = doc.editor!.model;
  const existing = model.stamps[kind];
  const editable = doc.permissions.modify;
  const [initial] = useState(() => JSON.stringify(draft));
  const close = () => ui.getState().closeDialog();
  const set = (value: DocumentStamps[K], label: string) => {
    const stamps: Partial<DocumentStamps> = { [kind]: value };
    if (workspace.getState().setStamps(doc.key, stamps, label)) close();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !editable) return;
    // Nothing changed: leave the history alone.
    if (existing && JSON.stringify(draft) === initial) close();
    else set(draft, `${existing ? 'Change' : 'Add'} ${noun}`);
  };

  return (
    <DialogContent
      aria-describedby={`${id}-description`}
      className="max-h-[calc(100vh-2rem)] w-[min(44rem,calc(100vw-2rem))] overflow-y-auto"
    >
      {/*
        The fields are checked here, with a message beside each; the browser's
        own checks would also refuse values allowed here (10.5 pt, an angle
        between the spin buttons' steps).
      */}
      <form noValidate onSubmit={onSubmit}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription id={`${id}-description`}>{description}</DialogDescription>
        {!editable ? (
          <Banner tone="warning" className="mt-4" title={PERMISSION_MESSAGES.modify} />
        ) : null}
        <div className="mt-4 grid gap-5 sm:grid-cols-[1fr_auto]">
          {/* A fieldset, so a document that does not allow changes disables every field at once. */}
          <fieldset
            disabled={!editable}
            className="grid grid-cols-[6.5rem_1fr] content-start items-center gap-x-3 gap-y-3"
          >
            {children}
          </fieldset>
          <StampPreview
            doc={doc}
            stamps={{ ...model.stamps, [kind]: preview }}
            range={preview.pages}
            caption={previewCaption}
          />
        </div>
        <DialogFooter>
          {existing ? (
            <Button
              className="mr-auto"
              disabled={!editable}
              onClick={() => set(null as DocumentStamps[K], `Remove ${noun}`)}
            >
              Remove {noun}
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={!draft || !editable}>
            Apply
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
