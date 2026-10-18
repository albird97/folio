import { OpenUrlError, type OpenUrlErrorCode } from '@folio/platform-adapters';
import {
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Label,
} from '@folio/shared-ui';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useWorkspaceContext } from '../context';
import { formatBytes } from '../format';
import type { DialogRequest } from '../store/ui';

type State =
  | { kind: 'idle' }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'failed'; code: OpenUrlErrorCode; message: string; url: string };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the site';
  }
};

/**
 * Opens a PDF from a web address (browsers). Folio asks Chrome for access to
 * the site first; cookies are only sent after the user agrees, for one
 * request, when the site wants a sign-in.
 */
export function OpenUrlDialog({
  request,
}: {
  request: Extract<DialogRequest, { kind: 'open-url' }>;
}) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const [value, setValue] = useState(request.url ?? '');
  const [state, setState] = useState<State>(
    request.error ? { kind: 'failed', ...request.error, url: request.url ?? '' } : { kind: 'idle' },
  );
  const controller = useRef<AbortController | null>(null);
  const id = useId();

  // Closing the dialog stops a download in progress.
  useEffect(() => () => controller.current?.abort(), []);

  const open = (url: string, withCredentials: boolean) => {
    if (!adapter.openUrl || !url.trim()) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState({ kind: 'downloading', received: 0, total: null });
    // Straight from the click: Chrome's site access prompt needs the gesture.
    adapter
      .openUrl(url.trim(), {
        withCredentials,
        signal: abort.signal,
        onProgress: (received, total) => {
          if (!abort.signal.aborted) setState({ kind: 'downloading', received, total });
        },
      })
      .then(
        async (file) => {
          if (abort.signal.aborted) return;
          ui.getState().closeDialog();
          await workspace.getState().openFiles([file]);
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          setState({
            kind: 'failed',
            code: error instanceof OpenUrlError ? error.code : 'network',
            message:
              error instanceof OpenUrlError ? error.message : 'The file could not be downloaded.',
            url: url.trim(),
          });
        },
      );
  };

  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    setState({ kind: 'idle' });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== 'downloading') open(value, false);
  };

  const downloading = state.kind === 'downloading';
  const percent =
    state.kind === 'downloading' && state.total
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : null;

  return (
    <DialogContent className="w-[min(32rem,calc(100vw-2rem))]">
      <form onSubmit={onSubmit}>
        <DialogTitle>Open from a web address</DialogTitle>
        <DialogDescription>
          Folio downloads the PDF to this device and opens it here. Chrome asks you first to let
          Folio read files from the site.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor={`${id}-url`}>Address of the PDF</Label>
          <Input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com/document.pdf"
            autoFocus
            value={value}
            disabled={downloading}
            onChange={(event) => {
              setValue(event.target.value);
              if (state.kind === 'failed') setState({ kind: 'idle' });
            }}
          />
        </div>

        {state.kind === 'downloading' ? (
          <div className="mt-4" role="status">
            <div
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(percent === null ? {} : { 'aria-valuenow': percent })}
              className="h-1.5 overflow-hidden rounded-full bg-hover"
            >
              <div
                className={
                  percent === null
                    ? 'h-full w-1/3 animate-pulse rounded-full bg-accent'
                    : 'h-full rounded-full bg-accent transition-[width] duration-150'
                }
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-ink-muted tabular">
              Downloading… {formatBytes(state.received)}
              {state.total ? ` of ${formatBytes(state.total)}` : ''}
            </p>
          </div>
        ) : null}

        {state.kind === 'failed' && state.code === 'auth-required' ? (
          <div role="alert" className="mt-4 rounded-md bg-bg p-3 text-sm">
            <p>{state.message}</p>
            <p className="mt-1 text-xs text-ink-muted">
              Trying again with your sign-in sends your cookies for {hostOf(state.url)} with this
              one request, as Chrome does when you open the link yourself. Folio does not keep them
              or send them anywhere else.
            </p>
            <Button type="button" size="sm" className="mt-3" onClick={() => open(state.url, true)}>
              Try again with my sign-in
            </Button>
          </div>
        ) : state.kind === 'failed' && state.code === 'permission-denied' ? (
          // Not an error: Chrome asks for access when Open is selected.
          <p role="status" className="mt-3 text-xs text-ink-muted">
            {state.message}
          </p>
        ) : state.kind === 'failed' ? (
          <p role="alert" className="mt-3 text-xs text-danger-ink">
            {state.message}
          </p>
        ) : null}

        <DialogFooter>
          {downloading ? (
            <Button type="button" onClick={cancel}>
              Stop
            </Button>
          ) : (
            <DialogClose asChild>
              <Button type="button">Cancel</Button>
            </DialogClose>
          )}
          <Button type="submit" variant="primary" disabled={downloading || !value.trim()}>
            Open
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
