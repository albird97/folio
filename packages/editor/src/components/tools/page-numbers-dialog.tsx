import {
  pageNumberText,
  toStandardFontText,
  type FontFamily,
  type HexColor,
  type PageNumberStamp,
  type StampPosition,
} from '@folio/document-model';
import { Input, Label } from '@folio/shared-ui';
import { useId, useMemo, useState } from 'react';
import { useWorkspaceContext } from '../../context';
import type { DialogOf } from '../../store/ui';
import type { WorkspaceDocument } from '../../store/workspace';
import { ColorSwatches } from '../annotation-toolbar';
import {
  FONT_LABELS,
  NumberField,
  PagesField,
  pagesForm,
  parseNumber,
  parsePages,
  PositionField,
  ROW_LABEL,
  SELECT,
  StampDialog,
  useLastValid,
  type PagesForm,
} from './stamp-dialog';

/** Formats offered by example ("Page 1 of 12"); any other text is a custom format. */
const PRESETS = ['{page}', 'Page {page}', 'Page {page} of {total}', '{page} / {total}'];

const DEFAULTS: PageNumberStamp = {
  format: '{page}',
  position: 'bottom-center',
  fontFamily: 'sans',
  fontSize: 10,
  color: '#1f2328',
  margin: 36,
  startNumber: 1,
  pages: { from: 1, to: null },
};

const SIZE = { min: 4, max: 72 };
const MARGIN = { min: 0, max: 144 };
const START = { min: 0, max: 99_999, whole: true };

interface Form {
  /** A preset format, or "custom". */
  preset: string;
  custom: string;
  position: StampPosition;
  fontFamily: FontFamily;
  fontSize: string;
  color: HexColor;
  margin: string;
  startNumber: string;
  pages: PagesForm;
}

const formOf = (stamp: PageNumberStamp, pageCount: number): Form => ({
  preset: PRESETS.includes(stamp.format) ? stamp.format : 'custom',
  custom: stamp.format,
  position: stamp.position,
  fontFamily: stamp.fontFamily,
  fontSize: String(stamp.fontSize),
  color: stamp.color,
  margin: String(stamp.margin),
  startNumber: String(stamp.startNumber),
  pages: pagesForm(stamp.pages, pageCount),
});

/** The page numbers the form describes, or null while a field is invalid. */
function stampOf(form: Form, pageCount: number): PageNumberStamp | null {
  const format = form.preset === 'custom' ? form.custom : form.preset;
  const fontSize = parseNumber(form.fontSize, SIZE);
  const margin = parseNumber(form.margin, MARGIN);
  const startNumber = parseNumber(form.startNumber, START);
  const pages = parsePages(form.pages, pageCount);
  if (format.trim() === '' || fontSize === null || margin === null || startNumber === null) {
    return null;
  }
  if (!pages) return null;
  return {
    format,
    position: form.position,
    fontFamily: form.fontFamily,
    fontSize,
    color: form.color,
    margin,
    startNumber,
    pages,
  };
}

function PageNumbersForm({ doc }: { doc: WorkspaceDocument }) {
  const id = useId();
  const pageCount = doc.editor!.model.pages.length;
  const [initial] = useState(() => doc.editor!.model.stamps.pageNumbers ?? DEFAULTS);
  const [form, setForm] = useState(() => formOf(initial, pageCount));
  const change = (changes: Partial<Form>) => setForm((current) => ({ ...current, ...changes }));
  const draft = useMemo(() => stampOf(form, pageCount), [form, pageCount]);
  const preview = useLastValid(draft, initial);
  const example = (format: string) =>
    pageNumberText({ format, startNumber: 1, pages: { from: 1, to: null } }, 0, pageCount);
  const customEmpty = form.custom.trim() === '';

  return (
    <StampDialog
      doc={doc}
      kind="pageNumbers"
      title="Page numbers"
      description="Numbers are added to the pages as new text when you save or print. The pages’ own text does not change."
      noun="page numbers"
      draft={draft}
      preview={preview}
      previewCaption={(position) => {
        const text = pageNumberText(preview, position, pageCount);
        return text === null
          ? `Page ${position + 1}`
          : `Page ${position + 1} shows “${toStandardFontText(text).text}”`;
      }}
    >
      <Label htmlFor={`${id}-format`} className={ROW_LABEL}>
        Format
      </Label>
      <select
        id={`${id}-format`}
        className={SELECT}
        value={form.preset}
        onChange={(event) => {
          const preset = event.target.value;
          // A custom text starts from the format chosen so far.
          change(
            preset === 'custom' && form.preset !== 'custom'
              ? { preset, custom: form.preset }
              : { preset },
          );
        }}
      >
        {PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {example(preset)}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {form.preset === 'custom' ? (
        <>
          <Label htmlFor={`${id}-custom`} className={ROW_LABEL}>
            Text
          </Label>
          <div>
            <Input
              id={`${id}-custom`}
              maxLength={200}
              value={form.custom}
              onChange={(event) => change({ custom: event.target.value })}
              aria-invalid={customEmpty || undefined}
              aria-describedby={`${id}-custom-hint`}
            />
            <div id={`${id}-custom-hint`} className="mt-1 space-y-1 text-xs">
              {customEmpty ? (
                <p className="text-danger-ink">
                  Enter the text to show, such as Page {'{page}'} of {'{total}'}.
                </p>
              ) : null}
              <p className="text-ink-muted">
                {'{page}'} becomes the page’s number and {'{total}'} the last page’s.
              </p>
              {toStandardFontText(form.custom).lossy ? (
                <p className="text-warning-ink">
                  Some characters cannot be saved with the standard PDF fonts and will show as “?”.
                </p>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
      <PositionField
        value={form.position}
        onChange={(position) => change({ position })}
        vertical={['top', 'bottom']}
      />
      <Label htmlFor={`${id}-font`} className={ROW_LABEL}>
        Font
      </Label>
      <select
        id={`${id}-font`}
        className={SELECT}
        value={form.fontFamily}
        onChange={(event) => change({ fontFamily: event.target.value as FontFamily })}
      >
        {(['sans', 'serif', 'mono'] as const).map((family) => (
          <option key={family} value={family}>
            {FONT_LABELS[family]}
          </option>
        ))}
      </select>
      <NumberField
        label="Size"
        unit="pt"
        {...SIZE}
        value={form.fontSize}
        onChange={(fontSize) => change({ fontSize })}
        error={
          parseNumber(form.fontSize, SIZE) === null
            ? `Enter a size from ${SIZE.min} to ${SIZE.max} points.`
            : null
        }
      />
      <span className={ROW_LABEL}>Colour</span>
      <ColorSwatches
        label="Colour"
        value={form.color}
        onChange={(color) => {
          if (color) change({ color });
        }}
      />
      <NumberField
        label="Margin"
        unit="pt"
        {...MARGIN}
        value={form.margin}
        onChange={(margin) => change({ margin })}
        error={
          parseNumber(form.margin, MARGIN) === null
            ? `Enter a margin from ${MARGIN.min} to ${MARGIN.max} points.`
            : null
        }
      />
      <NumberField
        label="First number"
        min={START.min}
        max={START.max}
        value={form.startNumber}
        onChange={(startNumber) => change({ startNumber })}
        error={
          parseNumber(form.startNumber, START) === null
            ? 'Enter a whole number from 0 to 99,999.'
            : null
        }
      />
      <PagesField
        value={form.pages}
        onChange={(pages) => change({ pages })}
        pageCount={pageCount}
      />
    </StampDialog>
  );
}

export function PageNumbersDialog({ request }: { request: DialogOf<'page-numbers'> }) {
  const { workspace } = useWorkspaceContext();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  if (!doc?.editor || doc.status !== 'ready') return null;
  return <PageNumbersForm doc={doc} />;
}
