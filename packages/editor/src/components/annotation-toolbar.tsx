import { canRedo, canUndo, redoLabel, undoLabel } from '@folio/document-model';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ICON,
  IconButton,
  Tooltip,
} from '@folio/shared-ui';
import {
  ArrowUpRight,
  Circle,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  Signature,
  Square,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { Toolbar as ToolbarPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { COMMAND_SHORTCUTS } from '../commands';
import { useUi, useWorkspaceContext } from '../context';
import { SWATCHES, type AnnotationStyle, type Tool } from '../store/ui';
import type { WorkspaceDocument } from '../store/workspace';
import { FONT_STACKS } from '../viewer/annotation-shapes';

const icon = { size: ICON.md, strokeWidth: ICON.stroke, 'aria-hidden': true } as const;

const TOOL_META: Record<Tool, { label: string; icon: ReactNode; hint: string }> = {
  select: {
    label: 'Select',
    icon: <MousePointer2 {...icon} />,
    hint: 'Select text and comments',
  },
  highlight: {
    label: 'Highlight',
    icon: <Highlighter {...icon} />,
    hint: 'Select text to highlight it',
  },
  underline: {
    label: 'Underline',
    icon: <Underline {...icon} />,
    hint: 'Select text to underline it',
  },
  strikeout: {
    label: 'Strikethrough',
    icon: <Strikethrough {...icon} />,
    hint: 'Select text to strike it through',
  },
  note: { label: 'Note', icon: <StickyNote {...icon} />, hint: 'Click to place a note' },
  ink: { label: 'Draw', icon: <PenLine {...icon} />, hint: 'Draw freehand' },
  rectangle: { label: 'Rectangle', icon: <Square {...icon} />, hint: 'Drag to draw a rectangle' },
  ellipse: { label: 'Ellipse', icon: <Circle {...icon} />, hint: 'Drag to draw an ellipse' },
  line: { label: 'Line', icon: <Minus {...icon} />, hint: 'Drag to draw a line' },
  arrow: { label: 'Arrow', icon: <ArrowUpRight {...icon} />, hint: 'Drag to draw an arrow' },
  text: {
    label: 'Add text',
    icon: <Type {...icon} />,
    hint: 'Click or drag to add a text box (new text, not an edit of the page’s text)',
  },
  image: { label: 'Add image', icon: <ImagePlus {...icon} />, hint: 'Click to add a picture' },
  signature: {
    label: 'Sign',
    icon: <Signature {...icon} />,
    hint: 'Add a picture of your signature',
  },
};

const GROUPS: readonly (readonly Tool[])[] = [
  ['select'],
  ['highlight', 'underline', 'strikeout'],
  ['note', 'ink', 'rectangle', 'ellipse', 'line', 'arrow'],
  ['text', 'image', 'signature'],
];

const STROKE_WIDTHS = [1, 2, 3, 5, 8] as const;
const FONT_SIZES = [9, 10, 12, 14, 18, 24, 32, 48] as const;

export function ColorSwatches({
  value,
  onChange,
  label,
  allowNone = false,
}: {
  value: string | null;
  onChange(color: string | null): void;
  label: string;
  allowNone?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {allowNone ? (
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          aria-label="None"
          onClick={() => onChange(null)}
          className={cn(
            'relative size-6 rounded-full border border-line-strong bg-raised outline-hidden',
            'after:absolute after:inset-x-0.5 after:top-1/2 after:h-px after:-rotate-45 after:bg-danger',
            'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus',
            value === null && 'ring-2 ring-accent ring-offset-1 ring-offset-raised',
          )}
        />
      ) : null}
      {SWATCHES.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          onClick={() => onChange(color)}
          className={cn(
            'size-6 rounded-full border border-[oklch(0_0_0/0.18)] outline-hidden',
            'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus',
            value === color && 'ring-2 ring-accent ring-offset-1 ring-offset-raised',
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

/** The style controls for the active tool: colour, and width or font where they apply. */
function ToolStyle({ tool, style }: { tool: Tool; style: AnnotationStyle }) {
  const setToolColor = useUi((state) => state.setToolColor);
  const setStyle = useUi((state) => state.setStyle);
  if (tool === 'select' || tool === 'image' || tool === 'signature') return null;
  const color = style.colors[tool];
  const stroked =
    tool === 'ink' ||
    tool === 'rectangle' ||
    tool === 'ellipse' ||
    tool === 'line' ||
    tool === 'arrow';
  const filled = tool === 'rectangle' || tool === 'ellipse';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarPrimitive.Button
          aria-label={`${TOOL_META[tool].label} style`}
          className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-ink-muted outline-hidden hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
        >
          <span
            aria-hidden
            className="size-4 rounded-full border border-[oklch(0_0_0/0.18)]"
            style={{ backgroundColor: color }}
          />
          {stroked ? <span className="tabular">{style.strokeWidth} pt</span> : null}
          {tool === 'text' ? (
            <span className="tabular" style={{ fontFamily: FONT_STACKS[style.fontFamily] }}>
              {style.fontSize} pt
            </span>
          ) : null}
        </ToolbarPrimitive.Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 p-3">
        <DropdownMenuLabel className="px-0 pb-2 text-xs font-semibold">Colour</DropdownMenuLabel>
        <ColorSwatches
          label="Colour"
          value={color}
          onChange={(next) => next && setToolColor(tool, next)}
        />
        {filled ? (
          <>
            <DropdownMenuLabel className="px-0 pt-3 pb-2 text-xs font-semibold">
              Fill
            </DropdownMenuLabel>
            <ColorSwatches
              label="Fill"
              allowNone
              value={style.fill}
              onChange={(fill) => setStyle({ fill })}
            />
          </>
        ) : null}
        {stroked ? (
          <>
            <DropdownMenuSeparator className="my-3" />
            <DropdownMenuLabel className="px-0 pb-1 text-xs font-semibold">
              Line width
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(style.strokeWidth)}
              onValueChange={(value) => setStyle({ strokeWidth: Number(value) })}
            >
              {STROKE_WIDTHS.map((width) => (
                <DropdownMenuRadioItem
                  key={width}
                  value={String(width)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="flex flex-1 items-center gap-2">
                    <span
                      className="h-0 w-10 border-t border-ink"
                      style={{ borderTopWidth: width }}
                    />
                    {width} pt
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        {tool === 'text' ? (
          <>
            <DropdownMenuSeparator className="my-3" />
            <DropdownMenuLabel className="px-0 pb-1 text-xs font-semibold">Font</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={style.fontFamily}
              onValueChange={(value) =>
                setStyle({ fontFamily: value as AnnotationStyle['fontFamily'] })
              }
            >
              {(['sans', 'serif', 'mono'] as const).map((family) => (
                <DropdownMenuRadioItem
                  key={family}
                  value={family}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span style={{ fontFamily: FONT_STACKS[family] }}>
                    {{ sans: 'Sans serif', serif: 'Serif', mono: 'Monospace' }[family]}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuLabel className="px-0 pt-2 pb-1 text-xs font-semibold">
              Size
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(style.fontSize)}
              onValueChange={(value) => setStyle({ fontSize: Number(value) })}
              className="grid grid-cols-4"
            >
              {FONT_SIZES.map((size) => (
                <DropdownMenuRadioItem
                  key={size}
                  value={String(size)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {size}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The commenting and drawing tools, with undo and redo. Shown above the
 * pages of an open document.
 */
export function AnnotationToolbar({ doc }: { doc: WorkspaceDocument }) {
  const { workspace, ui, profile, shortcutPlatform } = useWorkspaceContext();
  const tool = useUi((state) => state.tool);
  const setTool = useUi((state) => state.setTool);
  const style = useUi((state) => state.style);
  const editor = doc.editor;
  const editable = doc.permissions.annotate;
  const shortcuts = COMMAND_SHORTCUTS[profile];
  const shortcut = (keys: string | undefined) =>
    keys ? { keys, platform: shortcutPlatform } : undefined;
  const undoName = editor ? undoLabel(editor) : null;
  const redoName = editor ? redoLabel(editor) : null;
  const active = editable ? tool : 'select';

  return (
    <ToolbarPrimitive.Root
      aria-label="Comment and drawing tools"
      className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-surface px-2"
    >
      <ToolbarPrimitive.ToggleGroup
        type="single"
        value={active}
        aria-label="Tool"
        onValueChange={(value) => {
          // Sign starts in its dialog (also while placing, to choose again):
          // its tool only places the signature chosen there.
          if (value === 'signature' || (!value && active === 'signature')) {
            ui.getState().openDialog({ kind: 'signature', docKey: doc.key });
          } else if (value) {
            setTool(value as Tool);
          }
        }}
        className="flex items-center gap-0.5"
      >
        {GROUPS.map((group, index) => (
          <div key={index} className="flex items-center gap-0.5">
            {index > 0 ? <span aria-hidden className="mx-1 h-5 w-px bg-line" /> : null}
            {group.map((value) => (
              <Tooltip key={value} content={TOOL_META[value].hint}>
                <ToolbarPrimitive.ToggleItem
                  value={value}
                  aria-label={TOOL_META[value].label}
                  disabled={value !== 'select' && !editable}
                  className={cn(
                    'inline-flex size-8 items-center justify-center rounded-md text-ink outline-hidden',
                    'hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus',
                    'disabled:pointer-events-none disabled:opacity-45',
                    'data-[state=on]:bg-accent-soft data-[state=on]:text-accent-soft-ink',
                  )}
                >
                  {TOOL_META[value].icon}
                </ToolbarPrimitive.ToggleItem>
              </Tooltip>
            ))}
          </div>
        ))}
      </ToolbarPrimitive.ToggleGroup>
      <ToolStyle tool={active} style={style} />
      <div className="min-w-2 flex-1" />
      {!editable ? (
        <span className="mr-2 text-xs text-ink-muted">This document does not allow comments.</span>
      ) : null}
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label={undoName ? `Undo ${undoName.toLowerCase()}` : 'Undo'}
          icon={<Undo2 {...icon} />}
          disabled={!editor || !canUndo(editor)}
          onClick={() => workspace.getState().undo(doc.key)}
          shortcut={shortcut(shortcuts.undo[0])}
        />
      </ToolbarPrimitive.Button>
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label={redoName ? `Redo ${redoName.toLowerCase()}` : 'Redo'}
          icon={<Redo2 {...icon} />}
          disabled={!editor || !canRedo(editor)}
          onClick={() => workspace.getState().redo(doc.key)}
          shortcut={shortcut(shortcuts.redo[0])}
        />
      </ToolbarPrimitive.Button>
    </ToolbarPrimitive.Root>
  );
}
