import Anthropic, { type Middleware } from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaTextCitation,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AI_API_ORIGIN,
  AI_MAX_BODY_BYTES,
  AiTransportError,
  type AiService,
} from '@folio/platform-adapters';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { WorkspaceStore } from '../store/workspace';
import { readDocumentText } from './document-text';
import { describeAiError, type AiFailure } from './errors';
import type { AiModel } from './models';
import {
  askParams,
  countParams,
  DOCUMENT_TOKEN_LIMIT,
  documentBytes,
  type AiDocument,
  type AiExchange,
} from './prompt';

/** A passage of an answer and the places in the document it cites. */
export interface AnswerPart {
  text: string;
  citations: BetaTextCitation[];
}

export interface AiUsage {
  /** Input tokens processed at full price. */
  input: number;
  /** Input tokens read from Anthropic's prompt cache (a tenth of the price or less). */
  cacheRead: number;
  /** Input tokens written to the cache. */
  cacheWrite: number;
  output: number;
}

export type TurnStatus =
  | 'answering'
  | 'done'
  /** The user stopped it; the part received so far is kept. */
  | 'stopped'
  /** Claude declined to answer; any partial answer is dropped. */
  | 'refused'
  | 'failed';

export interface AiTurn {
  id: number;
  question: string;
  answer: AnswerPart[];
  status: TurnStatus;
  /** The answer reached the length limit and ends abruptly. */
  cutOff: boolean;
  failure: AiFailure | null;
  /** The model that answered, when another one stepped in for the chosen model. */
  answeredBy: string | null;
  usage: AiUsage | null;
}

export type AiProblem =
  /** None of the chosen pages has text. */
  | { kind: 'no-text'; pagesRead: number }
  /** Too much text for one conversation; `tokens` is null when it was too large to count. */
  | { kind: 'too-large'; tokens: number | null }
  /** The first question could not be prepared. */
  | { kind: 'failed'; failure: AiFailure };

/**
 * A conversation about one open document. UI state only: it never enters
 * the document model, undo history or crash recovery, and it is gone when
 * the document closes or the page reloads.
 */
export interface AiConversation {
  /** Fixed per conversation: caches belong to one model. */
  model: AiModel;
  /** The pages asked about (0-based positions, in order). */
  positions: number[];
  /** The text sent, read at the first question; null until then. */
  document: AiDocument | null;
  /** Tokens of the first request (counted before it was sent). */
  tokens: number | null;
  turns: AiTurn[];
  /** Getting the first question ready: reading the pages' text, counting tokens. */
  preparing: 'reading' | 'counting' | null;
  /** Why the first question was not sent. */
  problem: AiProblem | null;
}

interface ConversationsState {
  conversations: Readonly<Record<string, AiConversation>>;
}

export interface AiConversations {
  store: StoreApi<ConversationsState>;
  /** Starts a new, empty conversation about some pages (replacing any other one). */
  start(key: string, model: AiModel, positions: number[]): void;
  /** Asks a question in the document's conversation and streams the answer. */
  ask(key: string, question: string): Promise<void>;
  /** Stops the answer (or the preparation) in progress. */
  stop(key: string): void;
  /** Forgets the document's conversation. */
  discard(key: string): void;
}

/**
 * The platform's transport adds the real key; the SDK only needs to send
 * something, and Folio's transports never pass this header on.
 */
const KEY_PLACEHOLDER = 'added-by-folio';

/**
 * Requests Folio's transport refused (no key, outside the allow-list) fail
 * at once: thrown from middleware, they are not the connection errors the
 * SDK retries.
 */
const finalTransportErrors: Middleware = async (request, next) => {
  try {
    return await next(request);
  } catch (error) {
    if (error instanceof AiTransportError && error.code !== 'network') {
      throw new AiTransportError(error.code, error.message);
    }
    throw error;
  }
};

/** The official SDK, sending through the platform's transport. */
function createAiClient(ai: AiService): Anthropic {
  return new Anthropic({
    apiKey: KEY_PLACEHOLDER,
    baseURL: AI_API_ORIGIN,
    fetch: (input, init) => ai.fetch(input, init),
    // The page holds no key: the platform adds it outside the page (desktop,
    // extension) or keeps it in memory (development only).
    dangerouslyAllowBrowser: true,
    middleware: [finalTransportErrors],
  });
}

/** The answer's text and citations, from the message streamed so far. */
function answerOf(message: BetaMessage): AnswerPart[] {
  const parts: AnswerPart[] = [];
  for (const block of message.content) {
    if (block.type !== 'text') continue;
    parts.push({ text: block.text, citations: block.citations ?? [] });
  }
  return parts;
}

export const answerText = (answer: readonly AnswerPart[]) =>
  answer.map((part) => part.text).join('');

/**
 * Earlier questions and answers to send again. Only answers that exist as
 * text count (a stopped answer keeps what arrived); refused and failed
 * questions are left out, so the conversation never repeats them. Answers
 * are repeated as text only: their thinking is bound to the exact request
 * and model that produced it, and questions about a document do not need it.
 */
export function historyOf(turns: readonly AiTurn[]): AiExchange[] {
  const history: AiExchange[] = [];
  for (const turn of turns) {
    if (turn.status !== 'done' && turn.status !== 'stopped') continue;
    const answer = answerText(turn.answer);
    if (answer.trim()) history.push({ question: turn.question, answer });
  }
  return history;
}

const usageOf = (message: BetaMessage): AiUsage => ({
  input: message.usage.input_tokens,
  cacheRead: message.usage.cache_read_input_tokens ?? 0,
  cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
  output: message.usage.output_tokens,
});

export const isBusy = (conversation: AiConversation | undefined) =>
  !!conversation &&
  (conversation.preparing !== null || conversation.turns.at(-1)?.status === 'answering');

export function createAiConversations(
  workspace: WorkspaceStore,
  ai: AiService,
  client: Anthropic = createAiClient(ai),
): AiConversations {
  const store = createStore<ConversationsState>()(() => ({ conversations: {} }));
  const running = new Map<string, AbortController>();
  let nextTurn = 1;

  const get = (key: string) => store.getState().conversations[key];
  const update = (key: string, change: (conversation: AiConversation) => AiConversation) => {
    const conversation = get(key);
    if (!conversation) return;
    store.setState({
      conversations: { ...store.getState().conversations, [key]: change(conversation) },
    });
  };
  const updateTurn = (key: string, id: number, change: Partial<AiTurn>) =>
    update(key, (conversation) => ({
      ...conversation,
      turns: conversation.turns.map((turn) => (turn.id === id ? { ...turn, ...change } : turn)),
    }));
  const discard = (key: string) => {
    running.get(key)?.abort();
    running.delete(key);
    const conversations = { ...store.getState().conversations };
    delete conversations[key];
    store.setState({ conversations });
  };

  // A closed document takes its conversation with it.
  workspace.subscribe((state) => {
    for (const key of Object.keys(store.getState().conversations)) {
      if (!state.documents.some((doc) => doc.key === key)) discard(key);
    }
  });

  /** Reads and counts the document for the first question; null when it cannot be sent. */
  async function prepare(key: string, question: string, signal: AbortSignal) {
    const conversation = get(key)!;
    update(key, (current) => ({ ...current, preparing: 'reading', problem: null }));
    const document = await readDocumentText(workspace, key, conversation.positions, signal);
    if (!document || signal.aborted) return null;
    if (document.pages.length === 0) {
      update(key, (current) => ({
        ...current,
        preparing: null,
        problem: { kind: 'no-text', pagesRead: document.pagesRead },
      }));
      return null;
    }
    if (documentBytes(document) > AI_MAX_BODY_BYTES) {
      update(key, (current) => ({
        ...current,
        preparing: null,
        problem: { kind: 'too-large', tokens: null },
      }));
      return null;
    }
    // Never cut a document down silently: count first, and refuse with the
    // count when it is too large, so the user can choose fewer pages.
    update(key, (current) => ({ ...current, preparing: 'counting' }));
    const counted = await client.beta.messages.countTokens(
      countParams(conversation.model, document, question),
      { signal },
    );
    if (counted.input_tokens > DOCUMENT_TOKEN_LIMIT) {
      update(key, (current) => ({
        ...current,
        preparing: null,
        problem: { kind: 'too-large', tokens: counted.input_tokens },
      }));
      return null;
    }
    update(key, (current) => ({
      ...current,
      document,
      tokens: counted.input_tokens,
      preparing: null,
    }));
    return document;
  }

  async function ask(key: string, question: string) {
    const conversation = get(key);
    if (!conversation || isBusy(conversation) || !question.trim()) return;
    const controller = new AbortController();
    running.set(key, controller);
    const { signal } = controller;
    let turnId: number | null = null;
    try {
      const document = conversation.document ?? (await prepare(key, question, signal));
      if (!document || signal.aborted) return;
      const history = historyOf(get(key)!.turns);
      const id = nextTurn++;
      turnId = id;
      update(key, (current) => ({
        ...current,
        turns: [
          ...current.turns,
          {
            id,
            question,
            answer: [],
            status: 'answering',
            cutOff: false,
            failure: null,
            answeredBy: null,
            usage: null,
          },
        ],
      }));
      const stream = client.beta.messages.stream(
        askParams(conversation.model, document, history, question),
        { signal },
      );
      stream.on('streamEvent', (_event, snapshot) => {
        if (!signal.aborted) updateTurn(key, id, { answer: answerOf(snapshot) });
      });
      const message = await stream.finalMessage();
      if (signal.aborted) return;
      // Check why it stopped before using the content: a refusal can come
      // after part of an answer, which is then not to be trusted.
      const refused = message.stop_reason === 'refusal';
      updateTurn(key, id, {
        answer: refused ? [] : answerOf(message),
        status: refused ? 'refused' : 'done',
        cutOff: message.stop_reason === 'max_tokens',
        answeredBy: message.model !== conversation.model ? message.model : null,
        usage: usageOf(message),
      });
    } catch (error) {
      if (signal.aborted) return;
      const failure = describeAiError(error);
      if (turnId === null) {
        update(key, (current) => ({
          ...current,
          preparing: null,
          problem: { kind: 'failed', failure },
        }));
      } else {
        updateTurn(key, turnId, { status: 'failed', failure });
      }
    } finally {
      if (signal.aborted && get(key)) {
        update(key, (current) => ({
          ...current,
          preparing: null,
          turns: current.turns.map((turn) =>
            turn.id === turnId && turn.status === 'answering'
              ? { ...turn, status: 'stopped' }
              : turn,
          ),
        }));
      }
      if (running.get(key) === controller) running.delete(key);
    }
  }

  return {
    store,
    start(key, model, positions) {
      discard(key);
      store.setState({
        conversations: {
          ...store.getState().conversations,
          [key]: {
            model,
            positions: [...new Set(positions)].sort((a, b) => a - b),
            document: null,
            tokens: null,
            turns: [],
            preparing: null,
            problem: null,
          },
        },
      });
    },
    ask,
    stop(key) {
      running.get(key)?.abort();
    },
    discard,
  };
}

const byWorkspace = new WeakMap<WorkspaceStore, AiConversations>();

/** The conversations of a workspace (one per open document), created on first use. */
export function aiConversationsFor(workspace: WorkspaceStore, ai: AiService): AiConversations {
  let conversations = byWorkspace.get(workspace);
  if (!conversations) {
    conversations = createAiConversations(workspace, ai);
    byWorkspace.set(workspace, conversations);
  }
  return conversations;
}
