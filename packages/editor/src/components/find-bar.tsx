import { cn, ICON, IconButton } from '@folio/shared-ui';
import { CaseSensitive, ChevronDown, ChevronUp, List, Search, WholeWord, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { COMMAND_SHORTCUTS } from '../commands';
import { useUi, useWorkspace, useWorkspaceContext } from '../context';
import type { WorkspaceDocument } from '../store/workspace';
import { searchSummary } from './results-panel';

export const FIND_INPUT_ID = 'folio-find-input';
/** Typing pauses this long before the document is searched again. */
const SEARCH_DELAY_MS = 160;

function Toggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <IconButton label={label} size="icon-sm" pressed={pressed} onClick={onToggle} icon={children} />
  );
}

export function FindBar({ doc, onClose }: { doc: WorkspaceDocument; onClose(): void }) {
  const { profile, shortcutPlatform } = useWorkspaceContext();
  const setSearch = useWorkspace((state) => state.setSearch);
  const stepSearch = useWorkspace((state) => state.stepSearch);
  const showSidebar = useUi((state) => state.showSidebar);
  const { search } = doc;
  const [text, setText] = useState(search.query);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shortcuts = COMMAND_SHORTCUTS[profile];

  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (value: string) => {
    clearTimeout(timer.current);
    if (value !== search.query) setSearch(doc.key, { query: value });
  };

  const onChange = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSearch(doc.key, { query: value }), SEARCH_DELAY_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearTimeout(timer.current);
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (text !== search.query) commit(text);
      else stepSearch(doc.key, event.shiftKey ? -1 : 1);
    }
  };

  const count = search.matches.length;
  const hasQuery = search.query.trim().length > 0;
  const position =
    search.active >= 0 && count > 0
      ? `${(search.active + 1).toLocaleString()} of ${count.toLocaleString()}${search.truncated ? '+' : ''}`
      : null;
  const summary = hasQuery ? (position ?? searchSummary(doc)) : '';
  // Announce the outcome once, not every progress step or stale results while typing.
  const announcement =
    hasQuery && search.status === 'done' && text === search.query
      ? count === 0
        ? 'No results'
        : `${count.toLocaleString()} ${count === 1 ? 'result' : 'results'}`
      : '';

  return (
    <div
      role="search"
      aria-label="Find in document"
      className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1.5"
    >
      {/* In a narrow window the buttons wrap below the field instead of squeezing it. */}
      <label className="flex h-7 min-w-44 flex-1 items-center gap-2 rounded-md bg-raised px-2 shadow-[inset_0_0_0_1px_var(--folio-border-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--folio-focus)] sm:max-w-80">
        <Search
          size={ICON.sm}
          strokeWidth={ICON.stroke}
          aria-hidden
          className="shrink-0 text-ink-muted"
        />
        <span className="sr-only">Find in document</span>
        <input
          id={FIND_INPUT_ID}
          type="search"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={text}
          placeholder="Find in document"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle [&::-webkit-search-cancel-button]:hidden"
        />
        <span
          className={cn(
            'shrink-0 text-2xs tabular',
            hasQuery && search.status === 'done' && count === 0
              ? 'text-danger-ink'
              : 'text-ink-muted',
          )}
        >
          {summary}
        </span>
      </label>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label="Previous result"
          size="icon-sm"
          icon={<ChevronUp size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          disabled={count === 0}
          onClick={() => stepSearch(doc.key, -1)}
          shortcut={{ keys: shortcuts['find-previous'][0]!, platform: shortcutPlatform }}
        />
        <IconButton
          label="Next result"
          size="icon-sm"
          icon={<ChevronDown size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          disabled={count === 0}
          onClick={() => stepSearch(doc.key, 1)}
          shortcut={{ keys: shortcuts['find-next'][0]!, platform: shortcutPlatform }}
        />
        <span aria-hidden className="mx-1 h-5 w-px bg-line" />
        <Toggle
          label="Match case"
          pressed={search.options.matchCase}
          onToggle={() =>
            setSearch(doc.key, { query: text, options: { matchCase: !search.options.matchCase } })
          }
        >
          <CaseSensitive size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
        </Toggle>
        <Toggle
          label="Whole words"
          pressed={search.options.wholeWords}
          onToggle={() =>
            setSearch(doc.key, { query: text, options: { wholeWords: !search.options.wholeWords } })
          }
        >
          <WholeWord size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
        </Toggle>
        <IconButton
          label="Show all results"
          size="icon-sm"
          icon={<List size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          onClick={() => {
            commit(text);
            showSidebar('results');
          }}
        />
        <IconButton
          label="Close find bar"
          size="icon-sm"
          icon={<X size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          onClick={onClose}
        />
      </div>
    </div>
  );
}
