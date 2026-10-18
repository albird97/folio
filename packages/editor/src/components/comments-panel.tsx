import {
  annotationFrame,
  type Annotation,
  type AnnotationId,
  type DocumentModel,
} from '@folio/document-model';
import { cn, ICON } from '@folio/shared-ui';
import {
  ArrowUpRight,
  Circle,
  Highlighter,
  Image,
  Minus,
  PenLine,
  Square,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
} from 'lucide-react';
import { useMemo, type KeyboardEvent } from 'react';
import { useWorkspace } from '../context';
import { formatDate } from '../format';
import type { WorkspaceDocument } from '../store/workspace';
import { EDIT_ANNOTATION_EVENT } from '../viewer/annotation-layer';

const KIND_LABELS: Record<Annotation['kind'], string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikethrough',
  note: 'Note',
  ink: 'Drawing',
  shape: 'Shape',
  'added-text': 'Text',
  'added-image': 'Image',
  signature: 'Signature',
};

/** A short name for an annotation, as lists and the inspector show it. */
export function annotationLabel(annotation: Annotation): string {
  if (annotation.kind === 'shape') {
    return { rectangle: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' }[
      annotation.shape
    ];
  }
  return KIND_LABELS[annotation.kind];
}

export function AnnotationIcon({ annotation }: { annotation: Annotation }) {
  const props = { size: ICON.sm, strokeWidth: ICON.stroke, 'aria-hidden': true } as const;
  switch (annotation.kind) {
    case 'highlight':
      return <Highlighter {...props} />;
    case 'underline':
      return <Underline {...props} />;
    case 'strikeout':
      return <Strikethrough {...props} />;
    case 'note':
      return <StickyNote {...props} />;
    case 'ink':
      return <PenLine {...props} />;
    case 'shape':
      return annotation.shape === 'ellipse' ? (
        <Circle {...props} />
      ) : annotation.shape === 'rectangle' ? (
        <Square {...props} />
      ) : annotation.shape === 'arrow' ? (
        <ArrowUpRight {...props} />
      ) : (
        <Minus {...props} />
      );
    case 'added-text':
      return <Type {...props} />;
    case 'added-image':
    case 'signature':
      return <Image {...props} />;
  }
}

/** What an annotation says, if anything: marked text, a note, added text. */
export function annotationText(annotation: Annotation): string {
  switch (annotation.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return annotation.text;
    case 'note':
      return annotation.contents;
    case 'added-text':
      return annotation.text;
    default:
      return '';
  }
}

/** Annotations in reading order: by page, then top to bottom. */
export function orderedAnnotations(
  model: DocumentModel,
): Array<{ page: number; annotation: Annotation }> {
  const positions = new Map(model.pages.map((page, index) => [page.id, index]));
  return Object.values(model.annotations)
    .map((annotation) => ({ page: positions.get(annotation.pageId) ?? -1, annotation }))
    .filter((entry) => entry.page >= 0)
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      const fa = annotationFrame(a.annotation);
      const fb = annotationFrame(b.annotation);
      return fb.y + fb.height - (fa.y + fa.height) || fa.x - fb.x;
    });
}

/** Every annotation of the document, to find, select and review them. */
export function CommentsPanel({ doc }: { doc: WorkspaceDocument }) {
  const selectAnnotations = useWorkspace((state) => state.selectAnnotations);
  const deleteAnnotations = useWorkspace((state) => state.deleteAnnotations);
  const navigate = useWorkspace((state) => state.navigate);
  const model = doc.editor?.model;
  const entries = useMemo(() => (model ? orderedAnnotations(model) : []), [model]);
  const selected = new Set<AnnotationId>(doc.selection.annotations);

  if (entries.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-ink-muted">
        No comments yet. Highlight text, add notes or draw with the tools above the page.
      </p>
    );
  }

  const open = (page: number, annotation: Annotation) => {
    selectAnnotations(doc.key, [annotation.id]);
    const frame = annotationFrame(annotation);
    navigate(doc.key, {
      pageIndex: page,
      align: 'center',
      pagePoint: { x: frame.x, y: frame.y + frame.height },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, annotation: Annotation) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && doc.permissions.annotate) {
      event.preventDefault();
      // Keep the list's focus on the neighbouring comment.
      const items = Array.from(
        event.currentTarget.closest('ul')?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      );
      const index = items.indexOf(event.currentTarget);
      deleteAnnotations(doc.key, [annotation.id]);
      requestAnimationFrame(() => {
        const remaining = Array.from(
          document.querySelectorAll<HTMLButtonElement>('ul[aria-label="Comments"] button'),
        );
        remaining[Math.min(index, remaining.length - 1)]?.focus();
      });
      return;
    }
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      (annotation.kind === 'note' || annotation.kind === 'added-text')
    ) {
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent(EDIT_ANNOTATION_EVENT, { detail: { docKey: doc.key, id: annotation.id } }),
      );
      return;
    }
    const items = Array.from(
      event.currentTarget.closest('ul')?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    );
    const index = items.indexOf(event.currentTarget);
    const next =
      event.key === 'ArrowDown'
        ? items[index + 1]
        : event.key === 'ArrowUp'
          ? items[index - 1]
          : event.key === 'Home'
            ? items[0]
            : event.key === 'End'
              ? items.at(-1)
              : undefined;
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <ul aria-label="Comments" className="h-full overflow-y-auto px-2 py-2">
      {entries.map(({ page, annotation }, index) => {
        const heading = page !== entries[index - 1]?.page;
        const text = annotationText(annotation);
        return (
          <li key={annotation.id}>
            {heading ? (
              <p className="px-2 pt-2 pb-1 text-2xs font-semibold text-ink-muted">
                Page {page + 1}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => open(page, annotation)}
              onKeyDown={(event) => onKeyDown(event, annotation)}
              aria-current={selected.has(annotation.id) || undefined}
              className={cn(
                'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                selected.has(annotation.id) ? 'bg-accent-soft' : 'hover:bg-hover',
              )}
            >
              <span
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-xs"
                style={{ color: annotation.color === '#ffffff' ? undefined : annotation.color }}
              >
                <AnnotationIcon annotation={annotation} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{annotationLabel(annotation)}</span>
                {text ? <span className="line-clamp-2 block text-ink-muted">{text}</span> : null}
                <span className="block text-2xs text-ink-subtle">
                  {[annotation.author, formatDate(annotation.modifiedAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
