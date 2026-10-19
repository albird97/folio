import {
  toStandardFontText,
  type Annotation,
  type AnnotationId,
  type FontFamily,
} from '@folio/document-model';
import { Button, ICON, Label } from '@folio/shared-ui';
import { Trash2 } from 'lucide-react';
import { useId } from 'react';
import { useWorkspaceContext } from '../context';
import { formatDate } from '../format';
import type { WorkspaceDocument } from '../store/workspace';
import { FONT_STACKS } from '../viewer/annotation-shapes';
import { ColorSwatches } from './annotation-toolbar';
import { AnnotationIcon, annotationLabel } from './comments-panel';

const FIELD =
  'w-full rounded-md bg-raised px-2 py-1.5 text-xs text-ink shadow-[inset_0_0_0_1px_var(--folio-border-strong)] outline-hidden focus-visible:shadow-[inset_0_0_0_2px_var(--folio-focus)]';

/** Settings of the selected annotations: colour, opacity, line, font and text. */
export function AnnotationInspector({ doc }: { doc: WorkspaceDocument }) {
  const { workspace } = useWorkspaceContext();
  const ids = useId();
  const model = doc.editor?.model;
  const selected = (doc.selection.annotations as AnnotationId[])
    .map((id) => model?.annotations[id])
    .filter((annotation): annotation is Annotation => annotation !== undefined);
  if (!model || selected.length === 0) return null;
  const editable = doc.permissions.annotate;
  const first = selected[0]!;
  const key = selected.map((annotation) => annotation.id).join(',');
  const update = (change: (annotation: Annotation) => Annotation, label: string, aspect: string) =>
    workspace.getState().updateAnnotations(doc.key, selected.map(change), {
      label,
      coalesceKey: `${aspect}:${key}`,
    });
  const stroked = selected.every(
    (annotation) => annotation.kind === 'ink' || annotation.kind === 'shape',
  );
  const fillable = selected.every(
    (annotation) =>
      annotation.kind === 'shape' &&
      (annotation.shape === 'rectangle' || annotation.shape === 'ellipse'),
  );
  const title = selected.length === 1 ? annotationLabel(first) : `${selected.length} comments`;
  const lossy =
    first.kind === 'added-text' && selected.length === 1 && toStandardFontText(first.text).lossy;

  return (
    <section aria-label="Selected comment" className="border-b border-line px-4 py-3">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold">
        {selected.length === 1 ? (
          <span style={{ color: first.color === '#ffffff' ? undefined : first.color }}>
            <AnnotationIcon annotation={first} />
          </span>
        ) : null}
        {title}
      </h2>
      <fieldset disabled={!editable} className="space-y-3">
        {selected.some(
          (annotation) => annotation.kind !== 'added-image' && annotation.kind !== 'signature',
        ) ? (
          <div>
            <p className="mb-1.5 text-xs text-ink-muted">Colour</p>
            <ColorSwatches
              label="Colour"
              value={
                selected.every((annotation) => annotation.color === first.color)
                  ? first.color
                  : null
              }
              onChange={(color) => {
                if (color)
                  update((annotation) => ({ ...annotation, color }), 'Change colour', 'color');
              }}
            />
          </div>
        ) : null}
        {fillable ? (
          <div>
            <p className="mb-1.5 text-xs text-ink-muted">Fill</p>
            <ColorSwatches
              label="Fill"
              allowNone
              value={first.kind === 'shape' ? first.fill : null}
              onChange={(fill) =>
                update(
                  (annotation) =>
                    annotation.kind === 'shape' ? { ...annotation, fill } : annotation,
                  'Change fill',
                  'fill',
                )
              }
            />
          </div>
        ) : null}
        <div>
          <Label
            htmlFor={`${ids}-opacity`}
            className="mb-1 flex justify-between text-xs text-ink-muted"
          >
            <span>Opacity</span>
            <span className="tabular">{Math.round(first.opacity * 100)}%</span>
          </Label>
          <input
            id={`${ids}-opacity`}
            type="range"
            min={10}
            max={100}
            step={5}
            value={Math.round(first.opacity * 100)}
            onChange={(event) => {
              const opacity = Number(event.currentTarget.value) / 100;
              update((annotation) => ({ ...annotation, opacity }), 'Change opacity', 'opacity');
            }}
            className="w-full accent-[var(--folio-accent)]"
          />
        </div>
        {stroked ? (
          <div>
            <Label htmlFor={`${ids}-stroke`} className="mb-1 block text-xs text-ink-muted">
              Line width
            </Label>
            <select
              id={`${ids}-stroke`}
              className={FIELD}
              value={first.kind === 'ink' || first.kind === 'shape' ? first.strokeWidth : 2}
              onChange={(event) => {
                const strokeWidth = Number(event.currentTarget.value);
                update(
                  (annotation) =>
                    annotation.kind === 'ink' || annotation.kind === 'shape'
                      ? { ...annotation, strokeWidth }
                      : annotation,
                  'Change line width',
                  'stroke',
                );
              }}
            >
              {[0.5, 1, 2, 3, 5, 8, 12].map((width) => (
                <option key={width} value={width}>
                  {width} pt
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {selected.length === 1 && first.kind === 'added-text' ? (
          <>
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <div>
                <Label htmlFor={`${ids}-font`} className="mb-1 block text-xs text-ink-muted">
                  Font
                </Label>
                <select
                  id={`${ids}-font`}
                  className={FIELD}
                  value={first.fontFamily}
                  onChange={(event) => {
                    const fontFamily = event.currentTarget.value as FontFamily;
                    update(
                      (annotation) =>
                        annotation.kind === 'added-text'
                          ? { ...annotation, fontFamily }
                          : annotation,
                      'Change font',
                      'font',
                    );
                  }}
                >
                  <option value="sans">Sans serif</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Monospace</option>
                </select>
              </div>
              <div>
                <Label htmlFor={`${ids}-size`} className="mb-1 block text-xs text-ink-muted">
                  Size
                </Label>
                <input
                  id={`${ids}-size`}
                  type="number"
                  min={4}
                  max={144}
                  className={FIELD}
                  value={first.fontSize}
                  onChange={(event) => {
                    const fontSize = Number(event.currentTarget.value);
                    if (!Number.isFinite(fontSize) || fontSize < 4 || fontSize > 144) return;
                    update(
                      (annotation) =>
                        annotation.kind === 'added-text' ? { ...annotation, fontSize } : annotation,
                      'Change font size',
                      'size',
                    );
                  }}
                />
              </div>
            </div>
            <div>
              <Label htmlFor={`${ids}-text`} className="mb-1 block text-xs text-ink-muted">
                Text
              </Label>
              <textarea
                id={`${ids}-text`}
                rows={4}
                className={`${FIELD} resize-y`}
                style={{ fontFamily: FONT_STACKS[first.fontFamily] }}
                value={first.text}
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  update(
                    (annotation) =>
                      annotation.kind === 'added-text' ? { ...annotation, text } : annotation,
                    'Edit text',
                    'text',
                  );
                }}
              />
              <p className="mt-1 text-2xs text-ink-muted">
                Added text is new content on top of the page; the page’s own text is unchanged.
              </p>
              {lossy ? (
                <p role="status" className="mt-1 text-2xs text-warning-ink">
                  Some characters cannot be saved with the standard PDF fonts and will show as “?”.
                </p>
              ) : null}
            </div>
          </>
        ) : null}
        {selected.length === 1 && first.kind === 'note' ? (
          <div>
            <Label htmlFor={`${ids}-note`} className="mb-1 block text-xs text-ink-muted">
              Note
            </Label>
            <textarea
              id={`${ids}-note`}
              rows={5}
              className={`${FIELD} resize-y`}
              value={first.contents}
              onChange={(event) => {
                const contents = event.currentTarget.value;
                update(
                  (annotation) =>
                    annotation.kind === 'note' ? { ...annotation, contents } : annotation,
                  'Edit note',
                  'contents',
                );
              }}
            />
          </div>
        ) : null}
        {selected.length === 1 &&
        (first.kind === 'highlight' || first.kind === 'underline' || first.kind === 'strikeout') &&
        first.text ? (
          <blockquote className="border-l-2 border-line-strong pl-2 text-xs text-ink-muted">
            {first.text}
          </blockquote>
        ) : null}
      </fieldset>
      {selected.length === 1 ? (
        <p className="mt-3 text-2xs text-ink-subtle">
          {[first.author, `Changed ${formatDate(first.modifiedAt)}`].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        disabled={!editable}
        onClick={() =>
          workspace.getState().deleteAnnotations(
            doc.key,
            selected.map((annotation) => annotation.id),
          )
        }
      >
        <Trash2 size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
        Delete
      </Button>
    </section>
  );
}
