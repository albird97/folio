import type { PageId, Rect } from '@folio/document-model';
import {
  Banner,
  Button,
  cn,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  ICON,
  IconButton,
  Input,
  Label,
  SegmentedControl,
  Spinner,
  type SegmentedOption,
} from '@folio/shared-ui';
import { ImageUp, Trash2 } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useWorkspaceContext } from '../../context';
import { loadSignatureFont } from '../../signature/font';
import { fieldPlacement, newSignature } from '../../signature/placement';
import {
  base64ToBytes,
  forgetSignature,
  loadRememberedSignatures,
  MAX_REMEMBERED,
  pngDataUrl,
  rememberSignature,
  type RememberedSignature,
} from '../../signature/remembered';
import {
  drawTypedPreview,
  INK_COLORS,
  readPicture,
  signatureFromPicture,
  signatureFromPng,
  signatureFromStrokes,
  signatureFromText,
  type Ink,
  type SignatureImage,
  type Stroke,
} from '../../signature/render';
import { PERMISSION_MESSAGES } from '../../store/editing';
import type { DialogOf } from '../../store/ui';
import { pickImageFile } from '../../viewer/images';
import { PAGE_VIEW, PLACING_HINT } from '../../viewer/signature-layer';
import { Paper, SignaturePad, useCanvasPixels } from './signature-pad';

type Source = 'saved' | 'draw' | 'type' | 'image';

const SOURCES: readonly Source[] = ['saved', 'draw', 'type', 'image'];
const SOURCE_LABELS: Record<Source, string> = {
  saved: 'Saved',
  draw: 'Draw',
  type: 'Type',
  image: 'Image',
};

/** Longest name that can be typed as a signature. */
const MAX_NAME_LENGTH = 80;

/** Every tab is as tall as the tallest, so the dialog keeps its place when switching. */
const PANEL = 'flex min-h-[19rem] flex-col pt-3 outline-none';

const inkDot = (ink: Ink) => (
  <span
    aria-hidden
    className="size-2.5 rounded-full ring-1 ring-line-strong"
    style={{ backgroundColor: INK_COLORS[ink] }}
  />
);

const INK_OPTIONS: ReadonlyArray<SegmentedOption<Ink>> = [
  { value: 'black', label: 'Black', icon: inkDot('black') },
  { value: 'blue', label: 'Dark blue', icon: inkDot('blue') },
];

/** Transparent parts of a picture show as a light checkerboard. */
const CHECKERBOARD: CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage: 'conic-gradient(#ececec 25%, transparent 0 50%, #ececec 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
};

/** A picture of a signature as read, and the signature made from it. */
interface Picture {
  pixels: ImageData;
  signature: SignatureImage | null;
  preview: string | null;
}

/**
 * Adds a picture of the user's signature: drawn, typed in a handwriting font,
 * from an image, or one remembered on this device. Without a signature field
 * it hands the signature to the Signature tool, which places it where the
 * user clicks; with one, it goes straight into the field.
 */
export function SignatureDialog({ request }: { request: DialogOf<'signature'> }) {
  const { workspace } = useWorkspaceContext();
  const doc = workspace.getState().documents.find((entry) => entry.key === request.docKey);
  if (!doc?.permissions.annotate) {
    return (
      <DialogContent>
        <DialogTitle>Add a signature</DialogTitle>
        <DialogDescription>
          {doc ? PERMISSION_MESSAGES.annotate : 'This document is no longer open.'}
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="primary">OK</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    );
  }
  return <SignatureForm request={request} signed={doc.info?.hasSignatures ?? false} />;
}

function SignatureForm({
  request,
  signed,
}: {
  request: DialogOf<'signature'>;
  /** The document carries digital signatures. */
  signed: boolean;
}) {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const id = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const drawTabRef = useRef<HTMLButtonElement>(null);
  /** Focus goes to the pages when the dialog closes (the signature is there). */
  const focusPages = useRef(false);
  /** False once the dialog is gone: a signature still being made is not used then. */
  const open = useRef(true);
  const [saved, setSaved] = useState<RememberedSignature[] | null>(null);
  const [source, setSource] = useState<Source>('draw');
  const [chosen, setChosen] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [ink, setInk] = useState<Ink>('black');
  const [name, setName] = useState(() => ui.getState().authorName.slice(0, MAX_NAME_LENGTH));
  const [picture, setPicture] = useState<Picture | null>(null);
  const [removePaper, setRemovePaper] = useState(true);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = saved !== null;

  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  // Remembered signatures come first when there are any.
  useEffect(() => {
    let active = true;
    void loadRememberedSignatures(adapter.storage).then((signatures) => {
      if (!active) return;
      setSaved(signatures);
      if (signatures.length > 0) {
        setSource('saved');
        setChosen(signatures[0]!.id);
      }
    });
    return () => {
      active = false;
    };
  }, [adapter]);

  // The tabs appear once it is known whether there are remembered
  // signatures: focus starts on the tab shown.
  useEffect(() => {
    if (loaded) {
      contentRef.current
        ?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
        ?.focus({ preventScroll: true });
    }
  }, [loaded]);

  const ready =
    source === 'saved'
      ? chosen !== null
      : source === 'draw'
        ? strokes.length > 0
        : source === 'type'
          ? name.trim() !== ''
          : Boolean(picture?.signature);

  const showPicture = async (pixels: ImageData, removing: boolean) => {
    const signature = await signatureFromPicture(pixels, removing);
    setPicture({ pixels, signature, preview: signature ? pngDataUrl(signature.bytes) : null });
  };

  const choosePicture = async () => {
    const file = await pickImageFile();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await showPicture(await readPicture(file), removePaper);
    } catch {
      setPicture(null);
      setError('That image could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const changeRemovePaper = async (removing: boolean) => {
    setRemovePaper(removing);
    if (!picture) return;
    // (Placing waits while busy, so the signature shown is never out of date then.)
    setBusy(true);
    try {
      await showPicture(picture.pixels, removing);
    } catch {
      // The signature shown is still the earlier one: so is the box.
      setRemovePaper(!removing);
      setError('That image could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const forget = async (signature: RememberedSignature, index: number) => {
    let left: RememberedSignature[];
    try {
      left = await forgetSignature(adapter.storage, signature.id);
    } catch {
      workspace.getState().showNotice('The saved signature could not be deleted.');
      return;
    }
    setSaved(left);
    if (chosen === signature.id) setChosen(left[0]?.id ?? null);
    if (left.length === 0) setSource('draw');
    // Focus stays in the list, on the signature that took this one's place.
    const next = left[Math.min(index, left.length - 1)];
    requestAnimationFrame(() =>
      (next ? document.getElementById(`${id}-saved-${next.id}`) : drawTabRef.current)?.focus(),
    );
  };

  const create = async (): Promise<SignatureImage | null> => {
    switch (source) {
      case 'saved': {
        const signature = saved?.find((entry) => entry.id === chosen);
        const bytes = signature ? base64ToBytes(signature.png) : null;
        return bytes ? signatureFromPng(bytes) : null;
      }
      case 'draw':
        return signatureFromStrokes(strokes, ink);
      case 'type':
        return signatureFromText(name, ink);
      case 'image':
        return picture?.signature ?? null;
    }
  };

  /** Remembers the signature when asked; says why when it cannot. */
  const rememberIfAsked = async (signature: SignatureImage): Promise<string | null> => {
    if (!remember || source === 'saved') return null;
    try {
      if (await rememberSignature(adapter.storage, signature.bytes)) return null;
      // Only whole photos get this large.
      return source === 'image' && !removePaper
        ? 'This picture is too large to remember. Without its background it is smaller.'
        : 'This signature is too large to remember.';
    } catch {
      return 'This signature could not be remembered on this device.';
    }
  };

  const signField = async (signature: SignatureImage, field: { pageId: PageId; rect: Rect }) => {
    const state = workspace.getState();
    const doc = state.documents.find((entry) => entry.key === request.docKey);
    const page = doc?.editor?.model.pages.find((entry) => entry.id === field.pageId);
    if (!page) {
      state.showNotice('The signature field is no longer in this document.');
      return;
    }
    try {
      const asset = await state.registerImage(request.docKey, signature.bytes, 'image/png');
      if (!asset) return;
      const annotation = newSignature({
        pageId: page.id,
        placement: fieldPlacement(page, field.rect, signature.width / signature.height),
        assetId: asset.id,
        author: ui.getState().authorName,
      });
      state.addAnnotations(request.docKey, [annotation], {
        label: 'Add signature',
        assets: [asset],
      });
    } catch {
      state.showNotice('The signature could not be added.');
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    let signature: SignatureImage | null = null;
    try {
      signature = await create();
    } catch {
      // Reported below.
    }
    // Cancelled meanwhile: nothing is placed or remembered.
    if (!open.current) return;
    if (!signature) {
      setBusy(false);
      setError(
        source === 'saved'
          ? 'That saved signature could not be read.'
          : 'The signature could not be made.',
      );
      return;
    }
    // From here on the signature is used: the dialog goes, so no more cancelling.
    focusPages.current = true;
    ui.getState().closeDialog();
    const pending = { docKey: request.docKey, image: signature };
    if (request.field) {
      await signField(signature, request.field);
    } else {
      ui.getState().startPlacingSignature(pending);
      workspace.getState().showNotice(PLACING_HINT);
    }
    const note = await rememberIfAsked(signature);
    if (note) {
      // While it is being placed, the hint stays with the note.
      const placing = ui.getState().pendingSignature === pending;
      workspace.getState().showNotice(placing ? `${note} ${PLACING_HINT}` : note);
    }
  };

  // At the foot of the Draw, Type and Image tabs (saved signatures are remembered already).
  const rememberOption = (
    <div className="mt-auto pt-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
          aria-describedby={`${id}-remember-hint`}
        />
        Remember on this device
      </label>
      <p id={`${id}-remember-hint`} className="mt-1 pl-6 text-xs text-ink-muted">
        Remembered signatures stay on this device, for next time (up to {MAX_REMEMBERED}).
      </p>
    </div>
  );

  return (
    <DialogContent
      ref={contentRef}
      className="max-h-[calc(100vh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto"
      // The tabs take focus once they are shown (see above).
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => {
        if (!focusPages.current) return;
        event.preventDefault();
        document.querySelector<HTMLElement>(PAGE_VIEW)?.focus();
      }}
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        <DialogTitle>Add a signature</DialogTitle>
        <DialogDescription>
          {request.field
            ? 'Draw your signature, type your name or choose a picture of your signature for the signature field.'
            : 'Draw your signature, type your name or choose a picture of your signature, then click where it goes on the page.'}{' '}
          It is added as a picture, not as a digital (certificate) signature.
        </DialogDescription>
        {signed ? (
          <Banner tone="warning" title="This document is digitally signed" className="mt-3">
            Its digital signatures do not cover a signature added here and will show as invalid.
          </Banner>
        ) : null}

        {saved === null ? (
          <div className="mt-4 flex h-[21rem] items-center justify-center">
            <Spinner label="Loading saved signatures" />
          </div>
        ) : (
          <Tabs.Root
            value={source}
            onValueChange={(value) => {
              setSource(value as Source);
              setError(null);
            }}
            className="mt-4"
          >
            <Tabs.List aria-label="How to sign" className="flex gap-1 border-b border-line">
              {SOURCES.filter((value) => value !== 'saved' || saved.length > 0).map((value) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  ref={value === 'draw' ? drawTabRef : undefined}
                  className={cn(
                    '-mb-px inline-flex h-8 items-center border-b-2 border-transparent px-3 text-sm font-medium text-ink-muted outline-none',
                    'hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                    'data-[state=active]:border-accent data-[state=active]:text-ink',
                  )}
                >
                  {SOURCE_LABELS[value]}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <Tabs.Content value="saved" className={PANEL}>
              <div
                role="radiogroup"
                aria-label="Saved signatures"
                className="grid grid-cols-2 gap-2"
              >
                {saved.map((signature, index) => (
                  <div key={signature.id} className="relative">
                    <button
                      id={`${id}-saved-${signature.id}`}
                      type="button"
                      role="radio"
                      aria-checked={chosen === signature.id}
                      aria-label={`Saved signature ${index + 1}`}
                      onClick={() => setChosen(signature.id)}
                      className={cn(
                        'flex h-[4.5rem] w-full items-center justify-center rounded-md bg-page px-10 py-2 outline-none',
                        'shadow-[inset_0_0_0_1px_var(--folio-border-strong)]',
                        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
                        chosen === signature.id &&
                          'ring-2 ring-accent ring-offset-1 ring-offset-raised',
                      )}
                    >
                      <img
                        src={`data:image/png;base64,${signature.png}`}
                        alt=""
                        className="max-h-full max-w-full object-contain"
                      />
                    </button>
                    <IconButton
                      label={`Delete saved signature ${index + 1}`}
                      icon={<Trash2 size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />}
                      variant="secondary"
                      size="icon-sm"
                      className="absolute top-1.5 right-1.5"
                      onClick={() => void forget(signature, index)}
                    />
                  </div>
                ))}
              </div>
              <p className="mt-auto pt-3 text-xs text-ink-muted">
                Saved signatures stay on this device. Deleting one here forgets it.
              </p>
            </Tabs.Content>

            <Tabs.Content value="draw" className={PANEL}>
              <SignaturePad
                strokes={strokes}
                ink={ink}
                onChange={setStrokes}
                describedBy={`${id}-draw-hint`}
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <p id={`${id}-draw-hint`} className="text-xs text-ink-muted">
                  Sign with a mouse, trackpad, pen or finger.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <SegmentedControl
                    label="Ink colour"
                    value={ink}
                    onValueChange={setInk}
                    options={INK_OPTIONS}
                  />
                  <Button size="sm" disabled={strokes.length === 0} onClick={() => setStrokes([])}>
                    Clear
                  </Button>
                </div>
              </div>
              {rememberOption}
            </Tabs.Content>

            <Tabs.Content value="type" className={PANEL}>
              <div className="flex items-end gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Label htmlFor={`${id}-name`}>Your name</Label>
                  <Input
                    id={`${id}-name`}
                    autoComplete="name"
                    spellCheck={false}
                    maxLength={MAX_NAME_LENGTH}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <SegmentedControl
                  label="Ink colour"
                  value={ink}
                  onValueChange={setInk}
                  options={INK_OPTIONS}
                />
              </div>
              <TypedPreview name={name} ink={ink} className="mt-3" />
              {rememberOption}
            </Tabs.Content>

            <Tabs.Content value="image" className={PANEL}>
              <div className="flex items-center justify-between gap-3">
                <Button disabled={busy} onClick={() => void choosePicture()}>
                  <ImageUp size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
                  {picture ? 'Choose another picture…' : 'Choose a picture…'}
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={removePaper}
                    disabled={busy}
                    onChange={(event) => void changeRemovePaper(event.target.checked)}
                  />
                  Remove the background
                </label>
              </div>
              <div
                className="mt-3 flex aspect-[3/1] items-center justify-center overflow-hidden rounded-md p-3 shadow-[inset_0_0_0_1px_var(--folio-border-strong)]"
                style={CHECKERBOARD}
              >
                {picture?.preview ? (
                  <img
                    src={picture.preview}
                    alt="Preview of your signature"
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <p className="px-4 text-center text-xs text-[oklch(0.43_0.014_230)]">
                    {picture
                      ? 'Nothing is left once the background is removed. Try a darker picture, or keep the background.'
                      : 'No picture chosen yet.'}
                  </p>
                )}
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                A photo or scan on white paper works best.
              </p>
              {rememberOption}
            </Tabs.Content>
          </Tabs.Root>
        )}

        {error ? (
          <p role="alert" className="mt-3 text-xs text-danger-ink">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? <Spinner /> : null}
            {request.field ? 'Sign' : 'Place on page'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** The typed name in the handwriting font, as it will be placed. */
function TypedPreview({ name, ink, className }: { name: string; ink: Ink; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixels = useCanvasPixels(canvasRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pixels) return;
    let active = true;
    // Drawn once the font has the name's letters, never in a fallback first.
    void loadSignatureFont(name).then(() => {
      if (!active) return;
      canvas.width = pixels.width;
      canvas.height = pixels.height;
      drawTypedPreview(canvas, name, ink);
    });
    return () => {
      active = false;
    };
  }, [name, ink, pixels]);

  return (
    <Paper className={className}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Preview of your signature"
        className="relative block aspect-[3/1] w-full"
      />
    </Paper>
  );
}
