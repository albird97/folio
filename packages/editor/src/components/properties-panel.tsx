import { primarySource } from '@folio/document-model';
import { ICON, IconButton } from '@folio/shared-ui';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useWorkspaceContext } from '../context';
import { formatBytes, formatDate } from '../format';
import type { WorkspaceDocument } from '../store/workspace';

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

function Row({ label, value, copy }: { label: string; value: ReactNode; copy?: string }) {
  return (
    <div className="group grid grid-cols-[5.75rem_1fr] items-start gap-x-2 py-1">
      <dt className="pt-0.5 text-xs text-ink-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1 text-xs">
        <span className="min-w-0 flex-1 pt-0.5 break-words" data-selectable>
          {value}
        </span>
        <span className="-my-1 w-7 shrink-0">
          {copy ? <CopyButton label={label} value={copy} /> : null}
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

export function PropertiesPanel({ doc }: { doc: WorkspaceDocument }) {
  const model = doc.editor?.model;
  const info = doc.info;
  const source = model ? primarySource(model) : null;

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
          <Section title="Description">
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
              value={model.metadata.keywords.length ? model.metadata.keywords.join(', ') : empty}
            />
            <Row label="Created" value={formatDate(model.metadata.creationDate)} />
            <Row label="Modified" value={formatDate(model.metadata.modificationDate)} />
            <Row label="Application" value={textValue(model.metadata.creator)} />
            <Row label="PDF producer" value={textValue(model.metadata.producer)} />
          </Section>
          <Section title="File">
            <Row label="Name" value={source.fileName} copy={source.fileName} />
            <Row
              label="Size"
              value={<span className="tabular">{formatBytes(source.byteLength)}</span>}
            />
            <Row label="Pages" value={<span className="tabular">{source.pageCount}</span>} />
            <Row label="PDF version" value={source.pdfVersion ?? empty} />
            <Row label="Fast web view" value={info.isLinearized ? 'Yes' : 'No'} />
            <Row
              label="SHA-256"
              value={
                <span className="font-mono text-2xs whitespace-nowrap" title={source.sha256}>
                  {source.sha256.slice(0, 16)}…
                </span>
              }
              copy={source.sha256}
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
              </>
            ) : null}
            <Row
              label="Forms"
              value={
                info.forms === 'none'
                  ? 'None'
                  : info.forms === 'xfa'
                    ? 'XFA form (not supported)'
                    : 'Interactive form'
              }
            />
            <Row label="Signatures" value={info.hasSignatures ? 'Present' : 'None'} />
          </Section>
        </>
      )}
    </aside>
  );
}
