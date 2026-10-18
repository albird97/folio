import type { PdfErrorCode } from '@folio/pdf-core';
import { Button, ICON, Input, Label, Spinner } from '@folio/shared-ui';
import { FileWarning, LockKeyhole } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useWorkspace } from '../context';
import type { WorkspaceDocument } from '../store/workspace';

export function LoadingState({ doc }: { doc: WorkspaceDocument }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-muted">
      <Spinner />
      <p role="status" className="text-sm">
        Opening {doc.fileName}…
      </p>
    </div>
  );
}

export function PasswordState({ doc }: { doc: WorkspaceDocument }) {
  const submitPassword = useWorkspace((state) => state.submitPassword);
  const close = useWorkspace((state) => state.close);
  const [password, setPassword] = useState('');
  const id = useId();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    void submitPassword(doc.key, password);
    setPassword('');
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        aria-labelledby={`${id}-title`}
        className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-pop animate-pop-in"
      >
        <span className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-soft-ink">
          <LockKeyhole size={ICON.lg} strokeWidth={ICON.stroke} aria-hidden />
        </span>
        <h2 id={`${id}-title`} className="mt-4 text-lg font-semibold">
          This PDF is password protected
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Enter the password to open <span className="font-medium text-ink">{doc.fileName}</span>.
          It is only kept in memory on this device.
        </p>
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor={`${id}-password`}>Password</Label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={doc.passwordRejected || undefined}
            aria-describedby={doc.passwordRejected ? `${id}-error` : undefined}
          />
          {doc.passwordRejected ? (
            <p id={`${id}-error`} role="alert" className="text-xs text-danger-ink">
              That password is incorrect. Check it and try again.
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => void close(doc.key)}>Close</Button>
          <Button type="submit" variant="primary" disabled={!password}>
            Unlock
          </Button>
        </div>
      </form>
    </div>
  );
}

const ERROR_TITLES: Partial<Record<PdfErrorCode, string>> = {
  'empty-file': 'This file is empty',
  'not-a-pdf': 'This isn’t a PDF',
  'invalid-pdf': 'This PDF can’t be read',
  'too-large': 'This file is too large',
  unsupported: 'This PDF isn’t supported yet',
};

export function ErrorState({ doc }: { doc: WorkspaceDocument }) {
  const close = useWorkspace((state) => state.close);
  const code = doc.error?.code ?? 'unknown';
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div role="alert" className="flex max-w-sm flex-col items-center text-center">
        <span className="flex size-10 items-center justify-center rounded-md bg-danger-soft text-danger-ink">
          <FileWarning size={ICON.lg} strokeWidth={ICON.stroke} aria-hidden />
        </span>
        <h2 className="mt-4 text-lg font-semibold">
          {ERROR_TITLES[code] ?? 'Couldn’t open this file'}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          <span className="font-medium text-ink">{doc.fileName}</span> — {doc.error?.message}
        </p>
        <Button className="mt-5" onClick={() => void close(doc.key)}>
          Close tab
        </Button>
      </div>
    </div>
  );
}
