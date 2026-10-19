import { ICON, Switch } from '@folio/shared-ui';
import { Info, TextCursorInput } from 'lucide-react';
import { useId } from 'react';
import { useUi } from '../context';
import { PERMISSION_MESSAGES } from '../store/editing';
import type { WorkspaceDocument } from '../store/workspace';

/**
 * A slim bar above the pages of a document with a form: whether its fields
 * can be filled in, and a switch for their highlight. XFA forms, which
 * Folio cannot fill in, are explained instead.
 */
export function FormBar({ doc }: { doc: WorkspaceDocument }) {
  const id = useId();
  const highlight = useUi((state) => state.highlightFields);
  const setHighlight = useUi((state) => state.setHighlightFields);
  const forms = doc.info?.forms ?? 'none';
  const fields = Object.values(doc.editor?.model.formFields ?? {});
  if (forms === 'none' || (forms === 'acroform' && fields.length === 0)) return null;
  const fillable =
    forms === 'acroform' &&
    doc.permissions.fillForms &&
    fields.some((field) => !field.readOnly && field.type !== 'button');
  const message =
    forms === 'xfa'
      ? 'This form uses XFA, which Folio cannot fill in. Its pages show the form as it was saved.'
      : !doc.permissions.fillForms
        ? PERMISSION_MESSAGES.fillForms
        : fillable
          ? 'This document has fields you can fill in.'
          : 'The fields of this form cannot be changed.';
  const Icon = fillable ? TextCursorInput : Info;
  return (
    <div
      role="region"
      aria-label="Form"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5 text-xs"
    >
      <Icon
        size={ICON.sm}
        strokeWidth={ICON.stroke}
        aria-hidden
        className="shrink-0 text-ink-muted"
      />
      <p className="min-w-0 flex-1 text-ink-muted">{message}</p>
      {fillable ? (
        <div className="flex shrink-0 items-center gap-2">
          <label htmlFor={id}>Highlight fields</label>
          <Switch id={id} checked={highlight} onCheckedChange={setHighlight} />
        </div>
      ) : null}
    </div>
  );
}
