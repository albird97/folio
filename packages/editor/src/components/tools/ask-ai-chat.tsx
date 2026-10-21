import type { BetaTextCitation } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiService } from '@folio/platform-adapters';
import {
  Banner,
  Button,
  DialogClose,
  DialogDescription,
  DialogTitle,
  ICON,
  IconButton,
  Input,
  Label,
  Spinner,
} from '@folio/shared-ui';
import { Check, Copy, Settings2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import {
  aiConversationsFor,
  answerText,
  isBusy,
  type AiConversation,
  type AiProblem,
  type AiTurn,
  type AiUsage,
} from '../../ai/conversation';
import { aiModel } from '../../ai/models';
import { citedPages, DOCUMENT_TOKEN_LIMIT, SUMMARY_QUESTION } from '../../ai/prompt';
import { useUi, useWorkspace, useWorkspaceContext } from '../../context';
import { parsePageRange } from '../../format';
import { PERMISSION_MESSAGES } from '../../store/editing';

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** A count rounded to two significant digits, for "about 9,100 tokens". */
export function approximately(count: number): string {
  if (count < 100) return count.toLocaleString();
  const step = 10 ** (Math.floor(Math.log10(count)) - 1);
  return (Math.round(count / step) * step).toLocaleString();
}

/** What an answer used, as Anthropic bills it: "9,412 tokens in (9,100 from cache), 312 out". */
function usageText(usage: AiUsage): string {
  const input = plural(usage.input + usage.cacheRead + usage.cacheWrite, 'token', 'tokens');
  const cached = usage.cacheRead > 0 ? ` (${usage.cacheRead.toLocaleString()} from cache)` : '';
  return `${input} in${cached}, ${usage.output.toLocaleString()} out`;
}

/** What an unrecognized failure was, small and selectable, for reporting it. */
function FailureDetail({ detail }: { detail: string }) {
  return <p className="mt-1 font-mono text-2xs break-all select-text">Details: {detail}</p>;
}

function problemMessage(problem: AiProblem): string {
  switch (problem.kind) {
    case 'no-text':
      return `${problem.pagesRead === 1 ? 'This page has' : 'These pages have'} no text to send. For scanned pages, use Tools › Recognize text… first.`;
    case 'too-large':
      return problem.tokens === null
        ? 'The text of these pages is too large to send. Choose fewer pages.'
        : `The text of these pages is about ${approximately(problem.tokens)} tokens, more than Folio sends at once (${approximately(DOCUMENT_TOKEN_LIMIT)}). Choose fewer pages.`;
    case 'failed':
      return problem.failure.message;
  }
}

/** Links to the pages an answer's passage cites; following one shows the page. */
function CitationLinks({
  docKey,
  conversation,
  citations,
}: {
  docKey: string;
  conversation: AiConversation;
  citations: readonly BetaTextCitation[];
}) {
  const { workspace, ui } = useWorkspaceContext();
  const pages = useWorkspace(
    (state) => state.documents.find((doc) => doc.key === docKey)?.editor?.model.pages,
  );
  const document = conversation.document;
  if (!document || !pages || citations.length === 0) return null;
  const cited = [...new Set(citations.flatMap((citation) => citedPages(document, citation)))].sort(
    (a, b) => a.pageNumber - b.pageNumber,
  );
  return (
    <>
      {cited.map((page) => {
        // Pages may have moved since the text was read; find where it is now.
        const index = pages.findIndex((entry) => entry.id === page.pageId);
        return (
          <button
            key={page.pageId}
            type="button"
            disabled={index === -1}
            // The visible text is the name; the title says what it does.
            title={index === -1 ? 'This page was deleted.' : `Go to page ${index + 1}`}
            className="mx-0.5 rounded bg-accent-soft px-1 align-baseline text-[0.7rem] font-medium text-accent-soft-ink hover:underline disabled:opacity-45"
            onClick={() => {
              workspace.getState().navigate(docKey, { pageIndex: index, align: 'top' });
              ui.getState().closeDialog();
            }}
          >
            page&nbsp;{index === -1 ? page.pageNumber : index + 1}
          </button>
        );
      })}
    </>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const { adapter } = useWorkspaceContext();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      size="icon-sm"
      label={copied ? 'Copied' : 'Copy answer'}
      icon={
        copied ? (
          <Check size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
        ) : (
          <Copy size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
        )
      }
      onClick={() =>
        void adapter.writeClipboardText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    />
  );
}

function Turn({
  docKey,
  conversation,
  turn,
  onFixKey,
}: {
  docKey: string;
  conversation: AiConversation;
  turn: AiTurn;
  onFixKey(message: string): void;
}) {
  const text = answerText(turn.answer);
  return (
    <li className="flex flex-col gap-2">
      <p className="self-end rounded-lg bg-accent-soft px-3 py-2 text-sm whitespace-pre-wrap text-accent-soft-ink">
        <span className="sr-only">You asked: </span>
        {turn.question}
      </p>
      <div className="text-sm">
        <span className="sr-only">Claude answered: </span>
        {turn.status === 'answering' && !text.trim() ? (
          <span className="flex items-center gap-2 text-ink-muted">
            <Spinner /> Thinking…
          </span>
        ) : null}
        {turn.answer.length > 0 ? (
          <p className="whitespace-pre-wrap">
            {turn.answer.map((part, index) => (
              <span key={index}>
                {part.text}
                <CitationLinks
                  docKey={docKey}
                  conversation={conversation}
                  citations={part.citations}
                />
              </span>
            ))}
          </p>
        ) : null}
        {turn.status === 'stopped' ? <p className="mt-1 text-xs text-ink-muted">Stopped.</p> : null}
        {turn.cutOff ? (
          <p className="mt-1 text-xs text-ink-muted">
            The answer reached the length limit and ends early.
          </p>
        ) : null}
        {turn.status === 'refused' ? (
          <Banner tone="warning" title="Claude declined to answer this question." className="mt-1">
            Try asking in a different way.
          </Banner>
        ) : null}
        {turn.status === 'failed' && turn.failure ? (
          <Banner
            tone="danger"
            title={turn.failure.message}
            className="mt-1"
            action={
              turn.failure.fixKey ? (
                <Button size="sm" onClick={() => onFixKey(turn.failure!.message)}>
                  Change key
                </Button>
              ) : null
            }
          >
            {turn.failure.detail ? <FailureDetail detail={turn.failure.detail} /> : null}
          </Banner>
        ) : null}
      </div>
      {turn.status !== 'answering' && text.trim() ? (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <CopyAnswer text={text} />
          {turn.usage ? <span>{usageText(turn.usage)}</span> : null}
          {turn.answeredBy ? <span>· Answered by {turn.answeredBy}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

/** The conversation about one document: Summarize, questions and streamed answers. */
export function AskAiChat({
  ai,
  docKey,
  onSettings,
  onFixKey,
}: {
  ai: AiService;
  docKey: string;
  onSettings(): void;
  onFixKey(message: string): void;
}) {
  const id = useId();
  const { workspace } = useWorkspaceContext();
  const conversations = aiConversationsFor(workspace, ai);
  const conversation = useStore(conversations.store, (state) => state.conversations[docKey]);
  const model = useUi((state) => state.ai.model);
  const doc = useWorkspace(
    (state) => state.documents.find((entry) => entry.key === docKey && entry.editor) ?? null,
  );
  const pageCount = doc?.editor?.model.pages.length ?? 0;
  const [range, setRange] = useState(() => `1-${pageCount}`);
  const [question, setQuestion] = useState('');
  const log = useRef<HTMLOListElement>(null);
  const turns = conversation?.turns ?? [];
  const lastAnswer = turns.at(-1)?.answer;

  // Follow the answer as it streams in.
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns.length, lastAnswer]);

  if (!doc) return null;
  const allowed = doc.permissions.extract;
  const busy = isBusy(conversation);
  const started = conversation?.document != null;
  const positions = parsePageRange(range, pageCount);
  const canAsk = allowed && !busy && (started || (positions !== null && positions.length > 0));
  const conversationModel = aiModel(conversation?.model ?? model);

  const ask = (text: string) => {
    if (!canAsk || !text.trim()) return;
    // The pages are read with the first question; until then they can change.
    if (!started) conversations.start(docKey, model, positions!);
    void conversations.ask(docKey, text.trim());
    setQuestion('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask(question);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter starts a new line (IME composition is left alone).
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    ask(question);
  };

  const sent = conversation?.document
    ? `Sent the text of ${plural(conversation.document.pages.length, 'page', 'pages')}${
        conversation.tokens !== null ? ` (about ${approximately(conversation.tokens)} tokens)` : ''
      } to Anthropic with your first question.`
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-2">
        <div>
          <DialogTitle>Ask Claude</DialogTitle>
          <DialogDescription>
            {conversationModel.label}. Answers can be wrong — check the document.
          </DialogDescription>
        </div>
        <IconButton
          label="Ask Claude settings"
          icon={<Settings2 size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          onClick={onSettings}
        />
      </div>

      {!allowed ? (
        <Banner tone="warning" title={PERMISSION_MESSAGES.extract} className="mt-4">
          So Folio does not send its text to Claude.
        </Banner>
      ) : null}

      <div className="mt-4 flex items-center gap-2 text-sm">
        {started ? (
          <>
            <p role="status" className="flex-1 text-xs text-ink-muted">
              {sent}
            </p>
            <Button size="sm" disabled={busy} onClick={() => conversations.discard(docKey)}>
              New conversation
            </Button>
          </>
        ) : (
          <>
            <Label htmlFor={`${id}-pages`} className="text-sm text-ink">
              Pages
            </Label>
            <Input
              id={`${id}-pages`}
              className="h-7 w-40"
              value={range}
              disabled={busy}
              onChange={(event) => setRange(event.target.value)}
              aria-invalid={positions === null || undefined}
              aria-describedby={`${id}-pages-hint`}
            />
            <p id={`${id}-pages-hint`} className="flex-1 text-xs text-ink-muted">
              {positions === null
                ? `Enter pages like 1-3, 5 (from 1 to ${pageCount}).`
                : `Your first question sends the text of ${plural(positions.length, 'page', 'pages')}.`}
            </p>
          </>
        )}
      </div>

      {conversation?.preparing ? (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
          <Spinner />
          {conversation.preparing === 'reading' ? 'Reading the pages’ text…' : 'Counting tokens…'}
        </p>
      ) : null}
      {conversation?.problem ? (
        <Banner
          tone={conversation.problem.kind === 'failed' ? 'danger' : 'warning'}
          title={problemMessage(conversation.problem)}
          className="mt-3"
          action={
            conversation.problem.kind === 'failed' && conversation.problem.failure.fixKey ? (
              <Button
                size="sm"
                onClick={() =>
                  conversation.problem?.kind === 'failed' &&
                  onFixKey(conversation.problem.failure.message)
                }
              >
                Change key
              </Button>
            ) : null
          }
        >
          {conversation.problem.kind === 'failed' && conversation.problem.failure.detail ? (
            <FailureDetail detail={conversation.problem.failure.detail} />
          ) : null}
        </Banner>
      ) : null}

      <ol
        ref={log}
        aria-label="Conversation"
        aria-live="polite"
        aria-busy={busy}
        className="mt-3 flex min-h-24 flex-1 flex-col gap-4 overflow-y-auto"
      >
        {conversation
          ? turns.map((turn) => (
              <Turn
                key={turn.id}
                docKey={docKey}
                conversation={conversation}
                turn={turn}
                onFixKey={onFixKey}
              />
            ))
          : null}
      </ol>

      <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <Label htmlFor={`${id}-question`}>Your question</Label>
        <textarea
          id={`${id}-question`}
          rows={2}
          autoFocus
          disabled={!allowed}
          value={question}
          placeholder="Ask about this document"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={`${id}-question-hint`}
          className="w-full resize-none rounded-md bg-raised px-2.5 py-1.5 text-sm text-ink shadow-[inset_0_0_0_1px_var(--folio-border-strong)] placeholder:text-ink-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--folio-focus)] focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus/35 disabled:opacity-45"
        />
        <div className="flex items-center gap-2">
          <p id={`${id}-question-hint`} className="flex-1 text-xs text-ink-muted">
            Enter sends; Shift+Enter starts a new line.
          </p>
          {turns.length === 0 ? (
            <Button disabled={!canAsk} onClick={() => ask(SUMMARY_QUESTION)}>
              Summarize
            </Button>
          ) : null}
          {busy ? (
            <Button variant="danger" onClick={() => conversations.stop(docKey)}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!canAsk || !question.trim()}>
              Ask
            </Button>
          )}
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
        </div>
      </form>
    </div>
  );
}
