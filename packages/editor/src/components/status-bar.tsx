import { primarySource } from '@folio/document-model';
import { ICON } from '@folio/shared-ui';
import { ShieldCheck } from 'lucide-react';
import { useActiveDocument } from '../context';

export function StatusBar() {
  const doc = useActiveDocument();
  const source = doc?.editor ? primarySource(doc.editor.model) : null;
  const current = doc?.editor && doc.view ? doc.editor.model.pages.findIndex((page) => page.id === doc.view?.currentPageId) : -1;
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-line bg-bg px-3 text-2xs text-ink-muted">
      <span className="truncate tabular">
        {source && current >= 0
          ? `Page ${current + 1} of ${source.pageCount}${source.pdfVersion ? ` · PDF ${source.pdfVersion}` : ''}`
          : ''}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <ShieldCheck size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
        Processed on this device
      </span>
    </footer>
  );
}
