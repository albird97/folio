import { primarySource } from '@folio/document-model';
import { ICON, Spinner } from '@folio/shared-ui';
import { ShieldCheck } from 'lucide-react';
import { useActiveDocument } from '../context';

export function StatusBar() {
  const doc = useActiveDocument();
  const source = doc?.editor ? primarySource(doc.editor.model) : null;
  const current =
    doc?.editor && doc.view
      ? doc.editor.model.pages.findIndex((page) => page.id === doc.view?.currentPageId)
      : -1;
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-line bg-bg px-3 text-2xs text-ink-muted">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate tabular">
          {source && current >= 0
            ? `Page ${(current + 1).toLocaleString()} of ${source.pageCount.toLocaleString()}${source.pdfVersion ? ` · PDF ${source.pdfVersion}` : ''}`
            : ''}
        </span>
        {doc?.status === 'ready' && !doc.pagesComplete ? (
          <span className="flex shrink-0 items-center gap-1">
            <Spinner className="[&_svg]:size-3" />
            Reading page sizes…
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <ShieldCheck size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
        Processed on this device
      </span>
    </footer>
  );
}
