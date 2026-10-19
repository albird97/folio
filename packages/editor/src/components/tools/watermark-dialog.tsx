import {
  toStandardFontText,
  type FontFamily,
  type HexColor,
  type StampPosition,
  type WatermarkStamp,
} from '@folio/document-model';
import { Input, Label, SegmentedControl } from '@folio/shared-ui';
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

const DEFAULTS: WatermarkStamp = {
  text: 'DRAFT',
  position: 'center',
  fontFamily: 'sans',
  fontSize: 72,
  color: '#e03131',
  opacity: 0.25,
  angle: 45,
  // Over the content shows on every page, scans included.
  layer: 'over',
  margin: 36,
  pages: { from: 1, to: null },
};

const SIZE = { min: 8, max: 300 };
const ANGLE = { min: -90, max: 90 };
const MARGIN = { min: 0, max: 144 };

interface Form {
  text: string;
  position: StampPosition;
  fontFamily: FontFamily;
  fontSize: string;
  color: HexColor;
  /** In percent, from the slider. */
  opacity: number;
  angle: string;
  layer: WatermarkStamp['layer'];
  margin: string;
  pages: PagesForm;
}

const formOf = (stamp: WatermarkStamp, pageCount: number): Form => ({
  text: stamp.text,
  position: stamp.position,
  fontFamily: stamp.fontFamily,
  fontSize: String(stamp.fontSize),
  color: stamp.color,
  opacity: Math.round(stamp.opacity * 100),
  angle: String(stamp.angle),
  layer: stamp.layer,
  margin: String(stamp.margin),
  pages: pagesForm(stamp.pages, pageCount),
});

/** The watermark the form describes, or null while a field is invalid. */
function stampOf(form: Form, pageCount: number): WatermarkStamp | null {
  const fontSize = parseNumber(form.fontSize, SIZE);
  const angle = parseNumber(form.angle, ANGLE);
  const margin = parseNumber(form.margin, MARGIN);
  const pages = parsePages(form.pages, pageCount);
  if (form.text.trim() === '' || fontSize === null || angle === null || margin === null) {
    return null;
  }
  if (!pages) return null;
  return {
    text: form.text,
    position: form.position,
    fontFamily: form.fontFamily,
    fontSize,
    color: form.color,
    opacity: form.opacity / 100,
    angle,
    layer: form.layer,
    margin,
    pages,
  };
}

function WatermarkForm({ doc }: { doc: WorkspaceDocument }) {
  const id = useId();
  const pageCount = doc.editor!.model.pages.length;
  const [initial] = useState(() => doc.editor!.model.stamps.watermark ?? DEFAULTS);
  const [form, setForm] = useState(() => formOf(initial, pageCount));
  const change = (changes: Partial<Form>) => setForm((current) => ({ ...current, ...changes }));
  const draft = useMemo(() => stampOf(form, pageCount), [form, pageCount]);
  const preview = useLastValid(draft, initial);
  const textEmpty = form.text.trim() === '';

  return (
    <StampDialog
      doc={doc}
      kind="watermark"
      title="Watermark"
      description="Text added across the pages, over or under their content, when you save or print. The pages’ own text does not change."
      noun="watermark"
      draft={draft}
      preview={preview}
      previewCaption={(position) => `Page ${position + 1}`}
    >
      <Label htmlFor={`${id}-text`} className={ROW_LABEL}>
        Text
      </Label>
      <div>
        <Input
          id={`${id}-text`}
          maxLength={200}
          value={form.text}
          onChange={(event) => change({ text: event.target.value })}
          aria-invalid={textEmpty || undefined}
          aria-describedby={`${id}-text-hint`}
        />
        <div id={`${id}-text-hint`} className="text-xs">
          {textEmpty ? <p className="mt-1 text-danger-ink">Enter the watermark’s text.</p> : null}
          {toStandardFontText(form.text).lossy ? (
            <p className="mt-1 text-warning-ink">
              Some characters cannot be saved with the standard PDF fonts and will show as “?”.
            </p>
          ) : null}
        </div>
      </div>
      <PositionField
        value={form.position}
        onChange={(position) => change({ position })}
        vertical={['top', 'middle', 'bottom']}
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
      <Label htmlFor={`${id}-opacity`} className={ROW_LABEL}>
        Opacity
      </Label>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-opacity`}
          type="range"
          min={10}
          max={100}
          step={5}
          value={form.opacity}
          onChange={(event) => change({ opacity: Number(event.currentTarget.value) })}
          className="w-full accent-[var(--folio-accent)]"
        />
        <span className="w-10 text-right text-xs tabular text-ink-muted">{form.opacity}%</span>
      </div>
      <NumberField
        label="Angle"
        unit="° counterclockwise"
        {...ANGLE}
        step={5}
        value={form.angle}
        onChange={(angle) => change({ angle })}
        error={parseNumber(form.angle, ANGLE) === null ? 'Enter an angle from −90° to 90°.' : null}
      />
      <span className={ROW_LABEL}>Layer</span>
      <div>
        <SegmentedControl
          label="Layer"
          value={form.layer}
          options={[
            { value: 'over', label: 'Over the content' },
            { value: 'under', label: 'Under the content' },
          ]}
          onValueChange={(layer) => change({ layer })}
        />
        {form.layer === 'under' ? (
          <p className="mt-1 text-xs text-ink-muted">
            Pages that cover their whole area, such as scans, hide it.
          </p>
        ) : null}
      </div>
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
      <PagesField
        value={form.pages}
        onChange={(pages) => change({ pages })}
        pageCount={pageCount}
      />
    </StampDialog>
  );
}

export function WatermarkDialog({ request }: { request: DialogOf<'watermark'> }) {
  const { workspace } = useWorkspaceContext();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  if (!doc?.editor || doc.status !== 'ready') return null;
  return <WatermarkForm doc={doc} />;
}
