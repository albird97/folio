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
import { useId, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { sendMessage } from '../shared/messages';
import { PERMISSION_EXPLANATIONS } from '../shared/permissions';
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
            description="Folio asks for as little access as possible. It cannot read the websites you visit. Features that open PDFs from web pages will ask for permission when you first use them."
          >
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
          </Section>

          <Section
            title="Folio for desktop"
            description="Sending documents from Chrome to the Folio desktop app is not available in this version. When it arrives, Folio will always ask before transferring a file."
          >
            <p className="text-xs text-ink-muted">Status: not connected.</p>
          </Section>
        </div>
      </div>
    </div>
  );
}

mountSurface((ui) => <Options ui={ui} />);
