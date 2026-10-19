import {
  primarySource,
  type FormField,
  type FormFieldId,
  type FormFieldValue,
  type Matrix,
  type Rect,
} from '@folio/document-model';
import type { FormWidget, PdfDocumentHandle } from '@folio/pdf-core';
import { cn, ICON } from '@folio/shared-ui';
import { Signature } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useUi, useWorkspaceContext } from '../context';
import { fieldLabel } from '../store/editing';
import { displayRotation, displaySpaceSize, mapRect, pageToDisplay } from './geometry';
import type { PageOverlayProps } from './page-overlays';

/** Typing reaches the document (its pages, history and recovery) once it pauses this long. */
const TYPING_COMMIT_MS = 300;
/** Line height PDF.js gives field text, in font sizes. */
const LINE_FACTOR = 1.35;

type TextWidget = Extract<FormWidget, { type: 'text' }>;
type RadioWidget = Extract<FormWidget, { type: 'radio' }>;

/**
 * What was typed into password fields, while their document is open. The
 * PDF standard asks readers never to store these values, so Folio keeps
 * them out of the document: they are not saved, printed, undone or kept
 * for crash recovery.
 */
const passwords = new WeakMap<PdfDocumentHandle, Map<string, string>>();

function typedPasswords(handle: PdfDocumentHandle): Map<string, string> {
  let typed = passwords.get(handle);
  if (!typed) passwords.set(handle, (typed = new Map()));
  return typed;
}

/**
 * Controls lie over the fields drawn on the page. Text stays invisible
 * until a control has focus: the page shows each value as it is saved.
 */
const CONTROL =
  'absolute m-0 box-border rounded-none border-0 bg-transparent p-0 text-transparent [font-family:Helvetica,Arial,sans-serif]';
/** Typing shows on white, in the field's colour. */
const TYPING =
  'focus:bg-white focus:text-[color:var(--field-color)] focus:outline-2 focus:outline-focus';
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus';
/** The tint of fields that can be filled in, over white pages in both themes. */
const TINT = 'bg-[oklch(0.62_0.11_210/0.13)] hover:bg-[oklch(0.62_0.11_210/0.22)]';

interface Placement {
  /** Screen pixels per page unit. */
  ppu: number;
  toDisplay: Matrix;
  /** How far the page is turned on screen, clockwise. */
  turned: number;
}

/** A widget's box on screen, in pixels of the layer. */
function frame({ ppu, toDisplay }: Placement, rect: Rect): CSSProperties {
  const shown = mapRect(toDisplay, rect);
  return {
    left: shown.x * ppu,
    top: shown.y * ppu,
    width: shown.width * ppu,
    height: shown.height * ppu,
  };
}

/** A box for text that reads the way the field's own text does (turned with its page and /R). */
function textFrame(placement: Placement, widget: FormWidget): CSSProperties {
  const { ppu, toDisplay, turned } = placement;
  const shown = mapRect(toDisplay, widget.rect);
  const turn = (turned - widget.rotation + 360) % 360;
  const sideways = turn % 180 !== 0;
  const width = (sideways ? shown.height : shown.width) * ppu;
  const height = (sideways ? shown.width : shown.height) * ppu;
  return {
    left: (shown.x + shown.width / 2) * ppu - width / 2,
    top: (shown.y + shown.height / 2) * ppu - height / 2,
    width,
    height,
    transform: turn ? `rotate(${turn}deg)` : undefined,
  };
}

/** Text size on screen: the field's own, or fitted to it as PDF.js draws fields without one. */
function fontSize(widget: Extract<FormWidget, { type: 'text' | 'choice' }>, ppu: number): number {
  const across = widget.rotation % 180 === 0 ? widget.rect.height : widget.rect.width;
  const fit = Math.max(1, (across - 2) / LINE_FACTOR);
  const lines = widget.type === 'choice' ? !widget.combo : widget.multiLine;
  const size = widget.fontSize || (lines ? 10 : fit);
  return (lines ? size : Math.min(size, fit)) * ppu;
}

/** Fills in the field, as one undo step per field while typing ("Fill in <label>"). */
function useFill(docKey: string, fieldId: FormFieldId, label: string) {
  const { workspace } = useWorkspaceContext();
  return useCallback(
    (value: FormFieldValue) => workspace.getState().fillFormField(docKey, fieldId, value, label),
    [workspace, docKey, fieldId, label],
  );
}

interface ControlProps<W extends FormWidget> {
  docKey: string;
  widget: W;
  field: FormField;
  label: string;
  /** The value can be changed (the field is not read-only and the document allows it). */
  editable: boolean;
  tinted: boolean;
  placement: Placement;
}

function TextControl({
  docKey,
  widget,
  field,
  label,
  editable,
  tinted,
  placement,
}: ControlProps<TextWidget>) {
  const fill = useFill(docKey, field.id, label);
  const value = typeof field.value === 'string' ? field.value : '';
  /** What is being typed, while the field has focus. */
  const [draft, setDraft] = useState<string | null>(null);
  const typing = useRef<{
    atFocus: string;
    unsaved: string | null;
    timer?: ReturnType<typeof setTimeout>;
  }>({ atFocus: '', unsaved: null });

  const commit = () => {
    const state = typing.current;
    clearTimeout(state.timer);
    if (state.unsaved === null) return;
    const next = state.unsaved;
    state.unsaved = null;
    fill(next);
  };
  // Typing is never lost, even when the page scrolls away before it is committed.
  useEffect(() => {
    const state = typing.current;
    return () => {
      clearTimeout(state.timer);
      if (state.unsaved !== null) fill(state.unsaved);
      state.unsaved = null;
    };
  }, [fill]);

  const type = (next: string) => {
    const state = typing.current;
    setDraft(next);
    state.unsaved = next;
    clearTimeout(state.timer);
    state.timer = setTimeout(commit, TYPING_COMMIT_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!editable) return;
    if (event.key === 'Escape') {
      // Back to the value the field had when it got focus.
      event.preventDefault();
      type(typing.current.atFocus);
      commit();
    } else if (event.key === 'Enter' && (!widget.multiLine || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    }
  };

  const { ppu } = placement;
  const style: CSSProperties = {
    ...textFrame(placement, widget),
    fontSize: fontSize(widget, ppu),
    lineHeight: widget.multiLine ? LINE_FACTOR : undefined,
    textAlign: widget.alignment,
    padding: `0 ${2 * ppu}px`,
    ['--field-color' as string]: widget.color,
  };
  if (widget.comb && widget.maxLength) {
    // One character per cell, as the page draws them. The spacing after the
    // last one fills the field exactly, so the text never scrolls.
    const width = widget.rotation % 180 === 0 ? widget.rect.width : widget.rect.height;
    const cell = (width * ppu) / widget.maxLength;
    Object.assign(style, {
      fontFamily: 'monospace',
      letterSpacing: `calc(${cell}px - 1ch - ${1 / widget.maxLength}px)`,
      padding: 0,
    });
  }
  const props = {
    'aria-label': label,
    readOnly: !editable,
    value: draft ?? value,
    maxLength: widget.maxLength ?? undefined,
    className: cn(
      CONTROL,
      editable ? TYPING : FOCUS_RING,
      tinted && TINT,
      widget.multiLine && 'resize-none',
    ),
    style,
    onFocus: () => {
      typing.current.atFocus = value;
      if (editable) setDraft(value);
    },
    onBlur: () => {
      commit();
      setDraft(null);
    },
    onKeyDown,
  };
  return widget.multiLine ? (
    <textarea {...props} onChange={(event) => editable && type(event.currentTarget.value)} />
  ) : (
    <input
      {...props}
      type="text"
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => editable && type(event.currentTarget.value)}
    />
  );
}

/**
 * A password field: typing shows as dots and stays in memory (see
 * `passwords`). Pages never draw its value, so the dots stay visible.
 */
function PasswordControl({
  widget,
  label,
  editable,
  tinted,
  placement,
  handle,
}: Omit<ControlProps<TextWidget>, 'docKey' | 'field'> & { handle: PdfDocumentHandle }) {
  const typed = typedPasswords(handle);
  return (
    <input
      type="password"
      aria-label={label}
      title="Not saved in the file"
      autoComplete="off"
      readOnly={!editable}
      maxLength={widget.maxLength ?? undefined}
      defaultValue={typed.get(widget.fieldName) ?? ''}
      onChange={(event) => typed.set(widget.fieldName, event.currentTarget.value)}
      className={cn(
        CONTROL,
        'text-[color:var(--field-color)]',
        editable ? TYPING : FOCUS_RING,
        tinted && TINT,
      )}
      style={{
        ...textFrame(placement, widget),
        fontSize: fontSize(widget, placement.ppu),
        padding: `0 ${2 * placement.ppu}px`,
        ['--field-color' as string]: widget.color,
      }}
    />
  );
}

function CheckBoxControl({
  docKey,
  widget,
  field,
  label,
  editable,
  tinted,
  placement,
}: ControlProps<Extract<FormWidget, { type: 'checkbox' }>>) {
  const fill = useFill(docKey, field.id, label);
  const checked = field.value === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={!editable}
      className={cn(CONTROL, FOCUS_RING, tinted && TINT)}
      style={frame(placement, widget.rect)}
      onClick={() => fill(!checked)}
    />
  );
}

/** The radio buttons of one field on a page: one Tab stop; arrow keys move and choose. */
function RadioGroupControl({
  docKey,
  widgets,
  field,
  label,
  editable,
  tinted,
  placement,
}: Omit<ControlProps<RadioWidget>, 'widget'> & { widgets: readonly RadioWidget[] }) {
  const fill = useFill(docKey, field.id, label);
  const chosen = widgets.findIndex((widget) => widget.exportValue === field.value);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (index + step + widgets.length) % widgets.length;
    const radios =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[next]?.focus();
    fill(widgets[next]!.exportValue);
  };
  return (
    <div role="radiogroup" aria-label={label}>
      {widgets.map((widget, index) => (
        <button
          key={widget.id}
          type="button"
          role="radio"
          aria-checked={index === chosen}
          aria-label={widget.exportValue || `Option ${index + 1}`}
          disabled={!editable}
          tabIndex={index === Math.max(0, chosen) ? 0 : -1}
          className={cn(CONTROL, FOCUS_RING, 'rounded-full', tinted && TINT)}
          style={frame(placement, widget.rect)}
          onClick={() => fill(widget.exportValue)}
          onKeyDown={(event) => onKeyDown(event, index)}
        />
      ))}
    </div>
  );
}

function ChoiceControl({
  docKey,
  widget,
  field,
  label,
  editable,
  tinted,
  placement,
}: ControlProps<Extract<FormWidget, { type: 'choice' }>>) {
  const fill = useFill(docKey, field.id, label);
  const { multiSelect, combo, options } = widget;
  const chosen = Array.isArray(field.value)
    ? field.value
    : typeof field.value === 'string'
      ? [field.value]
      : [];
  return (
    <select
      aria-label={label}
      multiple={multiSelect}
      size={combo || multiSelect ? undefined : Math.max(2, options.length)}
      disabled={!editable}
      value={multiSelect ? chosen : (chosen[0] ?? '')}
      onChange={(event) => {
        const selected = Array.from(event.currentTarget.selectedOptions, (option) => option.value);
        fill(multiSelect ? selected : (selected[0] ?? null));
      }}
      className={cn(
        CONTROL,
        TYPING,
        tinted && TINT,
        // A drop-down's options show in their own pop-up; a list box shows
        // its options (and what is chosen) only while it has focus.
        combo
          ? '[&>option]:text-black'
          : '[&:not(:focus)>option]:bg-transparent [&:not(:focus)>option]:text-transparent',
      )}
      style={{
        ...textFrame(placement, widget),
        fontSize: fontSize(widget, placement.ppu),
        ['--field-color' as string]: widget.color,
      }}
    >
      {/* A drop-down list without a value shows nothing chosen. */}
      {combo && chosen.length === 0 ? <option value="" hidden /> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The fields of one page of a document with a form: controls placed over
 * the widgets of the opened file's fields (pages from other files keep
 * their fields as drawn), in the page's annotation order. Text, choice and
 * button fields are filled in place; a signature field offers to sign it.
 * Read-only fields can be read but not changed; hidden widgets and push
 * buttons get no control.
 */
function FormLayerView({ doc, page, position, box, viewRotation, handle, tool }: PageOverlayProps) {
  const { ui } = useWorkspaceContext();
  const highlight = useUi((state) => state.highlightFields);
  const model = doc.editor?.model;
  const sourceIndex = page.source.kind === 'source' ? page.source.pageIndex : -1;
  const fillable =
    doc.status === 'ready' &&
    doc.info?.forms === 'acroform' &&
    !!model &&
    Object.keys(model.formFields).length > 0 &&
    page.source.kind === 'source' &&
    page.source.sourceId === primarySource(model)?.id;
  const [loaded, setLoaded] = useState<{
    handle: PdfDocumentHandle;
    sourceIndex: number;
    widgets: FormWidget[];
  } | null>(null);

  useEffect(() => {
    if (!fillable || !handle) return;
    let active = true;
    handle.getFormWidgets(sourceIndex).then(
      (widgets) => {
        if (active) setLoaded({ handle, sourceIndex, widgets });
      },
      // A page whose fields cannot be read keeps them as drawn.
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [fillable, handle, sourceIndex]);

  const formFields = model?.formFields;
  const fields = useMemo(
    () => new Map(Object.values(formFields ?? {}).map((field) => [field.name, field])),
    [formFields],
  );

  const widgets =
    loaded && loaded.handle === handle && loaded.sourceIndex === sourceIndex
      ? loaded.widgets
      : null;
  if (!fillable || !handle || !widgets || widgets.length === 0) return null;

  const placement: Placement = {
    ppu: box.width / displaySpaceSize(page, viewRotation).width,
    toDisplay: pageToDisplay(page, viewRotation),
    turned: displayRotation(page, viewRotation),
  };
  const controls: ReactNode[] = [];
  const radioGroups = new Set<string>();
  for (const widget of widgets) {
    const field = fields.get(widget.fieldName);
    if (!field || widget.hidden || widget.type === 'button') continue;
    const label = widget.description || fieldLabel(widget.fieldName);
    const editable = doc.permissions.fillForms && !field.readOnly;
    const common = {
      docKey: doc.key,
      field,
      label,
      editable,
      tinted: highlight && editable,
      placement,
    };
    switch (widget.type) {
      case 'text':
        controls.push(
          widget.password ? (
            <PasswordControl key={widget.id} {...common} widget={widget} handle={handle} />
          ) : (
            <TextControl key={widget.id} {...common} widget={widget} />
          ),
        );
        break;
      case 'checkbox':
        controls.push(<CheckBoxControl key={widget.id} {...common} widget={widget} />);
        break;
      case 'radio':
        // One group per field, where its first button is in the page's order.
        if (radioGroups.has(field.name)) break;
        radioGroups.add(field.name);
        controls.push(
          <RadioGroupControl
            key={widget.id}
            {...common}
            widgets={widgets.filter(
              (entry): entry is RadioWidget =>
                entry.type === 'radio' && entry.fieldName === field.name && !entry.hidden,
            )}
          />,
        );
        break;
      case 'choice':
        controls.push(<ChoiceControl key={widget.id} {...common} widget={widget} />);
        break;
      case 'signature':
        if (!editable) break;
        controls.push(
          <button
            key={widget.id}
            type="button"
            aria-label={`Sign ${label}`}
            className={cn(
              'absolute flex items-center justify-center gap-1 overflow-hidden rounded-xs text-xs font-medium text-accent-soft-ink',
              'border border-dashed border-accent bg-[oklch(0.95_0.03_205/0.85)] hover:bg-[oklch(0.92_0.04_205/0.9)]',
              FOCUS_RING,
            )}
            style={frame(placement, widget.rect)}
            onClick={() =>
              ui.getState().openDialog({
                kind: 'signature',
                docKey: doc.key,
                field: { pageId: page.id, rect: widget.rect },
              })
            }
          >
            <Signature size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
            Sign
          </button>,
        );
        break;
    }
  }

  return (
    <div
      data-form-layer={position + 1}
      className={cn(
        'pointer-events-none absolute [color-scheme:light]',
        // Fields are filled in with the Select tool; the other tools draw over them.
        tool === 'select' && '*:pointer-events-auto',
      )}
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    >
      {controls}
    </div>
  );
}

/** Whether a page's fields look and behave the same: scrolling alone changes nothing. */
function sameFields(a: PageOverlayProps, b: PageOverlayProps): boolean {
  return (
    a.page === b.page &&
    a.position === b.position &&
    a.box === b.box &&
    a.viewRotation === b.viewRotation &&
    a.handle === b.handle &&
    a.tool === b.tool &&
    a.doc.key === b.doc.key &&
    a.doc.status === b.doc.status &&
    a.doc.info === b.doc.info &&
    a.doc.permissions === b.doc.permissions &&
    a.doc.editor?.model.formFields === b.doc.editor?.model.formFields &&
    a.doc.editor?.model.sources === b.doc.editor?.model.sources
  );
}

/** The fillable form fields of one page. */
export const FormLayer = memo(FormLayerView, sameFields);
