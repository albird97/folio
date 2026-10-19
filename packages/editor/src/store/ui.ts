import { isThemePreference, type ThemePreference } from '@folio/shared-ui';
import type { FontFamily, HexColor, PageId, Rect } from '@folio/document-model';
import type {
  IncomingFile,
  KeyValueStorage,
  OpenUrlErrorCode,
  RecoveryRecord,
  TransferRequest,
} from '@folio/platform-adapters';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SignatureImage } from '../signature/render';
import { isOcrLanguage, type OcrLanguage } from '../ocr/languages';
import { DEFAULT_AI_MODEL, isAiModel, type AiModel } from '../ai/models';

export type SidebarTab = 'pages' | 'outline' | 'comments' | 'results';
export const SIDEBAR_TABS: readonly SidebarTab[] = ['pages', 'outline', 'comments', 'results'];

/** What a pointer does on the pages. */
export type Tool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'note'
  | 'ink'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'image'
  /** Places the signature chosen in the signature dialog (`pendingSignature`). */
  | 'signature';

export const TOOLS: readonly Tool[] = [
  'select',
  'highlight',
  'underline',
  'strikeout',
  'note',
  'ink',
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'text',
  'image',
  'signature',
];

/** Tools that mark text selected in the page's text layer. */
export const MARKUP_TOOLS: ReadonlySet<Tool> = new Set(['highlight', 'underline', 'strikeout']);

/** Colours and sizes new annotations get; remembered between sessions. */
export interface AnnotationStyle {
  colors: Record<Exclude<Tool, 'select' | 'image' | 'signature'>, HexColor>;
  /** Pen and outline width, in points. */
  strokeWidth: number;
  fontSize: number;
  fontFamily: FontFamily;
  /** Fill of new rectangles and ellipses, or null for none. */
  fill: HexColor | null;
}

export const DEFAULT_STYLE: AnnotationStyle = {
  colors: {
    highlight: '#ffd43b',
    underline: '#1c7ed6',
    strikeout: '#e03131',
    note: '#ffd43b',
    ink: '#e03131',
    rectangle: '#e03131',
    ellipse: '#e03131',
    line: '#e03131',
    arrow: '#e03131',
    text: '#1f2328',
  },
  strokeWidth: 2,
  fontSize: 14,
  fontFamily: 'sans',
  fill: null,
};

/** Swatches offered for annotation colours. */
export const SWATCHES: readonly HexColor[] = [
  '#ffd43b',
  '#ff922b',
  '#e03131',
  '#e64980',
  '#7048e8',
  '#1c7ed6',
  '#0ca678',
  '#1f2328',
  '#868e96',
  '#ffffff',
];

/** A dialog the workspace shows (one at a time). */
export type DialogRequest =
  | {
      kind: 'insert-password';
      docKey: string;
      file: IncomingFile;
      /** Where the pages go. */
      index: number;
      rejected: boolean;
      /** Files still to insert after this one. */
      rest: IncomingFile[];
    }
  | { kind: 'split'; docKey: string }
  | { kind: 'close-document'; docKey: string }
  /** The file changed on disk since Folio read it. */
  | {
      kind: 'save-conflict';
      docKey: string;
      resolve(choice: 'overwrite' | 'save-as' | 'cancel'): void;
    }
  /** The window is closing with unsaved changes. */
  | { kind: 'quit'; resolve(close: boolean): void }
  /** Unsaved work kept from an earlier session. */
  | { kind: 'recover'; records: RecoveryRecord[] }
  | { kind: 'print'; docKey: string }
  /** The Chrome extension could not reach the desktop app: how to set it up. */
  | { kind: 'desktop-missing' }
  /** `url` and `error` show an address that failed to open (e.g. from the toolbar popup). */
  | {
      kind: 'open-url';
      url?: string;
      error?: { code: OpenUrlErrorCode; message: string };
    }
  // Tools. Each works on one open document.
  | {
      kind: 'signature';
      docKey: string;
      /** A signature field to sign: the signature goes into its box (page space). */
      field?: { pageId: PageId; rect: Rect };
    }
  | { kind: 'page-numbers'; docKey: string }
  | { kind: 'watermark'; docKey: string }
  | { kind: 'recognize-text'; docKey: string }
  | { kind: 'export-images'; docKey: string }
  | { kind: 'export-text'; docKey: string }
  | { kind: 'reduce-file-size'; docKey: string }
  | { kind: 'protect'; docKey: string }
  | { kind: 'ask-ai'; docKey: string };

/** The request of one kind of dialog. */
export type DialogOf<K extends DialogRequest['kind']> = Extract<DialogRequest, { kind: K }>;

/** Commands that open a tool's dialog for the active document. */
export const TOOL_DIALOGS = [
  'sign',
  'page-numbers',
  'watermark',
  'recognize-text',
  'export-images',
  'export-text',
  'reduce-file-size',
  'protect',
  'ask-ai',
] as const;

export type ToolDialogCommand = (typeof TOOL_DIALOGS)[number];

/** The dialog each tool command opens. */
export const TOOL_DIALOG_KINDS = {
  sign: 'signature',
  'page-numbers': 'page-numbers',
  watermark: 'watermark',
  'recognize-text': 'recognize-text',
  'export-images': 'export-images',
  'export-text': 'export-text',
  'reduce-file-size': 'reduce-file-size',
  protect: 'protect',
  'ask-ai': 'ask-ai',
} as const satisfies Record<ToolDialogCommand, DialogRequest['kind']>;

/** A signature chosen in the signature dialog, to place in the document it was chosen for. */
export interface PendingSignature {
  docKey: string;
  image: SignatureImage;
}

/**
 * Ask Claude's settings. Only the user's consent and model choice are kept
 * here; the API key stays with the platform (keychain, extension storage).
 */
export interface AiSettings {
  /** The user turned Ask Claude on and agreed to send document text when they ask. */
  enabled: boolean;
  model: AiModel;
}

export const DEFAULT_AI_SETTINGS: AiSettings = { enabled: false, model: DEFAULT_AI_MODEL };

/** Workspace chrome state. Persisted per installation; never part of a document. */
export interface UiState {
  theme: ThemePreference;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  sidebarTab: SidebarTab;
  tool: Tool;
  /**
   * The signature the Signature tool places, held in memory only (never
   * stored); null with every other tool.
   */
  pendingSignature: PendingSignature | null;
  style: AnnotationStyle;
  /** Written into new annotations as their author; empty leaves it out. */
  authorName: string;
  /** Tint the fields of forms that can be filled in. */
  highlightFields: boolean;
  /** The languages text was last recognized in (never empty). */
  ocrLanguages: OcrLanguage[];
  ai: AiSettings;
  dialog: DialogRequest | null;
  /** Documents the Chrome extension sent, waiting for the user to accept them. */
  transfers: TransferRequest[];
  hydrated: boolean;
  setTheme(theme: ThemePreference): void;
  toggleLeftPanel(): void;
  toggleRightPanel(): void;
  /** Shows the sidebar on the given tab. */
  showSidebar(tab: SidebarTab): void;
  setSidebarTab(tab: SidebarTab): void;
  /** Picks a tool; another tool drops the signature being placed. */
  setTool(tool: Tool): void;
  /** Picks the Signature tool to place `signature` on a page. */
  startPlacingSignature(signature: PendingSignature): void;
  setStyle(changes: Partial<Omit<AnnotationStyle, 'colors'>>): void;
  setToolColor(tool: keyof AnnotationStyle['colors'], color: HexColor): void;
  setAuthorName(name: string): void;
  setHighlightFields(highlight: boolean): void;
  setOcrLanguages(languages: OcrLanguage[]): void;
  setAiSettings(changes: Partial<AiSettings>): void;
  openDialog(dialog: DialogRequest): void;
  closeDialog(): void;
  queueTransfer(request: TransferRequest): void;
  finishTransfer(id: string): void;
}

type Persisted = Pick<
  UiState,
  | 'theme'
  | 'leftPanelOpen'
  | 'rightPanelOpen'
  | 'sidebarTab'
  | 'style'
  | 'authorName'
  | 'highlightFields'
  | 'ocrLanguages'
  | 'ai'
>;

export const UI_STORAGE_KEY = 'workspace-ui';

const isColor = (value: unknown): value is HexColor =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

function sanitizeStyle(value: unknown): AnnotationStyle | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const colors = { ...DEFAULT_STYLE.colors };
  if (typeof raw.colors === 'object' && raw.colors !== null) {
    for (const key of Object.keys(colors) as Array<keyof AnnotationStyle['colors']>) {
      const color = (raw.colors as Record<string, unknown>)[key];
      if (isColor(color)) colors[key] = color;
    }
  }
  const number = (input: unknown, min: number, max: number, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input)
      ? Math.min(max, Math.max(min, input))
      : fallback;
  return {
    colors,
    strokeWidth: number(raw.strokeWidth, 0.5, 24, DEFAULT_STYLE.strokeWidth),
    fontSize: number(raw.fontSize, 4, 144, DEFAULT_STYLE.fontSize),
    fontFamily:
      raw.fontFamily === 'serif' || raw.fontFamily === 'mono' || raw.fontFamily === 'sans'
        ? raw.fontFamily
        : DEFAULT_STYLE.fontFamily,
    fill: isColor(raw.fill) ? raw.fill : null,
  };
}

function sanitize(value: unknown): Partial<Persisted> {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<Persisted> = {};
  if (isThemePreference(raw.theme)) out.theme = raw.theme;
  if (typeof raw.leftPanelOpen === 'boolean') out.leftPanelOpen = raw.leftPanelOpen;
  if (typeof raw.rightPanelOpen === 'boolean') out.rightPanelOpen = raw.rightPanelOpen;
  if (SIDEBAR_TABS.includes(raw.sidebarTab as SidebarTab))
    out.sidebarTab = raw.sidebarTab as SidebarTab;
  const style = sanitizeStyle(raw.style);
  if (style) out.style = style;
  if (typeof raw.authorName === 'string') out.authorName = raw.authorName.slice(0, 200);
  if (typeof raw.highlightFields === 'boolean') out.highlightFields = raw.highlightFields;
  if (Array.isArray(raw.ocrLanguages)) {
    const languages = [...new Set(raw.ocrLanguages.filter(isOcrLanguage))];
    if (languages.length > 0) out.ocrLanguages = languages;
  }
  if (typeof raw.ai === 'object' && raw.ai !== null) {
    const ai = raw.ai as Record<string, unknown>;
    out.ai = {
      enabled: ai.enabled === true,
      model: isAiModel(ai.model) ? ai.model : DEFAULT_AI_MODEL,
    };
  }
  return out;
}

const persistedOf = (state: UiState): Persisted => ({
  theme: state.theme,
  leftPanelOpen: state.leftPanelOpen,
  rightPanelOpen: state.rightPanelOpen,
  sidebarTab: state.sidebarTab,
  style: state.style,
  authorName: state.authorName,
  highlightFields: state.highlightFields,
  ocrLanguages: state.ocrLanguages,
  ai: state.ai,
});

/** A question still waiting when its dialog goes away gets the cautious answer. */
function settle(dialog: DialogRequest | null): void {
  if (dialog?.kind === 'save-conflict') dialog.resolve('cancel');
  if (dialog?.kind === 'quit') dialog.resolve(false);
}

export function createUiStore(storage: KeyValueStorage): StoreApi<UiState> {
  const store = createStore<UiState>()((set, get) => ({
    theme: 'system',
    leftPanelOpen: true,
    rightPanelOpen: true,
    sidebarTab: 'pages',
    tool: 'select',
    pendingSignature: null,
    style: DEFAULT_STYLE,
    authorName: '',
    highlightFields: true,
    ocrLanguages: ['eng'],
    ai: DEFAULT_AI_SETTINGS,
    dialog: null,
    transfers: [],
    hydrated: false,
    setTheme: (theme) => set({ theme }),
    toggleLeftPanel: () => set((state) => ({ leftPanelOpen: !state.leftPanelOpen })),
    toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
    showSidebar: (tab) => set({ leftPanelOpen: true, sidebarTab: tab }),
    setSidebarTab: (tab) => set({ sidebarTab: tab }),
    setTool: (tool) =>
      set((state) => {
        // The Signature tool only exists with a signature to place.
        if (tool === 'signature') return state.pendingSignature ? { tool } : state;
        return { tool, pendingSignature: null };
      }),
    startPlacingSignature: (signature) => set({ tool: 'signature', pendingSignature: signature }),
    setStyle: (changes) => set((state) => ({ style: { ...state.style, ...changes } })),
    setToolColor: (tool, color) =>
      set((state) => ({
        style: { ...state.style, colors: { ...state.style.colors, [tool]: color } },
      })),
    setAuthorName: (authorName) => set({ authorName: authorName.slice(0, 200) }),
    setHighlightFields: (highlightFields) => set({ highlightFields }),
    setOcrLanguages: (languages) => {
      if (languages.length > 0) set({ ocrLanguages: [...new Set(languages)] });
    },
    setAiSettings: (changes) => set((state) => ({ ai: { ...state.ai, ...changes } })),
    openDialog: (dialog) => {
      settle(get().dialog);
      set({ dialog });
    },
    closeDialog: () => {
      settle(get().dialog);
      set({ dialog: null });
    },
    queueTransfer: (request) =>
      set((state) =>
        state.transfers.some((entry) => entry.id === request.id)
          ? state
          : { transfers: [...state.transfers, request] },
      ),
    finishTransfer: (id) =>
      set((state) => ({ transfers: state.transfers.filter((entry) => entry.id !== id) })),
  }));

  void storage.get<unknown>(UI_STORAGE_KEY).then((stored) => {
    store.setState({ ...sanitize(stored), hydrated: true });
    // Follow changes from other pages (e.g. the extension's options page).
    // Watchers also hear this page's own writes, sometimes after a newer
    // change: echoes of this page's writes are recognised and skipped (or a
    // late echo would briefly undo a newer change), and applied values are
    // never written back (or two pages would keep overwriting each other).
    let applyingStored = false;
    const unechoedWrites: string[] = [];
    storage.watch?.(UI_STORAGE_KEY, (value) => {
      const echo = unechoedWrites.indexOf(JSON.stringify(value));
      if (echo !== -1) {
        unechoedWrites.splice(0, echo + 1);
        return;
      }
      const next = sanitize(value);
      const current = persistedOf(store.getState());
      if (
        (Object.keys(next) as Array<keyof Persisted>).some(
          (key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]),
        )
      ) {
        applyingStored = true;
        try {
          store.setState(next);
        } finally {
          applyingStored = false;
        }
      }
    });
    store.subscribe((state, previous) => {
      if (applyingStored) return;
      const persisted = persistedOf(state);
      const before = persistedOf(previous);
      if (
        (Object.keys(persisted) as Array<keyof Persisted>).every(
          (key) => persisted[key] === before[key],
        )
      ) {
        return;
      }
      if (storage.watch) {
        unechoedWrites.push(JSON.stringify(persisted));
        // Storage only echoes real changes, so drop entries that never come back.
        if (unechoedWrites.length > 20) unechoedWrites.shift();
      }
      void storage.set<Persisted>(UI_STORAGE_KEY, persisted);
    });
  });

  return store;
}
