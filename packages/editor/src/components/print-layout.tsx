import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePrintJob } from '../hooks/use-print';

/** The pages being printed; only visible to the printer (see viewer.css). */
export function PrintLayout() {
  const job = usePrintJob((state) => state.job);
  const printing = job !== null;
  // While Folio prints, print styles show these pages instead of the app.
  useEffect(() => {
    if (!printing) return;
    const root = document.documentElement;
    root.dataset.folioPrinting = '';
    return () => {
      delete root.dataset.folioPrinting;
    };
  }, [printing]);
  if (!job) return null;
  return createPortal(
    <div id="folio-print" aria-hidden>
      {job.pages.map((page, index) => (
        <div key={page.url} className="folio-print-sheet">
          <img
            src={page.url}
            alt=""
            width={page.width}
            height={page.height}
            data-index={index}
            data-orientation={page.width > page.height ? 'landscape' : 'portrait'}
          />
        </div>
      ))}
    </div>,
    document.body,
  );
}
