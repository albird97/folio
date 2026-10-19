import '../styles.css';
import type { UiState } from '@folio/editor';
import {
  Button,
  FolioMark,
  ICON,
  SegmentedControl,
  Switch,
  type ThemePreference,
} from '@folio/shared-ui';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { AI_HOST_PERMISSION } from '@folio/platform-adapters';
import { AI_KEY_STORAGE } from '../shared/ai';
import { checkDesktop, requestDesktopAccess, type DesktopStatus } from '../shared/desktop';
import { sendMessage } from '../shared/messages';
import {
  HOST_ACCESS_EXPLANATION,
  OPTIONAL_PERMISSION_EXPLANATIONS,
  PERMISSION_EXPLANATIONS,
} from '../shared/permissions';
import { SETTINGS_KEY, type ExtensionSettings } from '../shared/settings';
import { mountSurface } from '../shared/surface';
import { useActivity } from '../shared/use-activity';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-line py-6 first:border-t-0">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {description ? (
        <p className="mt-1 max-w-prose text-sm text-ink-muted">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-description`} className="mt-0.5 max-w-prose text-xs text-ink-muted">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        onCheckedChange={onChange}
      />
    </div>
  );
}

const THEME_OPTIONS = [
  {
    value: 'system',
    label: 'System',
    icon: <Monitor size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />,
  },
  {
    value: 'light',
    label: 'Light',
    icon: <Sun size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />,
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: <Moon size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />,
  },
] as const;

/** Permissions Folio holds beyond those it was installed with, read from Chrome. */
function useGrantedAccess() {
  const [granted, setGranted] = useState<{ origins: string[]; permissions: string[] } | null>(null);
  useEffect(() => {
    const load = () =>
      void chrome.permissions.getAll().then((all) =>
        setGranted({
          origins: [...(all.origins ?? [])].sort(),
          permissions: (all.permissions ?? []).filter(
            (permission) => permission in OPTIONAL_PERMISSION_EXPLANATIONS,
          ),
        }),
      );
    load();
    chrome.permissions.onAdded.addListener(load);
    chrome.permissions.onRemoved.addListener(load);
    return () => {
      chrome.permissions.onAdded.removeListener(load);
      chrome.permissions.onRemoved.removeListener(load);
    };
  }, []);
  return granted;
}

/** "https://example.com/*" → "example.com (https)". */
const describeOrigin = (pattern: string) => {
  if (pattern === AI_HOST_PERMISSION) return 'api.anthropic.com (Ask Claude)';
  const match = /^(https?):\/\/([^/]+)\//.exec(pattern);
  return match ? `${match[2]}${match[1] === 'http' ? ' (http)' : ''}` : pattern;
};

function SiteAccess() {
  const granted = useGrantedAccess();
  if (!granted) return null;
  const remove = (request: chrome.permissions.Permissions) =>
    void chrome.permissions.remove(request).catch(() => undefined);
  return (
    <>
      <h3 className="text-sm font-medium">Sites Folio may read</h3>
      <p className="mt-0.5 max-w-prose text-xs text-ink-muted">{HOST_ACCESS_EXPLANATION}</p>
      {granted.origins.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted" role="status">
          None. Folio cannot read any website.
        </p>
      ) : (
        <ul
          aria-label="Sites Folio may read"
          className="mt-2 divide-y divide-line rounded-md bg-bg"
        >
          {granted.origins.map((origin) => (
            <li key={origin} className="flex items-center justify-between gap-4 px-4 py-2 text-xs">
              <span className="font-mono">{describeOrigin(origin)}</span>
              <Button
                size="sm"
                onClick={() => remove({ origins: [origin] })}
                aria-label={`Remove access to ${describeOrigin(origin)}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-5 text-sm font-medium">Asked for when first needed</h3>
      <dl className="mt-2 divide-y divide-line rounded-md bg-bg">
        {Object.entries(OPTIONAL_PERMISSION_EXPLANATIONS).map(([permission, explanation]) => {
          const allowed = granted.permissions.includes(permission);
          return (
            <div
              key={permission}
              className="grid grid-cols-[8rem_1fr_auto] items-center gap-4 px-4 py-3"
            >
              <dt className="font-mono text-xs">{permission}</dt>
              <dd className="text-xs text-ink-muted">
                {explanation}{' '}
                <span className="font-medium text-ink">
                  {allowed ? 'Allowed.' : 'Not allowed.'}
                </span>
              </dd>
              <dd>
                {allowed ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      remove({ permissions: [permission as chrome.runtime.ManifestPermission] })
                    }
                    aria-label={`Remove the ${permission} permission`}
                  >
                    Remove
                  </Button>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}

function DesktopConnection() {
  const [status, setStatus] = useState<DesktopStatus | 'checking' | 'denied' | null>(null);
  const check = () => {
    setStatus('checking');
    // Straight from the click: Chrome asks for the permission the first time.
    void requestDesktopAccess().then(
      (allowed) => (allowed ? checkDesktop().then(setStatus) : setStatus('denied')),
      () => setStatus('denied'),
    );
  };
  return (
    <div className="flex items-start justify-between gap-4">
      <p className="max-w-prose text-xs text-ink-muted" role="status">
        {status === null
          ? 'To connect, install Folio for desktop and choose File › Connect to Chrome… there.'
          : status === 'checking'
            ? 'Checking…'
            : status === 'denied'
              ? 'Folio was not allowed to talk to the desktop app.'
              : status.status === 'connected'
                ? `Connected to Folio for desktop${status.version ? ` ${status.version}` : ''}.`
                : status.status === 'not-installed'
                  ? 'Not connected. Install Folio for desktop and choose File › Connect to Chrome… there.'
                  : status.message}
      </p>
      <Button size="sm" onClick={check} disabled={status === 'checking'}>
        Check connection
      </Button>
    </div>
  );
}

/** Whether an Anthropic API key is stored, kept current as it changes. */
function useAiKeyStored() {
  const [stored, setStored] = useState<boolean | null>(null);
  useEffect(() => {
    const load = () =>
      void sendMessage({ type: 'ai/status' }).then((response) =>
        setStored(response.ok && response.ai?.hasKey === true),
      );
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && AI_KEY_STORAGE in changes) load();
    };
    load();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  return stored;
}

function AskClaude({ ui }: { ui: StoreApi<UiState> }) {
  const enabled = useStore(ui, (state) => state.ai.enabled);
  const setAiSettings = useStore(ui, (state) => state.setAiSettings);
  const stored = useAiKeyStored();
  if (stored === null) return null;
  const on = enabled && stored;
  return (
    <div className="flex items-start justify-between gap-4">
      <p className="max-w-prose text-xs text-ink-muted" role="status">
        {on
          ? 'On. Your Anthropic API key is stored in this browser profile for Folio, and is never synced.'
          : stored
            ? 'Off. An Anthropic API key is still stored in this browser profile.'
            : 'Off. To turn it on, choose Tools › Ask Claude… in the editor.'}
      </p>
      <Button
        size="sm"
        disabled={!enabled && !stored}
        onClick={() => {
          setAiSettings({ enabled: false });
          void sendMessage({ type: 'ai/forget-key' });
        }}
      >
        Turn off and forget key
      </Button>
    </div>
  );
}

function Options({ ui }: { ui: StoreApi<UiState> }) {
  const theme = useStore(ui, (state) => state.theme);
  const setTheme = useStore(ui, (state) => state.setTheme);
  const { activity, settings } = useActivity();
  const manifest = chrome.runtime.getManifest();
  const permissions = manifest.permissions ?? [];

  const update = (patch: Partial<ExtensionSettings>) =>
    void chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, ...patch } });

  return (
    <div className="min-h-full bg-bg text-ink">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <header className="flex items-center gap-3">
          <FolioMark className="size-9" />
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.01em]">Folio settings</h1>
            <p className="text-sm text-ink-muted">Version {manifest.version}</p>
          </div>
        </header>

        <div className="mt-8 rounded-lg bg-surface px-6 shadow-pop">
          <Section title="Appearance">
            <SegmentedControl<ThemePreference>
              label="Theme"
              value={theme}
              onValueChange={setTheme}
              options={THEME_OPTIONS}
            />
          </Section>

          <Section
            title="Privacy"
            description="Folio reads and renders PDFs inside your browser. Documents are never uploaded, and document contents are never stored in activity."
          >
            <ToggleRow
              label="Keep recent activity"
              description="Shows the last few actions in the toolbar popup, such as “Opened a PDF · 3 pages”."
              checked={settings.activityEnabled}
              onChange={(activityEnabled) => update({ activityEnabled })}
            />
            <ToggleRow
              label="Include file names in activity"
              description="Off by default, because file names can be sensitive. Turning it off removes names already stored."
              checked={settings.activityIncludesNames}
              disabled={!settings.activityEnabled}
              onChange={(activityIncludesNames) => update({ activityIncludesNames })}
            />
            <div className="mt-2 flex items-center justify-between gap-4 py-2">
              <p className="text-xs text-ink-muted" role="status">
                {activity === null
                  ? ''
                  : activity.length === 0
                    ? 'No activity stored.'
                    : `${activity.length} ${activity.length === 1 ? 'entry' : 'entries'} stored.`}
              </p>
              <Button
                size="sm"
                disabled={!activity?.length}
                onClick={() => void sendMessage({ type: 'activity/clear' })}
              >
                Clear activity
              </Button>
            </div>
          </Section>

          <Section
            title="Permissions"
            description="Folio asks for as little access as possible. It cannot read the websites you visit unless you allow a site, and it asks for other permissions only when you first use a feature that needs them."
          >
            <h3 className="mb-2 text-sm font-medium">Granted at install</h3>
            <dl className="divide-y divide-line rounded-md bg-bg">
              {permissions.map((permission) => (
                <div key={permission} className="grid grid-cols-[8rem_1fr] gap-4 px-4 py-3">
                  <dt className="font-mono text-xs">{permission}</dt>
                  <dd className="text-xs text-ink-muted">
                    {PERMISSION_EXPLANATIONS[permission] ?? 'Required by Folio.'}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-5">
              <SiteAccess />
            </div>
          </Section>

          <Section
            title="Ask Claude"
            description="Optional, and off unless you turn it on. When you ask Claude about a document in the editor, Folio sends the text of its pages and your questions to Anthropic’s API with your own API key. Nothing is sent until you ask."
          >
            <AskClaude ui={ui} />
          </Section>

          <Section
            title="Folio for desktop"
            description="Documents can be handed to the Folio desktop app from the editor and the side panel. Folio for desktop always asks before it opens a document, and declined documents are deleted."
          >
            <DesktopConnection />
          </Section>
        </div>
      </div>
    </div>
  );
}

mountSurface((ui) => <Options ui={ui} />);
