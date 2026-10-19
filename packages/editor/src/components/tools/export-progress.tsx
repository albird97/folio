import type { SaveFileResult } from '@folio/platform-adapters';
import { Spinner } from '@folio/shared-ui';

/** What a tool says while it works, with a bar once it knows how far along it is. */
export function ExportProgress({
  label,
  status,
  fraction,
}: {
  /** The progress bar's accessible name, e.g. "Export". */
  label: string;
  status: string;
  /** Between 0 and 1; null while that is not known yet. */
  fraction: number | null;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <p role="status" className="flex items-center gap-2 text-sm">
        <Spinner />
        {status}
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
        className="h-1.5 overflow-hidden rounded-full bg-hover"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${((fraction ?? 0) * 100).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}

/** "Saved Report (text).txt." or "Downloading …", with notes after it. */
export function savedNotice(
  result: Exclude<SaveFileResult, { status: 'cancelled' }>,
  notes: readonly string[] = [],
): string {
  return [
    result.status === 'saved' ? `Saved ${result.name}.` : `Downloading ${result.name}.`,
    ...notes,
  ].join(' ');
}
