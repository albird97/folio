import {
  normalizeRotation,
  type FormFieldDescriptor,
  type FormFieldType,
  type FormFieldValue,
  type Rect,
  type Rotation,
} from '@folio/document-model';

/** How a text field lines its text up (/Q). */
export type FieldAlignment = 'left' | 'center' | 'right';

interface FormWidgetBase {
  /** The widget's id in the engine (its object, e.g. "25R"): unique in the file. */
  id: string;
  /** Fully qualified name of the field the widget shows. */
  fieldName: string;
  /**
   * Where the widget sits on its page, in page space: unscaled user space
   * from the lower-left corner of the visible area, like annotations.
   */
  rect: Rect;
  /** How far the widget's content is turned, counterclockwise (/MK /R). */
  rotation: Rotation;
  /** Hidden, or not meant to be shown on screen (Hidden, NoView): not filled in either. */
  hidden: boolean;
  /** The field's description for assistive technology (/TU), or ''. */
  description: string;
}

/** Where a form field shows on a page, and the kind of input it takes there. */
export type FormWidget =
  | (FormWidgetBase & {
      type: 'text';
      multiLine: boolean;
      /** Typed text is hidden, and never saved: the PDF standard asks readers not to. */
      password: boolean;
      /** The text is spread over `maxLength` equal cells. */
      comb: boolean;
      /** Most characters the field takes, or null without a limit. */
      maxLength: number | null;
      alignment: FieldAlignment;
      /** Size of the text in points; 0 sizes it to fit the field. */
      fontSize: number;
      /** Colour of the text, as #rrggbb. */
      color: string;
    })
  | (FormWidgetBase & {
      type: 'checkbox';
      /** The value the box stands for when it is ticked. */
      exportValue: string;
    })
  | (FormWidgetBase & {
      type: 'radio';
      /** The option the button stands for. */
      exportValue: string;
    })
  | (FormWidgetBase & {
      type: 'choice';
      /** A drop-down list; otherwise a list box. */
      combo: boolean;
      multiSelect: boolean;
      options: ReadonlyArray<{ value: string; label: string }>;
      fontSize: number;
      color: string;
    })
  | (FormWidgetBase & { type: 'signature' })
  /** A push button (or a box without an "on" appearance): nothing to fill in. */
  | (FormWidgetBase & { type: 'button' });

/** The parts of PDF.js' data about a widget annotation that Folio reads. */
export interface WidgetAnnotationLike {
  id: string;
  fieldName?: unknown;
  fieldType?: unknown;
  rect?: unknown;
  rotation?: unknown;
  hidden?: unknown;
  alternativeText?: unknown;
  checkBox?: unknown;
  radioButton?: unknown;
  exportValue?: unknown;
  buttonValue?: unknown;
  fieldValue?: unknown;
  multiLine?: unknown;
  password?: unknown;
  comb?: unknown;
  maxLen?: unknown;
  textAlignment?: unknown;
  defaultAppearanceData?: { fontSize?: unknown; fontColor?: ArrayLike<number> } | null;
  options?: unknown;
  combo?: unknown;
  multiSelect?: unknown;
}

const isString = (value: unknown): value is string => typeof value === 'string';

const ALIGNMENTS: readonly FieldAlignment[] = ['left', 'center', 'right'];

function hexColor(color: ArrayLike<number> | undefined): string {
  const channels = color && color.length >= 3 ? [color[0], color[1], color[2]] : [0, 0, 0];
  return `#${channels
    .map((channel) =>
      Math.min(255, Math.max(0, Math.round(Number(channel) || 0)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * A widget as Folio uses it, from PDF.js' annotation data: the box moved
 * into page space (`origin` is the lower-left corner of the page's visible
 * area), values checked. Null for annotations that are not usable widgets.
 */
export function widgetFrom(
  data: WidgetAnnotationLike,
  origin: { x: number; y: number },
): FormWidget | null {
  const raw = Array.isArray(data.rect) ? data.rect.map(Number) : [];
  if (raw.length !== 4 || !raw.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = raw as [number, number, number, number];
  let rotation: Rotation = 0;
  try {
    rotation = normalizeRotation(Number(data.rotation ?? 0));
  } catch {
    rotation = 0;
  }
  const base: FormWidgetBase = {
    id: data.id,
    fieldName: isString(data.fieldName) ? data.fieldName : '',
    rect: {
      x: Math.min(x1, x2) - origin.x,
      y: Math.min(y1, y2) - origin.y,
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    },
    rotation,
    hidden: data.hidden === true,
    description: isString(data.alternativeText) ? data.alternativeText.trim() : '',
  };
  const appearance = data.defaultAppearanceData ?? {};
  const fontSize = Number(appearance.fontSize);
  const text = {
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0,
    color: hexColor(appearance.fontColor),
  };
  switch (data.fieldType) {
    case 'Tx': {
      const maxLength = Number(data.maxLen);
      return {
        ...base,
        ...text,
        type: 'text',
        multiLine: data.multiLine === true,
        password: data.password === true,
        comb: data.comb === true,
        maxLength: Number.isInteger(maxLength) && maxLength > 0 ? maxLength : null,
        alignment: ALIGNMENTS[Number(data.textAlignment)] ?? 'left',
      };
    }
    case 'Btn':
      if (data.checkBox === true && isString(data.exportValue)) {
        return { ...base, type: 'checkbox', exportValue: data.exportValue };
      }
      if (data.radioButton === true && isString(data.buttonValue)) {
        return { ...base, type: 'radio', exportValue: data.buttonValue };
      }
      // Push buttons, and boxes without an "on" appearance, cannot be filled in.
      return { ...base, type: 'button' };
    case 'Ch': {
      const options = (Array.isArray(data.options) ? data.options : []).flatMap(
        (option: { exportValue?: unknown; displayValue?: unknown }) =>
          isString(option?.exportValue)
            ? [
                {
                  value: option.exportValue,
                  label: isString(option.displayValue) ? option.displayValue : option.exportValue,
                },
              ]
            : [],
      );
      return {
        ...base,
        ...text,
        type: 'choice',
        combo: data.combo === true,
        multiSelect: data.multiSelect === true,
        options,
      };
    }
    case 'Sig':
      return { ...base, type: 'signature' };
    default:
      return null;
  }
}

/** A field object as PDF.js reports it: one per widget, and one more for a field with kids. */
export interface FieldObjectLike {
  id?: unknown;
  type?: unknown;
  value?: unknown;
  exportValues?: unknown;
  editable?: unknown;
  page?: unknown;
  multipleSelection?: unknown;
  numItems?: unknown;
}

/** A field of the form with the widgets that show it, as the engine fills it in. */
export interface FormFieldEntry {
  name: string;
  type: FormFieldType;
  /** A list box that takes several options. */
  multiSelect: boolean;
  /** Engine id, page (−1 when on none) and, for buttons, the value each widget stands for. */
  widgets: ReadonlyArray<{ id: string; pageIndex: number; exportValue: string | null }>;
  /** The value in the file. */
  value: FormFieldValue;
  readOnly: boolean;
}

const FIELD_TYPES: Readonly<Record<string, FormFieldType>> = {
  text: 'text',
  checkbox: 'checkbox',
  radiobutton: 'radio',
  combobox: 'choice',
  listbox: 'choice',
  signature: 'signature',
  button: 'button',
};

/** Multi-select list boxes whose value needs the widget's data: field objects only have its first option. */
export function needsListValue(object: FieldObjectLike): boolean {
  return (
    object.type === 'listbox' &&
    object.multipleSelection === true &&
    Number(object.numItems) > 1 &&
    typeof object.id === 'string' &&
    Number.isInteger(object.page) &&
    (object.page as number) >= 0
  );
}

/**
 * The fields of a form from PDF.js' field objects (by fully qualified
 * name), with their values normalized: text → string, check box → whether
 * it is ticked, radio buttons → the chosen option's value or null, choice →
 * the chosen option's value (or null), or every chosen value for a list box
 * that takes several. Signature fields hold null and count as read-only once
 * signed (`signed` holds the engine ids of signed fields); push buttons hold
 * null. `lists` holds the values of multi-select list boxes (see
 * `needsListValue`).
 */
export function indexFields(
  objects: ReadonlyMap<string, readonly FieldObjectLike[]>,
  signed: ReadonlySet<string> = new Set(),
  lists: ReadonlyMap<string, readonly string[]> = new Map(),
): FormFieldEntry[] {
  const entries: FormFieldEntry[] = [];
  for (const [name, objectList] of objects) {
    // Entries without a type stand for a field's kids, not for a widget.
    const first = objectList.find(
      (object) => isString(object.id) && FIELD_TYPES[String(object.type)],
    );
    if (!first) continue;
    const type = FIELD_TYPES[String(first.type)]!;
    // A malformed file can give one name to fields of different types: the first type wins.
    const own = objectList.filter(
      (object) => isString(object.id) && FIELD_TYPES[String(object.type)] === type,
    );
    const widgets = own.map((object) => ({
      id: object.id as string,
      pageIndex: Number.isInteger(object.page) ? (object.page as number) : -1,
      exportValue: isString(object.exportValues) ? object.exportValues : null,
    }));
    const multiSelect = own.some((object) => object.multipleSelection === true);
    const firstValue = own[0]!.value;
    let value: FormFieldValue = null;
    switch (type) {
      case 'text':
        value = isString(firstValue) ? firstValue : '';
        break;
      case 'checkbox':
        value = own.some((object) => isString(object.value) && object.value !== 'Off');
        break;
      case 'radio':
        value =
          isString(firstValue) && widgets.some((widget) => widget.exportValue === firstValue)
            ? firstValue
            : null;
        break;
      case 'choice':
        if (multiSelect) {
          value = [...(lists.get(name) ?? (isString(firstValue) ? [firstValue] : []))];
        } else {
          value = isString(firstValue) ? firstValue : null;
        }
        break;
    }
    const readOnly =
      type === 'signature'
        ? objectList.some((object) => isString(object.id) && signed.has(object.id))
        : !own.some((object) => object.editable !== false);
    entries.push({ name, type, multiSelect, widgets, value, readOnly });
  }
  return entries;
}

/** What the document model gets for a field. */
export function fieldDescriptor(entry: FormFieldEntry): FormFieldDescriptor {
  const page = entry.widgets.find((widget) => widget.pageIndex >= 0);
  return {
    name: entry.name,
    type: entry.type,
    pageIndex: page ? page.pageIndex : null,
    value: Array.isArray(entry.value) ? [...entry.value] : entry.value,
    readOnly: entry.readOnly,
  };
}

/** Whether two field values are the same (the options of a list box in any order). */
export function sameFieldValue(a: FormFieldValue, b: FormFieldValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sorted = [...b].sort();
    return [...a].sort().every((entry, index) => entry === sorted[index]);
  }
  return a === b;
}

/** A value for one widget in PDF.js' annotation storage. */
export type StoredWidgetValue = { value: string | boolean | string[] };

/**
 * What PDF.js' annotation storage holds for each widget of a field showing
 * `value`: text, whether a check box or radio button is on, or the chosen
 * option(s). Null when the value does not fit the field (or the field takes
 * no value), so it is left alone.
 */
export function storedValues(
  field: FormFieldEntry,
  value: FormFieldValue,
): Array<[string, StoredWidgetValue]> | null {
  const each = (stored: (exportValue: string | null) => StoredWidgetValue) =>
    field.widgets.map((widget): [string, StoredWidgetValue] => [
      widget.id,
      stored(widget.exportValue),
    ]);
  switch (field.type) {
    case 'text':
      return isString(value) ? each(() => ({ value })) : null;
    case 'checkbox':
      return typeof value === 'boolean' ? each(() => ({ value })) : null;
    case 'radio':
      if (value !== null && !isString(value)) return null;
      return each((exportValue) => ({ value: value !== null && exportValue === value }));
    case 'choice':
      if (field.multiSelect) {
        const chosen = value === null ? [] : value;
        return Array.isArray(chosen) ? each(() => ({ value: [...chosen] })) : null;
      }
      // An empty value chooses nothing.
      if (value !== null && !isString(value)) return null;
      return each(() => ({ value: value ?? '' }));
    case 'signature':
    case 'button':
      return null;
  }
}
