import {
  pageNumberText,
  primarySource,
  stampedRange,
  toStandardFontText,
  type DocumentMetadata,
  type DocumentModel,
  type StampPosition,
} from '@folio/document-model';
import { ICON, IconButton } from '@folio/shared-ui';
import { Check, Copy, Pencil } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useUi, useWorkspaceContext } from '../context';
import { formatBytes, formatDate } from '../format';
import type { WorkspaceDocument } from '../store/workspace';
import { AnnotationInspector } from './annotation-inspector';

function CopyButton({ label, value }: { label: string; value: string }) {
  const { adapter } = useWorkspaceContext();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!adapter.features.clipboardWrite) return null;
  return (
    <IconButton
      label={copied ? `Copied ${label.toLowerCase()}` : `Copy ${label.toLowerCase()}`}
      size="icon-sm"
      tooltipSide="left"
      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
      icon={
        copied ? (
          <Check
            size={ICON.sm}
            strokeWidth={ICON.stroke}
            className="text-success-ink"
            aria-hidden
          />
        ) : (
          <Copy size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
        )
      }
      onClick={() => {
        void adapter.writeClipboardText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    />
  );
}

function Row({
  label,
  value,
  copy,
  action,
}: {
  label: string;
  value: ReactNode;
  copy?: string;
  /** A button for the value, where others have their copy button. */
  action?: ReactNode;
}) {
  return (
    <div className="group grid grid-cols-[5.75rem_1fr] items-start gap-x-2 py-1">
      <dt className="pt-0.5 text-xs text-ink-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1 text-xs">
        <span className="min-w-0 flex-1 pt-0.5 break-words" data-selectable>
          {value}
        </span>
        <span className="-my-1 w-7 shrink-0">
          {copy ? <CopyButton label={label} value={copy} /> : action}
        </span>
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3 last:border-b-0">
      <h2 className="mb-1.5 text-xs font-semibold">{title}</h2>
      <dl>{children}</dl>
    </section>
  );
}

const empty = <span className="text-ink-subtle">—</span>;
const textValue = (value: string) => (value ? value : empty);

/** The document's form: its kind and how many fields it has. */
function formsLabel(forms: 'none' | 'acroform' | 'xfa', fields: number): string {
  if (forms === 'xfa') return 'XFA form (not supported)';
  if (forms === 'none' || fields === 0) return 'None';
  return fields === 1 ? 'Interactive form, 1 field' : `Interactive form, ${fields} fields`;
}

const FIELD =
  'w-full min-w-0 rounded-sm bg-transparent px-1.5 py-0.5 text-xs text-ink outline-hidden hover:bg-hover focus-visible:bg-raised focus-visible:shadow-[inset_0_0_0_1px_var(--folio-focus)]';

/** A document property that can be changed in place. */
function EditableRow({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[5.75rem_1fr] items-center gap-x-2 py-0.5">
      <dt className="text-xs text-ink-muted">
        <label htmlFor={id}>{label}</label>
      </dt>
      <dd className="-ml-1.5 min-w-0">
        <input
          id={id}
          className={FIELD}
          value={value}
          placeholder={placeholder ?? 'Add…'}
          spellCheck={false}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </dd>
    </div>
  );
}

/** Keywords are edited as text and stored as a list once typing pauses at a comma. */
function KeywordsRow({
  keywords,
  onChange,
}: {
  keywords: readonly string[];
  onChange(keywords: string[]): void;
}) {
  const joined = keywords.join(', ');
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <EditableRow
      label="Keywords"
      value={draft ?? joined}
      placeholder="Add, separated by commas"
      onChange={(value) => {
        setDraft(value);
        onChange(
          value
            .split(/[,;]/)
            .map((keyword) => keyword.trim())
            .filter((keyword) => keyword.length > 0),
        );
      }}
    />
  );
}

const POSITION_NAMES: Record<StampPosition, string> = {
  'top-left': 'top left',
  'top-center': 'top centre',
  'top-right': 'top right',
  'middle-left': 'middle left',
  center: 'centre',
  'middle-right': 'middle right',
  'bottom-left': 'bottom left',
  'bottom-center': 'bottom centre',
  'bottom-right': 'bottom right',
};

/**
 * The page numbers and watermark added to the pages when saved, as they will
 * show, each with a way to change it.
 */
function StampsSection({ doc, model }: { doc: WorkspaceDocument; model: DocumentModel }) {
  const { ui } = useWorkspaceContext();
  const { pageNumbers, watermark } = model.stamps;
  if (!pageNumbers && !watermark) return null;
  const shown = (text: string) => `“${toStandardFontText(text).text}”`;
  const edit = (kind: 'page-numbers' | 'watermark', label: string) => (
    <IconButton
      label={label}
      size="icon-sm"
      tooltipSide="left"
      icon={<Pencil size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />}
      onClick={() => ui.getState().openDialog({ kind, docKey: doc.key })}
    />
  );
  const first = pageNumbers ? stampedRange(pageNumbers.pages, model.pages.length) : null;
  return (
    <Section title="Page numbers and watermark">
      {pageNumbers ? (
        <Row
          label="Page numbers"
          value={
            first
              ? `${shown(pageNumberText(pageNumbers, first.first, model.pages.length)!)}, ${POSITION_NAMES[pageNumbers.position]}`
              : 'Not on any page'
          }
          action={edit('page-numbers', 'Edit page numbers')}
        />
      ) : null}
      {watermark ? (
        <Row
          label="Watermark"
          value={`${shown(watermark.text)}, ${watermark.layer} the content`}
          action={edit('watermark', 'Edit watermark')}
        />
      ) : null}
    </Section>
  );
}

export function PropertiesPanel({ doc }: { doc: WorkspaceDocument }) {
  const { workspace } = useWorkspaceContext();
  const authorName = useUi((state) => state.authorName);
  const setAuthorName = useUi((state) => state.setAuthorName);
  const model = doc.editor?.model;
  const info = doc.info;
  const source = model ? primarySource(model) : null;
  const sha256 = doc.diskSha256 ?? source?.sha256 ?? '';
  const editable = doc.permissions.modify;
  const set = (patch: Partial<DocumentMetadata>) =>
    workspace.getState().updateMetadata(doc.key, patch);

  return (
    <aside
      aria-label="Properties"
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface"
    >
      <div className="flex h-10 shrink-0 items-center px-4">
        <h2 className="text-xs font-semibold">Properties</h2>
      </div>
      {!model || !info || !source ? (
        <p className="px-4 text-xs text-ink-muted">
          {doc.status === 'loading'
            ? 'Reading document…'
            : doc.status === 'needs-password'
              ? 'Properties are available once the document is unlocked.'
              : 'No properties: the document could not be opened.'}
        </p>
      ) : (
        <>
          <AnnotationInspector doc={doc} />
          <Section title="Description">
            {editable ? (
              <>
                <EditableRow
                  label="Title"
                  value={model.metadata.title}
                  onChange={(title) => set({ title })}
                />
                <EditableRow
                  label="Author"
                  value={model.metadata.author}
                  onChange={(author) => set({ author })}
                />
                <EditableRow
                  label="Subject"
                  value={model.metadata.subject}
                  onChange={(subject) => set({ subject })}
                />
                <KeywordsRow
                  key={doc.key}
                  keywords={model.metadata.keywords}
                  onChange={(keywords) => set({ keywords })}
                />
              </>
            ) : (
              <>
                <Row
                  label="Title"
                  value={textValue(model.metadata.title)}
                  copy={model.metadata.title || undefined}
                />
                <Row
                  label="Author"
                  value={textValue(model.metadata.author)}
                  copy={model.metadata.author || undefined}
                />
                <Row label="Subject" value={textValue(model.metadata.subject)} />
                <Row
                  label="Keywords"
                  value={
                    model.metadata.keywords.length ? model.metadata.keywords.join(', ') : empty
                  }
                />
              </>
            )}
            <Row label="Created" value={formatDate(model.metadata.creationDate)} />
            <Row label="Modified" value={formatDate(model.metadata.modificationDate)} />
            <Row label="Application" value={textValue(model.metadata.creator)} />
            <Row label="PDF producer" value={textValue(model.metadata.producer)} />
          </Section>
          <StampsSection doc={doc} model={model} />
          {/* The file last opened or saved; the model keeps describing the opened one. */}
          <Section title="File">
            <Row label="Name" value={doc.fileName} copy={doc.fileName} />
            <Row
              label="Size"
              value={<span className="tabular">{formatBytes(doc.byteLength)}</span>}
            />
            <Row label="Pages" value={<span className="tabular">{source.pageCount}</span>} />
            <Row label="PDF version" value={source.pdfVersion ?? empty} />
            <Row label="Fast web view" value={info.isLinearized ? 'Yes' : 'No'} />
            <Row
              label="SHA-256"
              value={
                <span className="font-mono text-2xs whitespace-nowrap" title={sha256}>
                  {sha256.slice(0, 16)}…
                </span>
              }
              copy={sha256}
            />
          </Section>
          <Section title="Security">
            <Row
              label="Encryption"
              value={
                info.encryption === 'none'
                  ? 'None'
                  : info.encryption === 'password-protected'
                    ? 'Password required to open'
                    : 'Owner restrictions'
              }
            />
            {info.permissions ? (
              <>
                <Row label="Printing" value={info.permissions.print ? 'Allowed' : 'Not allowed'} />
                <Row label="Copying" value={info.permissions.copy ? 'Allowed' : 'Not allowed'} />
                <Row label="Editing" value={info.permissions.modify ? 'Allowed' : 'Not allowed'} />
                <Row
                  label="Commenting"
                  value={info.permissions.annotate ? 'Allowed' : 'Not allowed'}
                />
                <Row
                  label="Filling in forms"
                  value={doc.permissions.fillForms ? 'Allowed' : 'Not allowed'}
                />
              </>
            ) : null}
            <Row
              label="Forms"
              value={formsLabel(info.forms, Object.keys(model.formFields).length)}
            />
            <Row label="Signatures" value={info.hasSignatures ? 'Present' : 'None'} />
          </Section>
          <Section title="Commenting">
            <EditableRow
              label="Your name"
              value={authorName}
              placeholder="Shown on your comments"
              onChange={setAuthorName}
            />
          </Section>
        </>
      )}
    </aside>
  );
}
