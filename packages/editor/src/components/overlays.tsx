import { ICON } from '@folio/shared-ui';
import { FileDown } from 'lucide-react';
import { useEffect } from 'react';
import { useWorkspace } from '../context';

export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-2 z-(--z-overlay) flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/55 animate-fade-in"
    >
      <span className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-pop">
        <FileDown size={ICON.md} strokeWidth={ICON.stroke} />
        Drop PDFs to open them
      </span>
    </div>
  );
}

export function NoticeToast() {
  const notice = useWorkspace((state) => state.notice);
  const dismiss = useWorkspace((state) => state.dismissNotice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismiss, 4500);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-10 z-(--z-toast) flex justify-center">
      {notice ? (
        <p key={notice.id} className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-bg shadow-pop animate-pop-in">
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}
