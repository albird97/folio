import type { RuntimeFeatures } from './types';

/**
 * The single source of truth for what Folio supports where.
 * `PLATFORM_CAPABILITIES.md` is generated from this file
 * (`pnpm capabilities:generate`) and a test fails when they drift.
 *
 * Rule: a feature is only "full" when it works end to end for users on that
 * target, not when a button exists.
 */
export type ProductTarget = 'macos' | 'windows' | 'chrome';
export type SupportLevel = 'full' | 'limited' | 'external-service' | 'none';

export interface TargetSupport {
  level: SupportLevel;
  note?: string;
}

export interface FeatureCapability {
  id: string;
  area: string;
  feature: string;
  /** Phase in IMPLEMENTATION_PLAN.md that completes the feature; null when done or never. */
  plannedPhase: number | null;
  targets: Record<ProductTarget, TargetSupport>;
  /** How support was verified. */
  verification: string;
  /**
   * Runtime flag(s) that adapters must report consistently with this row:
   * the feature counts as available when any of them is true.
   */
  runtimeFeature?: keyof RuntimeFeatures | ReadonlyArray<keyof RuntimeFeatures>;
}

const full = (note?: string): TargetSupport => (note ? { level: 'full', note } : { level: 'full' });
const limited = (note: string): TargetSupport => ({ level: 'limited', note });
const none = (note?: string): TargetSupport => (note ? { level: 'none', note } : { level: 'none' });
const all = (support: TargetSupport): Record<ProductTarget, TargetSupport> => ({
  macos: support,
  windows: support,
  chrome: support,
});

type DesktopTarget = Exclude<ProductTarget, 'chrome'>;
const REAL_MACHINE: Record<DesktopTarget, string> = {
  macos: 'a real Mac',
  windows: 'a real Windows PC',
};

/**
 * A native integration that compiles in the macOS and Windows CI builds but
 * that no test or person has used on that OS yet. It stays Limited until it
 * has been tried on a real machine (Phase 4).
 */
const unverified = (target: DesktopTarget, note: string): TargetSupport =>
  limited(`${note} Implemented and built in CI, but not yet verified on ${REAL_MACHINE[target]}.`);

const SHORTCUTS = 'Open, close document, next/previous document, Pages panel and Properties panel';
const NO_THEME_SHORTCUT = 'Switching the theme has no shortcut.';

export const CAPABILITY_MATRIX: readonly FeatureCapability[] = [
  // Opening documents
  {
    id: 'open-picker',
    area: 'Opening documents',
    feature: 'Open a PDF with a file picker',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        'Native dialog shown by the Rust layer; the webview only receives tokens and file names.',
      ),
      windows: unverified(
        'windows',
        'Native dialog shown by the Rust layer; the webview only receives tokens and file names.',
      ),
      chrome: full(
        'Picker in the editor page and side panel. The popup hands off to the editor because Chrome closes popups when a file dialog opens.',
      ),
    },
    verification:
      'Extension and desktop UI (web adapter): Playwright e2e. Native dialog: Rust unit tests for granting the chosen files; the dialog itself cannot be automated.',
  },
  {
    id: 'open-drag-drop',
    area: 'Opening documents',
    feature: 'Open PDFs by drag and drop',
    plannedPhase: 4,
    targets: {
      macos: unverified('macos', 'Dropped files are granted by the native layer.'),
      windows: unverified('windows', 'Dropped files are granted by the native layer.'),
      chrome: full('Drop onto the editor page or the side panel.'),
    },
    verification:
      'Extension and desktop UI (web adapter): Playwright e2e. Native drops: Rust unit tests for grant filtering and the drag-hover signal.',
    runtimeFeature: ['nativeDragAndDrop', 'webDragAndDrop'],
  },
  {
    id: 'open-file-association',
    area: 'Opening documents',
    feature: 'Open from Finder / File Explorer (file association)',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        'Handles Finder “Open With” events once the app bundle is installed; Folio is registered as an alternate PDF handler.',
      ),
      windows: unverified(
        'windows',
        'Opens a PDF passed on launch. Opening another file while Folio runs starts a second window until single-instance support lands.',
      ),
      chrome: none('Extensions cannot register as the operating system’s PDF handler.'),
    },
    verification:
      'Launch-argument opening: tauri-driver e2e against the real binary on Linux. Finder events and Explorer registration: compiled in CI only.',
    runtimeFeature: 'fileAssociations',
  },
  {
    id: 'open-password',
    area: 'Opening documents',
    feature: 'Open password-protected PDFs',
    plannedPhase: null,
    targets: all(
      full(
        'Standard security handler: AES-256 and legacy 128-bit RC4, both tested. The password is only kept in memory.',
      ),
    ),
    verification: 'Unit tests with qpdf-encrypted fixtures; extension e2e.',
  },
  {
    id: 'open-errors',
    area: 'Opening documents',
    feature: 'Clear errors for damaged, empty or non-PDF files',
    plannedPhase: null,
    targets: all(full()),
    verification: 'Unit tests with invalid fixtures; e2e for the error state.',
  },
  {
    id: 'multi-document',
    area: 'Opening documents',
    feature: 'Multiple documents in tabs',
    plannedPhase: null,
    targets: {
      macos: full(),
      windows: full(),
      chrome: full('Tabs inside the editor page; each browser tab is its own workspace.'),
    },
    verification: 'Desktop UI and extension e2e.',
  },
  {
    id: 'document-properties',
    area: 'Opening documents',
    feature: 'Document properties (metadata, page sizes, security)',
    plannedPhase: null,
    targets: all(full()),
    verification: 'Unit tests (metadata normalization) and e2e.',
  },
  {
    id: 'open-current-tab',
    area: 'Opening documents',
    feature: 'Open the PDF in the current browser tab',
    plannedPhase: 5,
    targets: { macos: none('Not applicable.'), windows: none('Not applicable.'), chrome: none() },
    verification: '—',
    runtimeFeature: 'browserTabIntegration',
  },
  {
    id: 'open-url',
    area: 'Opening documents',
    feature: 'Open a PDF from a URL',
    plannedPhase: 5,
    targets: all(none()),
    verification: '—',
  },
  // Viewing
  {
    id: 'render-pages',
    area: 'Viewing',
    feature: 'Render pages',
    plannedPhase: 2,
    targets: all(
      limited(
        'Single-page preview of the selected page. The continuous, virtualized viewer arrives in Phase 2.',
      ),
    ),
    verification:
      'E2E in Chromium (extension, desktop UI) and in WebKitGTK through the real desktop binary (tauri-driver).',
  },
  {
    id: 'thumbnails',
    area: 'Viewing',
    feature: 'Page thumbnails and navigation',
    plannedPhase: 2,
    targets: all(
      limited('The Pages panel lists every page with its size and rotation; no thumbnails yet.'),
    ),
    verification: 'E2E.',
  },
  {
    id: 'search',
    area: 'Viewing',
    feature: 'Text search',
    plannedPhase: 2,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'zoom-rotate-view',
    area: 'Viewing',
    feature: 'Zoom, fit-to-page and view rotation',
    plannedPhase: 2,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'text-selection',
    area: 'Viewing',
    feature: 'Text selection and copying',
    plannedPhase: 2,
    targets: all(none()),
    verification: '—',
  },
  // Editing
  {
    id: 'markup',
    area: 'Editing',
    feature: 'Highlight, underline, strikethrough and comments',
    plannedPhase: 3,
    targets: all(none('Annotation types exist in the shared document model.')),
    verification: 'Model unit tests only.',
  },
  {
    id: 'drawing',
    area: 'Editing',
    feature: 'Freehand drawing and shapes',
    plannedPhase: 3,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'added-text',
    area: 'Editing',
    feature: 'Add text (new content on top of the page)',
    plannedPhase: 3,
    targets: all(
      none(
        'Adds new text objects; editing the PDF’s existing text is a separate, later capability.',
      ),
    ),
    verification: '—',
  },
  {
    id: 'added-images',
    area: 'Editing',
    feature: 'Add images',
    plannedPhase: 3,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'undo-redo',
    area: 'Editing',
    feature: 'Undo and redo',
    plannedPhase: 3,
    targets: all(
      none(
        'Operation-based history is implemented and tested in the shared core; no editing UI uses it yet.',
      ),
    ),
    verification: 'Model unit tests.',
  },
  {
    id: 'page-operations',
    area: 'Editing',
    feature: 'Insert, delete, duplicate, extract and reorder pages',
    plannedPhase: 3,
    targets: all(none('Model operations exist; writing the result to a PDF does not.')),
    verification: 'Model unit tests.',
  },
  {
    id: 'merge-split',
    area: 'Editing',
    feature: 'Merge and split',
    plannedPhase: 3,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'metadata-edit',
    area: 'Editing',
    feature: 'Edit metadata',
    plannedPhase: 3,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'watermarks',
    area: 'Editing',
    feature: 'Page numbers and watermarks',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  // Saving & export
  {
    id: 'save',
    area: 'Saving and export',
    feature: 'Save and Save As',
    plannedPhase: 4,
    targets: {
      macos: none(),
      windows: none(),
      chrome: none('Will download a copy; extensions cannot write back to the original file.'),
    },
    verification: '—',
    runtimeFeature: 'saveInPlace',
  },
  {
    id: 'export-pdf',
    area: 'Saving and export',
    feature: 'Export PDF',
    plannedPhase: 2,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'export-images',
    area: 'Saving and export',
    feature: 'Export pages as images',
    plannedPhase: 5,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'extract-text',
    area: 'Saving and export',
    feature: 'Extract text',
    plannedPhase: 5,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'printing',
    area: 'Saving and export',
    feature: 'Print',
    plannedPhase: 4,
    targets: all(none()),
    verification: '—',
    runtimeFeature: 'printing',
  },
  {
    id: 'webpage-to-pdf',
    area: 'Saving and export',
    feature: 'Save the current webpage as PDF',
    plannedPhase: 5,
    targets: { macos: none('Not applicable.'), windows: none('Not applicable.'), chrome: none() },
    verification: '—',
  },
  // Advanced
  {
    id: 'forms',
    area: 'Advanced tools',
    feature: 'Fill forms',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'signatures',
    area: 'Advanced tools',
    feature: 'Place signatures',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'ocr',
    area: 'Advanced tools',
    feature: 'OCR',
    plannedPhase: 6,
    targets: all(none('Planned as a bundled, on-device engine; no cloud OCR by default.')),
    verification: '—',
  },
  {
    id: 'password-protect',
    area: 'Advanced tools',
    feature: 'Add password protection',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'compression',
    area: 'Advanced tools',
    feature: 'Compress PDFs',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  // App & platform
  {
    id: 'native-menus',
    area: 'App and platform',
    feature: 'Native menus',
    plannedPhase: 4,
    targets: {
      macos: unverified('macos', 'Folio (app), File, Edit, View and Window menus.'),
      windows: unverified('windows', 'File, Edit, View and Help menus in the window menu bar.'),
      chrome: none('Not applicable.'),
    },
    verification:
      'Rust unit tests for command forwarding on Linux, macOS and Windows CI runners. No test builds or uses the menus.',
    runtimeFeature: 'nativeMenus',
  },
  {
    id: 'shortcuts',
    area: 'App and platform',
    feature: 'Keyboard shortcuts',
    plannedPhase: 4,
    targets: {
      macos: unverified('macos', `${SHORTCUTS}, plus Close Window. ${NO_THEME_SHORTCUT}`),
      windows: unverified('windows', `${SHORTCUTS}. ${NO_THEME_SHORTCUT}`),
      chrome: limited(
        `${SHORTCUTS}. Closing and switching documents use Alt keys because Chrome reserves Ctrl/⌘+W and Ctrl+Tab. ${NO_THEME_SHORTCUT}`,
      ),
    },
    verification:
      'Key matching: unit tests. Browser key set: extension and desktop UI e2e. Desktop key set and menu accelerators: no e2e yet.',
  },
  {
    id: 'themes',
    area: 'App and platform',
    feature: 'Light, dark and system themes',
    plannedPhase: null,
    targets: all(full()),
    verification: 'E2E (including axe checks in both themes).',
  },
  {
    id: 'clipboard',
    area: 'App and platform',
    feature: 'Clipboard',
    plannedPhase: 4,
    targets: all(
      limited(
        'Copying document property values. Page content copying arrives with text selection.',
      ),
    ),
    verification: 'E2E.',
    runtimeFeature: 'clipboardWrite',
  },
  {
    id: 'recovery',
    area: 'App and platform',
    feature: 'Autosave and crash recovery',
    plannedPhase: 4,
    targets: all(none('The validated recovery snapshot format exists in the shared core.')),
    verification: 'Serialization unit tests.',
  },
  {
    id: 'auto-update',
    area: 'App and platform',
    feature: 'Automatic updates',
    plannedPhase: 7,
    targets: {
      macos: none('Requires an updater signing key and a release feed.'),
      windows: none('Requires an updater signing key and a release feed.'),
      chrome: none('Will be handled by the Chrome Web Store once published.'),
    },
    verification: '—',
  },
  {
    id: 'installers',
    area: 'App and platform',
    feature: 'Installers',
    plannedPhase: 4,
    targets: {
      macos: limited(
        'Unsigned .app/.dmg; Developer ID signing and notarization need Apple credentials.',
      ),
      windows: limited('Unsigned NSIS .exe and .msi; Authenticode signing needs a certificate.'),
      chrome: limited('Unpacked build and a Web Store zip; not yet published.'),
    },
    verification: 'CI release builds on macOS and Windows runners (see README).',
  },
  {
    id: 'native-messaging',
    area: 'App and platform',
    feature: 'Send documents between the extension and the desktop app',
    plannedPhase: 5,
    targets: all(none()),
    verification: '—',
    runtimeFeature: 'nativeMessaging',
  },
  // Extension surfaces
  {
    id: 'extension-popup',
    area: 'Chrome extension',
    feature: 'Toolbar popup with quick actions and recent activity',
    plannedPhase: null,
    targets: { macos: none('Not applicable.'), windows: none('Not applicable.'), chrome: full() },
    verification: 'Extension e2e.',
  },
  {
    id: 'extension-side-panel',
    area: 'Chrome extension',
    feature: 'Side panel',
    plannedPhase: 5,
    targets: {
      macos: none('Not applicable.'),
      windows: none('Not applicable.'),
      chrome: limited(
        'Inspect a local PDF and hand it to the editor. Page tools arrive with Phase 5.',
      ),
    },
    verification: 'Extension e2e.',
  },
  {
    id: 'extension-options',
    area: 'Chrome extension',
    feature: 'Options page with permission explanations',
    plannedPhase: null,
    targets: { macos: none('Not applicable.'), windows: none('Not applicable.'), chrome: full() },
    verification: 'Extension e2e.',
  },
  // Privacy
  {
    id: 'local-first',
    area: 'Privacy',
    feature: 'Local-only processing (no uploads, no analytics on content)',
    plannedPhase: null,
    targets: all(
      full(
        'No network requests are made with document data; the extension has no host permissions.',
      ),
    ),
    verification:
      'Extension: e2e asserts no host permissions, no network requests while opening a document and that the CSP blocks requests to other servers; a unit test checks the CSP. Desktop: the CSP allows only the app itself, checked by tauri-driver e2e.',
  },
];

export const SUPPORT_LABELS: Record<SupportLevel, string> = {
  full: '✅ Full',
  limited: '🟡 Limited',
  'external-service': '☁️ External service',
  none: '⛔ Not supported',
};

export function capability(id: string): FeatureCapability {
  const found = CAPABILITY_MATRIX.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown capability ${id}`);
  return found;
}

/** Lists rows whose level disagrees with what an adapter reports at runtime. */
export function runtimeMismatches(features: RuntimeFeatures, target: ProductTarget): string[] {
  const problems: string[] = [];
  for (const entry of CAPABILITY_MATRIX) {
    if (!entry.runtimeFeature) continue;
    const keys =
      typeof entry.runtimeFeature === 'string' ? [entry.runtimeFeature] : entry.runtimeFeature;
    const supported = entry.targets[target].level !== 'none';
    const reported = keys.some((key) => features[key]);
    if (supported !== reported) {
      problems.push(
        `${entry.id}: matrix says ${entry.targets[target].level} for ${target}, adapter reports ${keys.join('|')}=${reported}`,
      );
    }
  }
  return problems;
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|');
const TARGET_NAMES: Record<ProductTarget, string> = {
  macos: 'macOS',
  windows: 'Windows',
  chrome: 'Chrome',
};
const TARGETS: ProductTarget[] = ['macos', 'windows', 'chrome'];

export function renderCapabilityMarkdown(): string {
  const lines: string[] = [
    '# Folio platform capabilities',
    '',
    '<!-- Generated from packages/platform-adapters/src/capabilities.ts by `pnpm capabilities:generate`. Do not edit by hand. -->',
    '',
    'Every feature is classified per target. A feature is only **Full** when it works end to end for',
    'users on that target — a button existing is not enough. “Phase” is the phase in',
    '[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) that completes the feature. Cells marked † have',
    'a note below the table.',
    '',
    '| Level | Meaning |',
    '| --- | --- |',
    `| ${SUPPORT_LABELS.full} | Works end to end. |`,
    `| ${SUPPORT_LABELS.limited} | Works, with the limitation noted. |`,
    `| ${SUPPORT_LABELS['external-service']} | Requires an optional external service. |`,
    `| ${SUPPORT_LABELS.none} | Not available on this target (yet). |`,
    '',
  ];
  const areas = [...new Set(CAPABILITY_MATRIX.map((entry) => entry.area))];
  for (const area of areas) {
    lines.push(
      `## ${area}`,
      '',
      '| Feature | macOS | Windows | Chrome | Phase | Verification |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    const notes: string[] = [];
    for (const entry of CAPABILITY_MATRIX.filter((row) => row.area === area)) {
      const cells = TARGETS.map((target) => {
        const support = entry.targets[target];
        if (!support.note) return SUPPORT_LABELS[support.level];
        notes.push(`- **${entry.feature} (${TARGET_NAMES[target]}):** ${support.note}`);
        return `${SUPPORT_LABELS[support.level]} †`;
      });
      lines.push(
        `| ${escapeCell(entry.feature)} | ${cells.join(' | ')} | ${entry.plannedPhase ?? '—'} | ${escapeCell(entry.verification)} |`,
      );
    }
    if (notes.length > 0) lines.push('', ...notes);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
