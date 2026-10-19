import type { AiService, RuntimePlatform } from '@folio/platform-adapters';
import {
  Banner,
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  ICON,
  IconButton,
  Input,
  Label,
  Spinner,
} from '@folio/shared-ui';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { aiConversationsFor } from '../../ai/conversation';
import { describeAiError } from '../../ai/errors';
import { AI_MODELS } from '../../ai/models';
import { useUi, useWorkspace, useWorkspaceContext } from '../../context';
import type { DialogOf } from '../../store/ui';
import { AskAiChat } from './ask-ai-chat';

/** Where the platform keeps the key, in the user's terms. */
const KEY_STORAGE: Record<RuntimePlatform, string> = {
  desktop: 'Your key is kept in this computer’s keychain, not in Folio’s files.',
  'chrome-extension':
    'Your key is kept in this browser profile’s storage for Folio, and is never synced.',
  web: 'Your key is kept in this page’s memory until you close it.',
};

const PRIVACY_POLICY = 'https://www.anthropic.com/legal/privacy';

function PrivacyPolicy({ platform }: { platform: RuntimePlatform }) {
  // The desktop webview cannot open web pages, so the address is shown as text.
  if (platform === 'desktop')
    return <span className="font-medium">anthropic.com/legal/privacy</span>;
  return (
    <a href={PRIVACY_POLICY} target="_blank" rel="noreferrer" className="text-accent underline">
      anthropic.com/legal/privacy
    </a>
  );
}

/** What turning Ask Claude on means, said before anything can be sent. */
function Disclosure({ platform }: { platform: RuntimePlatform }) {
  return (
    <ul className="mt-4 list-disc space-y-1.5 rounded-md bg-bg py-3 pr-3 pl-7 text-xs text-ink-muted">
      <li>
        When you ask, Folio sends the text of the document’s pages (not the file) and your questions
        to Anthropic’s API, using your API key. Anthropic bills your account for it.
      </li>
      <li>Nothing is sent until you ask. Everything else in Folio stays on this device.</li>
      <li>
        Anthropic’s terms and privacy policy apply to what is sent:{' '}
        <PrivacyPolicy platform={platform} />.
      </li>
      <li>{KEY_STORAGE[platform]} You can turn Ask Claude off and forget the key at any time.</li>
    </ul>
  );
}

/** Turning Ask Claude on: the user's key and their consent. */
function Setup({
  ai,
  platform,
  failure,
  onDone,
}: {
  ai: AiService;
  platform: RuntimePlatform;
  /** Why the key has to be set up again, if that is why this shows. */
  failure: string | null;
  onDone(): void;
}) {
  const id = useId();
  const setAiSettings = useUi((state) => state.setAiSettings);
  const [key, setKey] = useState('');
  const [shown, setShown] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = key.trim() !== '' && agreed && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // Straight from the click: the extension asks Chrome for access first.
      if (!(await ai.setKey(key))) {
        setError(
          'Folio was not allowed to connect to api.anthropic.com, so Ask Claude is still off.',
        );
        return;
      }
      setAiSettings({ enabled: true });
      onDone();
    } catch (caught) {
      setError(describeAiError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <DialogTitle>Ask Claude</DialogTitle>
      <DialogDescription id={`${id}-description`}>
        Ask Claude, Anthropic’s AI assistant, about this document, using your own Anthropic API key.
      </DialogDescription>
      {failure ? <Banner tone="warning" title={failure} className="mt-4" /> : null}
      <Disclosure platform={platform} />
      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor={`${id}-key`}>Anthropic API key</Label>
        <div className="flex items-center gap-1">
          <Input
            id={`${id}-key`}
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="sk-ant-…"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-describedby={`${id}-key-hint`}
            aria-invalid={error !== null || undefined}
          />
          <IconButton
            label={shown ? 'Hide key' : 'Show key'}
            pressed={shown}
            icon={
              shown ? (
                <EyeOff size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
              ) : (
                <Eye size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
              )
            }
            onClick={() => setShown((value) => !value)}
          />
        </div>
        <p id={`${id}-key-hint`} className="text-xs text-ink-muted">
          Create a key in the Claude Console (console.anthropic.com), under API keys.
        </p>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        I agree that Folio sends the text of a document and my questions to Anthropic when I ask.
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-danger-ink">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={!ready}>
          {busy ? <Spinner /> : null}
          Turn on Ask Claude
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The model, and turning Ask Claude off. */
function Settings({
  ai,
  platform,
  docKey,
  onBack,
  onTurnedOff,
}: {
  ai: AiService;
  platform: RuntimePlatform;
  docKey: string;
  onBack(): void;
  onTurnedOff(): void;
}) {
  const id = useId();
  const { workspace } = useWorkspaceContext();
  const model = useUi((state) => state.ai.model);
  const setAiSettings = useUi((state) => state.setAiSettings);
  const [busy, setBusy] = useState(false);

  const turnOff = async () => {
    setBusy(true);
    try {
      await ai.forgetKey();
    } finally {
      // Off even if forgetting failed: nothing is sent while it is off.
      setAiSettings({ enabled: false });
      aiConversationsFor(workspace, ai).discard(docKey);
      setBusy(false);
      onTurnedOff();
    }
  };

  return (
    <div>
      <DialogTitle>Ask Claude settings</DialogTitle>
      <DialogDescription>
        The model answers your questions. Anthropic bills your API key for each answer; larger
        models cost more.
      </DialogDescription>
      <fieldset className="mt-4 space-y-2 text-sm">
        <legend className="mb-1 text-xs font-semibold">Model</legend>
        {AI_MODELS.map((option) => (
          <label key={option.id} className="flex items-start gap-2">
            <input
              type="radio"
              name={`${id}-model`}
              className="mt-1"
              checked={model === option.id}
              onChange={() => setAiSettings({ model: option.id })}
            />
            <span>
              {option.label}
              <span className="block text-xs text-ink-muted">{option.description}</span>
            </span>
          </label>
        ))}
        <p className="text-xs text-ink-muted">A new model applies to new conversations.</p>
      </fieldset>
      <div className="mt-5 flex items-start justify-between gap-4 border-t border-line pt-4">
        <p className="text-xs text-ink-muted">{KEY_STORAGE[platform]}</p>
        <Button variant="danger" disabled={busy} onClick={() => void turnOff()}>
          Turn off and forget key
        </Button>
      </div>
      <DialogFooter>
        <Button variant="primary" autoFocus onClick={onBack}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Ask Claude (opt-in): questions about the document, answered by Claude
 * with the user's own Anthropic API key. Set up once (key and consent),
 * then a conversation per document, kept while the document is open.
 */
export function AskAiDialog({ request }: { request: DialogOf<'ask-ai'> }) {
  const { adapter } = useWorkspaceContext();
  const key = request.docKey;
  const ai = adapter.features.aiAssistant ? adapter.ai : undefined;
  const enabled = useUi((state) => state.ai.enabled);
  const closeDialog = useUi((state) => state.closeDialog);
  const open = useWorkspace((state) =>
    state.documents.some((doc) => doc.key === key && doc.editor),
  );
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [keyFailure, setKeyFailure] = useState<string | null>(null);

  // A document closed meanwhile closes the dialog.
  useEffect(() => {
    if (!open) closeDialog();
  }, [open, closeDialog]);
  useEffect(() => {
    let current = true;
    void ai?.hasKey().then(
      (stored) => current && setHasKey(stored),
      () => current && setHasKey(false),
    );
    return () => {
      current = false;
    };
  }, [ai]);
  if (!open) return null;

  if (!ai) {
    return (
      <DialogContent>
        <DialogTitle>Ask Claude</DialogTitle>
        <DialogDescription>Ask Claude is not available here.</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="primary">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    );
  }

  const content =
    hasKey === null ? (
      <>
        <DialogTitle>Ask Claude</DialogTitle>
        <DialogDescription className="flex items-center gap-2">
          <Spinner /> Checking your settings…
        </DialogDescription>
      </>
    ) : !enabled || !hasKey ? (
      <Setup
        ai={ai}
        platform={adapter.platform}
        failure={keyFailure}
        onDone={() => {
          setKeyFailure(null);
          setHasKey(true);
          setView('chat');
        }}
      />
    ) : view === 'settings' ? (
      <Settings
        ai={ai}
        platform={adapter.platform}
        docKey={key}
        onBack={() => setView('chat')}
        onTurnedOff={() => {
          setHasKey(false);
          setView('chat');
        }}
      />
    ) : (
      <AskAiChat
        ai={ai}
        docKey={key}
        onSettings={() => setView('settings')}
        onFixKey={(message) => {
          // The key no longer works: forget it and ask for a new one.
          void ai.forgetKey().catch(() => undefined);
          setKeyFailure(message);
          setHasKey(false);
        }}
      />
    );

  return (
    <DialogContent className="flex max-h-[min(44rem,calc(100vh-2rem))] w-[min(40rem,calc(100vw-2rem))] flex-col">
      {content}
    </DialogContent>
  );
}
