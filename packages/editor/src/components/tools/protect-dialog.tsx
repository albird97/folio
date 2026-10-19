import type { PdfPermissions } from '@folio/pdf-core';
import type { Protection } from '@folio/pdf-core/export';
import {
  Banner,
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Label,
} from '@folio/shared-ui';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useUi, useWorkspace, useWorkspaceContext } from '../../context';
import { exportFailureMessage, saveNotes } from '../../hooks/use-save-as';
import type { DialogOf } from '../../store/ui';
import { baseName, type WorkspaceDocument } from '../../store/workspace';
import { ExportProgress, savedNotice } from './export-progress';
import {
  canRemoveProtection,
  describeProtection,
  passwordStrength,
  PERMISSION_LABELS,
  restrictionsOf,
  verifyProtection,
} from './protection';

type Mode = 'protect' | 'remove';

type Run =
  | { status: 'choosing' }
  | { status: 'running'; stage: 'writing' | 'checking' | 'saving' }
  | { status: 'failed'; message: string };

const ALLOW_ALL: PdfPermissions = {
  print: true,
  copy: true,
  modify: true,
  annotate: true,
  fillForms: true,
  assemble: true,
};

/**
 * Password protection: saves a copy that needs a password to open and/or
 * restricts printing, copying and changes, or a copy without protection.
 * The open document does not change, and passwords are never stored.
 */
export function ProtectDialog({ request }: { request: DialogOf<'protect'> }) {
  const doc = useWorkspace(
    (state) =>
      state.documents.find((entry) => entry.key === request.docKey && entry.editor) ?? null,
  );
  const closeDialog = useUi((state) => state.closeDialog);
  // A document closed meanwhile closes the dialog.
  useEffect(() => {
    if (!doc) closeDialog();
  }, [doc, closeDialog]);
  return doc?.info ? <Protect doc={doc} /> : null;
}

function PasswordField({
  label,
  value,
  onChange,
  visible,
  describedBy,
  invalid,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  visible: boolean;
  describedBy?: string;
  invalid?: boolean;
}) {
  const id = useId();
  return (
    <>
      <Label htmlFor={id} className="text-xs font-medium text-ink-muted">
        {label}
      </Label>
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      />
    </>
  );
}

function Protect({ doc }: { doc: WorkspaceDocument }) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const id = useId();
  const info = doc.info!;
  // The author's restrictions stay: Folio cannot lift them.
  const locked = restrictionsOf(info.permissions);
  const removable = canRemoveProtection(info);
  const [mode, setMode] = useState<Mode>('protect');
  const [requirePassword, setRequirePassword] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [restrict, setRestrict] = useState(locked.length > 0);
  // Restricting starts from nothing allowed, or from what the author allows.
  const [allowed, setAllowed] = useState<PdfPermissions>(() =>
    locked.length > 0 && info.permissions
      ? info.permissions
      : {
          print: false,
          copy: false,
          modify: false,
          annotate: false,
          fillForms: false,
          assemble: false,
        },
  );
  const [ownerPassword, setOwnerPassword] = useState('');
  const [run, setRun] = useState<Run>({ status: 'choosing' });

  const strength = passwordStrength(password);
  const mismatch = requirePassword && confirmation !== '' && confirmation !== password;
  const sameAsOpen =
    restrict && ownerPassword !== '' && requirePassword && ownerPassword === password;
  const permissions: PdfPermissions = restrict
    ? { ...allowed, ...Object.fromEntries(locked.map((key) => [key, false])) }
    : ALLOW_ALL;
  const ready =
    mode === 'remove'
      ? removable
      : (requirePassword || restrict) &&
        (!requirePassword || (password !== '' && confirmation === password)) &&
        !sameAsOpen;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || run.status === 'running') return;
    const userPassword = mode === 'protect' && requirePassword ? password : '';
    const protection: Protection | 'none' =
      mode === 'remove'
        ? 'none'
        : {
            userPassword,
            permissions: restrict ? permissions : null,
            // Folio does not know the author's permissions password, so
            // restrictions it could not lift stay unliftable.
            ...(restrict && locked.length === 0 && ownerPassword ? { ownerPassword } : {}),
          };
    setRun({ status: 'running', stage: 'writing' });
    try {
      const { bytes, warnings } = await workspace
        .getState()
        .exportDocument(doc.key, { protection });
      setRun({ status: 'running', stage: 'checking' });
      const verified = await verifyProtection(workspace.engine, bytes, {
        password: userPassword,
        permissions: mode === 'remove' ? null : permissions,
        pageCount: doc.editor!.model.pages.length,
      });
      if (!verified) {
        setRun({
          status: 'failed',
          message:
            'Folio could not confirm that the copy is protected as chosen, so it was not saved.',
        });
        return;
      }
      setRun({ status: 'running', stage: 'saving' });
      const result = await adapter.saveFileAs({
        suggestedName: `${baseName(doc.fileName)} (${mode === 'remove' ? 'unprotected' : 'protected'}).pdf`,
        bytes,
      });
      if (result.status === 'cancelled') {
        setRun({ status: 'choosing' });
        return;
      }
      workspace.getState().showNotice(savedNotice(result, saveNotes(warnings, info.hasSignatures)));
      ui.getState().closeDialog();
    } catch (error) {
      setRun({ status: 'failed', message: exportFailureMessage(error) });
    }
  };

  const busy = run.status === 'running';
  return (
    <DialogContent
      aria-describedby={`${id}-description`}
      className="max-h-[calc(100vh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto"
    >
      <form noValidate onSubmit={(event) => void save(event)}>
        <DialogTitle>Password protection</DialogTitle>
        <DialogDescription id={`${id}-description`}>
          Saves a protected copy; this document stays as it is. Folio does not keep the passwords,
          so make sure you remember them.
        </DialogDescription>
        <p className="mt-3 text-sm">{describeProtection(info)}</p>

        {run.status === 'running' ? (
          <ExportProgress
            label="Password protection"
            status={
              run.stage === 'writing'
                ? 'Writing the copy…'
                : run.stage === 'checking'
                  ? 'Checking the copy…'
                  : 'Saving…'
            }
            fraction={null}
          />
        ) : (
          <fieldset disabled={busy} className="mt-4 space-y-3 text-sm">
            {info.encryption !== 'none' ? (
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    checked={mode === 'protect'}
                    onChange={() => setMode('protect')}
                  />
                  Change the protection
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    checked={mode === 'remove'}
                    disabled={!removable}
                    onChange={() => setMode('remove')}
                    aria-describedby={removable ? undefined : `${id}-remove-note`}
                  />
                  Remove password protection
                </label>
                {!removable ? (
                  <p id={`${id}-remove-note`} className="ml-6 text-xs text-ink-muted">
                    {locked.length > 0
                      ? 'Only the author can remove its restrictions, with the permissions password.'
                      : 'Only documents opened with their password can be saved without it.'}
                  </p>
                ) : null}
              </div>
            ) : null}

            {mode === 'protect' ? (
              <>
                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={requirePassword}
                    onChange={(event) => setRequirePassword(event.target.checked)}
                  />
                  Require a password to open
                </label>
                {requirePassword ? (
                  <div className="ml-6 grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2">
                    <PasswordField
                      label="Password"
                      value={password}
                      onChange={setPassword}
                      visible={visible}
                      describedBy={strength ? `${id}-strength` : undefined}
                    />
                    <PasswordField
                      label="Confirm password"
                      value={confirmation}
                      onChange={setConfirmation}
                      visible={visible}
                      describedBy={mismatch ? `${id}-mismatch` : undefined}
                      invalid={mismatch}
                    />
                    <div className="col-start-2 flex flex-col items-start gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={visible}
                        onClick={() => setVisible((value) => !value)}
                      >
                        {visible ? 'Hide passwords' : 'Show passwords'}
                      </Button>
                      {strength ? (
                        <p
                          id={`${id}-strength`}
                          className={
                            strength.level === 'weak'
                              ? 'text-xs text-danger-ink'
                              : 'text-xs text-ink-muted'
                          }
                        >
                          {strength.hint}
                        </p>
                      ) : null}
                      {mismatch ? (
                        <p id={`${id}-mismatch`} role="alert" className="text-xs text-danger-ink">
                          The passwords do not match.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={restrict}
                    disabled={locked.length > 0}
                    onChange={(event) => setRestrict(event.target.checked)}
                  />
                  Restrict printing, copying and changes
                </label>
                {restrict ? (
                  <div className="ml-6 space-y-2">
                    <fieldset className="space-y-1.5">
                      <legend className="mb-1 text-xs font-semibold">Allow</legend>
                      {PERMISSION_LABELS.map(({ key, label }) => (
                        <label key={key} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={permissions[key]}
                            disabled={locked.includes(key)}
                            onChange={(event) =>
                              setAllowed((current) => ({ ...current, [key]: event.target.checked }))
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                    {locked.length > 0 ? (
                      <p className="text-xs text-ink-muted">
                        The author’s restrictions stay, and nobody can lift them in the copy: Folio
                        does not know the author’s permissions password.
                      </p>
                    ) : (
                      <div className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-1">
                        <PasswordField
                          label="Permissions password (optional)"
                          value={ownerPassword}
                          onChange={setOwnerPassword}
                          visible={visible}
                          describedBy={`${id}-owner-note`}
                          invalid={sameAsOpen}
                        />
                        <p id={`${id}-owner-note`} className="col-start-2 text-xs text-ink-muted">
                          {sameAsOpen
                            ? 'Use a different password from the one to open the document.'
                            : ownerPassword
                              ? 'Lifts the restrictions in PDF apps that ask for it.'
                              : 'Without one, nobody can lift the restrictions, not even you.'}
                        </p>
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-ink-muted">
                The copy opens without a password and allows everything.
              </p>
            )}
          </fieldset>
        )}

        {run.status === 'failed' ? (
          <Banner tone="danger" title={run.message} className="mt-4" />
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {mode === 'remove' ? 'Save without protection…' : 'Save protected copy…'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
