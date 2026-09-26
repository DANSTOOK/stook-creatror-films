import { useCallback, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronRight, Diamond, FolderOpen, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import type { Clip, MaskConfig, MediaAsset, ProjectState } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { createId } from '@shared/utils/id';
import { evaluateNumber, evaluateVector } from '@renderer/engine/KeyframeEvaluator';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { fitScale } from '@renderer/media/fitToFrame';
import { dbLabel, panLabel, signedDb } from '@renderer/audio/levels';
import { ContextMenu, useContextMenu } from '@renderer/components/ContextMenu';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT, type MessageKey } from '@renderer/i18n';
import { useIndicator } from '@renderer/motion/useIndicator';
import { useFlip } from '@renderer/motion/useFlip';
import { createClip } from '@renderer/store/types';
import { useProjectStore, type NumberProperty, type VectorProperty } from '@renderer/store/useProjectStore';

/**
 * Property inspector for the selected clip.
 *
 * Laid out like Resolve's and Final Cut's: tabs for what kind of setting it
 * is - Video, Audio, Color, Info - with only the tabs that apply to this clip
 * (a sound has no picture to grade, a still has no sound); collapsible
 * sections, each with a switch that turns it on or off and a button that puts
 * it back to its defaults; and label-left, value-right rows with the numbers
 * in one aligned column.
 *
 * Effects that are off - mask, chroma key, pixel art - are not listed as open
 * sections any more, a screen of switched-off controls for every clip. They
 * are added from "Add effect", and show while they are on, changed from their
 * defaults, or added in this session.
 *
 * A number can be dragged by its label, as in Final Cut and Resolve: sideways
 * to change it, with Shift for fine steps and Alt for coarse ones. A drag is
 * one undo step.
 *
 * Every write goes through the store with a merge key, so a drag or a slider
 * is one undo step rather than one per pixel. Values are shown in the units an
 * editor is read in - percent, degrees, px, dB, L/C/R - and only the display
 * and the typing are converted; the project stores what it always did.
 */

type Tab = 'video' | 'audio' | 'color' | 'info';
type Effect = 'mask' | 'chromaKey' | 'pixelArt';

const TAB_LABELS: Record<Tab, MessageKey> = {
  video: 'inspector.tabVideo',
  audio: 'inspector.tabAudio',
  color: 'inspector.tabColor',
  info: 'inspector.tabInfo',
};

/** The settings a new clip starts with, to reset a section to. */
const DEFAULTS = createClip({ trackId: '', name: '', sourceUri: '', startFrame: 0, durationFrames: 1 });

const MASK_TYPES: { value: MaskConfig['type']; label: MessageKey }[] = [
  { value: 1, label: 'inspector.maskRectangle' },
  { value: 2, label: 'inspector.maskEllipse' },
];

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const degrees = (radians: number): string => `${Math.round((radians * 180) / Math.PI)}°`;
const plain = (value: number): string => value.toFixed(2);

/* Rows -------------------------------------------------------------------- */

/**
 * A label that changes its number when dragged sideways: a pixel of travel is
 * one step, Shift a tenth of one, Alt ten. Pointer capture keeps the drag when
 * the pointer leaves the label.
 */
function ScrubLabel({
  htmlFor,
  children,
  value,
  step,
  onChange,
  className = '',
}: {
  htmlFor: string;
  children: ReactNode;
  value: number;
  step: number;
  onChange(value: number): void;
  className?: string;
}): JSX.Element {
  const origin = useRef<{ x: number; value: number } | null>(null);
  /** Set when the pointer travelled: the click that ends a drag must not focus the field. */
  const dragged = useRef(false);
  return (
    <label
      htmlFor={htmlFor}
      className={`cursor-ew-resize select-none touch-none ${className}`}
      onPointerDown={(event: ReactPointerEvent<HTMLLabelElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = { x: event.clientX, value };
        dragged.current = false;
      }}
      onClick={(event) => {
        // A plain click on the label still puts the caret in its field.
        if (dragged.current) event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!origin.current) return;
        if (Math.abs(event.clientX - origin.current.x) > 2) dragged.current = true;
        const scale = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
        const next = origin.current.value + (event.clientX - origin.current.x) * step * scale;
        onChange(Number(next.toFixed(4)));
      }}
      onPointerUp={(event) => {
        origin.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      {children}
    </label>
  );
}

interface NumberInputProps {
  id: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number, inside the field: "%", "px", "°". */
  unit?: string;
  /** Displayed value = stored value x this; typing divides it back out. */
  factor?: number;
  label?: string;
  onChange(value: number): void;
}

function NumberInput({ id, value, min, max, step = 0.01, unit, factor = 1, label, onChange }: NumberInputProps): JSX.Element {
  const shown = Number.isFinite(value) ? Number((value * factor).toFixed(4)) : 0;
  return (
    <span className="relative block min-w-0 flex-1">
      <input
        id={id}
        type="number"
        aria-label={label}
        className={`numeric-input timecode h-control-dense pl-1.5 text-right ${unit ? 'pr-4' : 'pr-1.5'}`}
        value={shown}
        min={min === undefined ? undefined : min * factor}
        max={max === undefined ? undefined : max * factor}
        step={step}
        onChange={(event) => onChange(Number(event.target.value) / factor)}
      />
      {unit && (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-1 flex items-center text-2xs text-slate-400">
          {unit}
        </span>
      )}
    </span>
  );
}

/** One number: its label at the left (drag it), the field at the right. */
function NumberRow(props: Omit<NumberInputProps, 'id'> & { label: string }): JSX.Element {
  const id = useId();
  const step = props.step ?? 0.01;
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-2">
      <ScrubLabel htmlFor={id} value={props.value} step={step / (props.factor ?? 1)} onChange={props.onChange} className="field-label truncate">
        {props.label}
      </ScrubLabel>
      <NumberInput {...props} id={id} label={undefined} />
    </div>
  );
}

/** A pair - Position X and Y - on one row, each axis draggable by its letter. */
function PairRow({
  label,
  xLabel,
  yLabel,
  x,
  y,
  unit,
  factor = 1,
  step = 1,
  onChange,
}: {
  label: string;
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  unit?: string;
  factor?: number;
  step?: number;
  onChange(axis: 'x' | 'y', value: number): void;
}): JSX.Element {
  const xId = useId();
  const yId = useId();
  const axis = (id: string, name: string, letter: string, value: number, which: 'x' | 'y'): JSX.Element => (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <ScrubLabel htmlFor={id} value={value} step={step / factor} onChange={(next) => onChange(which, next)} className="w-3 text-center text-2xs text-slate-400">
        <span aria-hidden>{letter}</span>
        <span className="sr-only">{name}</span>
      </ScrubLabel>
      <NumberInput id={id} value={value} unit={unit} factor={factor} step={step} onChange={(next) => onChange(which, next)} />
    </span>
  );
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-2">
      <span className="field-label truncate">{label}</span>
      <span className="flex min-w-0 gap-2">
        {axis(xId, xLabel, 'X', x, 'x')}
        {axis(yId, yLabel, 'Y', y, 'y')}
      </span>
    </div>
  );
}

/** A slider with its value beside it: a readout, or a field when it can be typed. */
function SliderRow({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  format = plain,
  typed,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?(value: number): string;
  /** A field instead of a readout, in these display units. */
  typed?: { factor?: number; unit?: string; step?: number };
  onChange(value: number): void;
}): JSX.Element {
  const id = useId();
  // Fills from the left only for a quantity that starts at zero; a pan or a
  // boost/cut is centred, and a fill from the left would say the wrong thing.
  const fill = min >= 0 ? { '--fill': `${((value - min) / (max - min || 1)) * 100}%` } : undefined;
  return (
    <div className="grid grid-cols-[76px_1fr_64px] items-center gap-2">
      <ScrubLabel htmlFor={id} value={value} step={step} onChange={(next) => onChange(Math.min(max, Math.max(min, next)))} className="field-label truncate">
        {label}
      </ScrubLabel>
      <input
        id={id}
        type="range"
        className="min-w-0"
        style={fill as React.CSSProperties | undefined}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {typed ? (
        <NumberInput
          id={`${id}-value`}
          label={label}
          value={value}
          min={min}
          max={max}
          step={typed.step ?? step}
          factor={typed.factor}
          unit={typed.unit}
          onChange={(next) => onChange(Math.min(max, Math.max(min, next)))}
        />
      ) : (
        <span className="timecode truncate text-right text-2xs text-slate-300">{format(value)}</span>
      )}
    </div>
  );
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }): JSX.Element {
  return (
    <label className="grid grid-cols-[76px_1fr] items-center gap-2 text-xs text-slate-300">
      <span className="field-label truncate">{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

/* Sections ---------------------------------------------------------------- */

interface SectionProps {
  id: string;
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** On/off switch in the header, as Resolve has on each group. */
  enabled?: boolean;
  onEnabledChange?(enabled: boolean): void;
  onReset?(): void;
  onRemove?(): void;
  right?: ReactNode;
  children: ReactNode;
}

/**
 * A group of settings with a header: fold it, switch it on or off, put it
 * back to its defaults. The body stays in the page when folded (hidden, with
 * data-state) so its opening can be animated.
 */
function Section({ id, title, open, onOpenChange, enabled, onEnabledChange, onReset, onRemove, right, children }: SectionProps): JSX.Element {
  const t = useT();
  const bodyId = `inspector-section-${id}`;
  return (
    <section data-section={id} data-state={open ? 'open' : 'closed'} data-flip-key={id} className="border-b border-panel-800">
      <div className="flex h-9 items-center gap-1 pl-1.5 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-control py-1 text-left hover:text-white"
          onClick={() => onOpenChange(!open)}
        >
          <ChevronRight size={13} className={`shrink-0 text-slate-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          <h3 className={`truncate text-xs font-semibold ${enabled === false ? 'text-slate-400' : 'text-slate-200'}`}>{title}</h3>
        </button>
        {right}
        {onReset && (
          <button type="button" className="tool-button tool-button-dense w-6 px-0" onClick={onReset} {...tip(t('inspector.resetSection', { name: title }))}>
            <RotateCcw size={12} />
          </button>
        )}
        {onRemove && (
          <button type="button" className="tool-button tool-button-dense w-6 px-0 hover:text-red-400" onClick={onRemove} {...tip(t('inspector.removeEffect', { name: title }))}>
            <X size={13} />
          </button>
        )}
        {onEnabledChange && (
          <input
            type="checkbox"
            role="switch"
            className="ml-1"
            aria-label={t('inspector.enableSection', { name: title })}
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
        )}
      </div>
      {/* No display class while folded: `flex` would beat the `hidden`
          attribute (both are one class-level selector, and utilities come
          last), and a folded group stayed open. */}
      <div id={bodyId} hidden={!open} className={`${open ? 'flex' : ''} flex-col gap-2 px-3 pb-3`}>
        {children}
      </div>
    </section>
  );
}

/* Info -------------------------------------------------------------------- */

/** The clip's technical facts, like Final Cut's Info inspector. */
function InfoRows({ clip, asset, fps }: { clip: Clip; asset: MediaAsset | undefined; fps: number }): JSX.Element {
  const t = useT();
  const kind = asset?.kind ?? (clip.hasAlphaChannel ? 'image' : 'video');
  const rows: Array<[string, string]> = [
    [t('inspector.infoType'), t(kind === 'audio' ? 'inspector.kindAudio' : kind === 'image' ? 'inspector.kindImage' : 'inspector.kindVideo')],
  ];
  if (kind !== 'audio') {
    rows.push([t('inspector.infoChannels'), clip.hasAlphaChannel ? t('inspector.channelsAlpha') : 'RGB']);
    if (asset && asset.width > 0) rows.push([t('inspector.infoSize'), `${asset.width} × ${asset.height}`]);
    if (asset?.sourceFps) rows.push([t('inspector.infoFrameRate'), `${Number(asset.sourceFps.toFixed(3))} fps`]);
  }
  rows.push([t('inspector.infoDuration'), framesToTimecode(clip.durationFrames, fps)]);
  rows.push([t('inspector.infoStart'), framesToTimecode(clip.startFrame, fps)]);
  if (asset?.sourcePath) rows.push([t('inspector.infoFile'), asset.sourcePath]);

  return (
    <dl className="grid grid-cols-[76px_1fr] gap-x-2 gap-y-1.5 p-3 text-2xs">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-slate-400">{name}</dt>
          <dd className="timecode break-all text-slate-200" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * True for a clip whose source is audio only: it sits on an audio track, or
 * its media is an audio file wherever it sits.
 */
export function isAudioClip(clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): boolean {
  const track = project.tracks.find((candidate) => candidate.id === clip.trackId);
  if (track?.type === 'audio') return true;
  return assets.find((asset) => asset.uri === clip.sourceUri)?.kind === 'audio';
}

/** Is an effect worth listing: on, changed from its defaults, or added just now? */
function effectShown(clip: Clip, effect: Effect, added: ReadonlySet<string>): boolean {
  if (clip[effect].enabled || added.has(`${clip.id}:${effect}`)) return true;
  const { enabled: _a, ...current } = clip[effect] as unknown as Record<string, unknown>;
  const { enabled: _b, ...initial } = DEFAULTS[effect] as unknown as Record<string, unknown>;
  void _a;
  void _b;
  return JSON.stringify(current) !== JSON.stringify(initial);
}

/* The inspector ----------------------------------------------------------- */

export function Inspector(): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const assets = useProjectStore((state) => state.assets);
  const selectedIds = useProjectStore((state) => state.ui.selectedClipIds);
  const updateClip = useProjectStore((state) => state.updateClip);
  const setVectorKeyframe = useProjectStore((state) => state.setVectorKeyframe);
  const setNumberKeyframe = useProjectStore((state) => state.setNumberKeyframe);
  const clearKeyframes = useProjectStore((state) => state.clearKeyframes);

  const clip: Clip | undefined = selectedIds.length === 1 ? project.clips[selectedIds[0]] : undefined;
  const frame = project.currentFrame;

  const [tab, setTab] = useState<Tab>('video');
  /** Folded sections, by section id: a choice about the inspector, kept across clips. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  /** Effects added from the menu, shown even while off and at their defaults. */
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  // The tab highlight slides to the chosen tab; a group that folds or unfolds
  // moves the groups under it to their new places instead of jumping.
  const tabIndicator = useIndicator<HTMLDivElement, HTMLSpanElement>(`${tab}|${selectedIds.join(',')}`);
  const tabPanelRef = useRef<HTMLDivElement>(null);
  useFlip(tabPanelRef, `${tab}|${selectedIds.join(',')}|${[...folded].join(',')}`);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const addButton = useRef<HTMLButtonElement>(null);

  const lutInputRef = useRef<HTMLInputElement>(null);
  const [lutError, setLutError] = useState<string | null>(null);

  /**
   * Load a `.cube` file and upload it before it is referenced, so the very next
   * composited frame already has the look applied.
   */
  const applyLut = useCallback(async (clipId: string, name: string, contents: string, sourcePath?: string) => {
    setLutError(null);
    try {
      const uri = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
      const renderer = getActiveFrameRenderer();
      // Parsing happens here, so a malformed file reports an error rather
      // than silently doing nothing when the frame is drawn.
      await renderer?.lutLoader.load(uri);
      const current = useProjectStore.getState().project.clips[clipId];
      if (!current) return;
      useProjectStore.getState().updateClip(clipId, {
        colorGrading: {
          ...current.colorGrading,
          enabled: true,
          lutUri: uri,
          lutName: name,
          // Without the path the look is lost the moment the project is
          // reopened, because the blob URL dies with the page.
          ...(sourcePath ? { lutSourcePath: sourcePath } : {}),
        },
      });
    } catch (error) {
      setLutError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  /** Native dialog when it exists, so the LUT keeps a path it can be restored from. */
  const pickLut = useCallback(
    async (clipId: string) => {
      if (!hasNativeBridge()) {
        lutInputRef.current?.click();
        return;
      }
      const picked = await window.filmora.openLut();
      if (!picked) return;
      const name = picked.path.split(/[\\/]/).pop() ?? 'LUT';
      await applyLut(clipId, name, picked.contents, picked.path);
    },
    [applyLut],
  );

  const resolved = useMemo(() => {
    if (!clip) return null;
    return {
      position: evaluateVector(clip.transform.position, frame, { x: 0, y: 0 }),
      scale: evaluateVector(clip.transform.scale, frame, { x: 1, y: 1 }),
      rotation: evaluateNumber(clip.transform.rotation, frame, 0),
      opacity: evaluateNumber(clip.transform.opacity, frame, 1),
    };
  }, [clip, frame]);

  if (!clip || !resolved) {
    return (
      <aside data-testid="inspector-panel" className="panel w-full">
        <header className="panel-header">{t('inspector.title')}</header>
        <p className="p-4 text-xs text-slate-400">
          {selectedIds.length > 1 ? t('inspector.manySelected', { count: selectedIds.length }) : t('inspector.noneSelected')}
        </p>
      </aside>
    );
  }

  const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
  const audioOnly = isAudioClip(clip, project, assets);
  const still = !audioOnly && asset?.kind === 'image';
  // Only the tabs that mean something for this clip.
  const tabs: Tab[] = audioOnly ? ['audio', 'info'] : still ? ['video', 'color', 'info'] : ['video', 'audio', 'color', 'info'];
  const current: Tab = tabs.includes(tab) ? tab : tabs[0];

  const sectionProps = (id: string): Pick<SectionProps, 'id' | 'open' | 'onOpenChange'> => ({
    id,
    open: !folded.has(id),
    onOpenChange: (open) =>
      setFolded((previous) => {
        const next = new Set(previous);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      }),
  });

  /* Video tab --------------------------------------------------------------- */

  const keyframeCount =
    clip.transform.position.length + clip.transform.rotation.length + clip.transform.opacity.length + clip.transform.scale.length;
  const keyframeBadge = (
    <span
      className="mr-0.5 flex items-center gap-1 text-2xs tabular-nums text-slate-400"
      {...tip(t('inspector.keyframeCount', { count: keyframeCount }))}
    >
      <Diamond size={10} className={keyframeCount > 0 ? 'text-accent-hover' : 'text-slate-400'} />
      {keyframeCount}
    </span>
  );

  const resetTransform = (): void => {
    // Back to how the clip was placed: centred, unrotated, opaque, and at the
    // fit a still of another shape was given - one undo step.
    const fit = asset ? fitScale(asset, project) : null;
    updateClip(clip.id, {
      transform: {
        ...clip.transform,
        position: [],
        rotation: [],
        opacity: [],
        scale: fit ? [{ id: createId('kf'), frame: clip.startFrame, value: fit, easing: 'linear' }] : [],
      },
    });
  };

  const setEffect = <K extends Effect>(effect: K, patch: Partial<Clip[K]>, merge = true): void =>
    updateClip(clip.id, { [effect]: { ...clip[effect], ...patch } } as Partial<Clip>, merge ? `${effect}:${clip.id}` : undefined);
  const resetEffect = (effect: Effect): void =>
    updateClip(clip.id, { [effect]: { ...DEFAULTS[effect], enabled: clip[effect].enabled } } as Partial<Clip>);
  const removeEffect = (effect: Effect): void => {
    setAdded((previous) => {
      const next = new Set(previous);
      next.delete(`${clip.id}:${effect}`);
      return next;
    });
    updateClip(clip.id, { [effect]: { ...DEFAULTS[effect] } } as Partial<Clip>);
  };
  const addEffect = (effect: Effect): void => {
    setAdded((previous) => new Set(previous).add(`${clip.id}:${effect}`));
    setFolded((previous) => {
      const next = new Set(previous);
      next.delete(effect);
      return next;
    });
    // A mask with no shape draws nothing: it arrives as a rectangle.
    if (effect === 'mask') setEffect('mask', { enabled: true, type: clip.mask.type === 0 ? 1 : clip.mask.type }, false);
    else setEffect(effect, { enabled: true } as Partial<Clip[typeof effect]>, false);
  };

  const EFFECTS: Array<{ id: Effect; label: MessageKey }> = [
    { id: 'mask', label: 'inspector.mask' },
    { id: 'chromaKey', label: 'inspector.chromaKey' },
    { id: 'pixelArt', label: 'inspector.pixelArt' },
  ];
  const shownEffects = EFFECTS.filter((effect) => effectShown(clip, effect.id, added));
  const addable = EFFECTS.filter((effect) => !shownEffects.includes(effect));

  const levelRows = (
    <>
      <SliderRow label={t('inspector.volume')} value={clip.volume} max={2} format={dbLabel} onChange={(volume) => updateClip(clip.id, { volume }, `volume:${clip.id}`)} />
      <SliderRow label={t('inspector.pan')} value={clip.pan} min={-1} max={1} format={panLabel} onChange={(pan) => updateClip(clip.id, { pan }, `pan:${clip.id}`)} />
    </>
  );

  const videoTab = (
    <>
      <Section {...sectionProps('transform')} title={t('inspector.transform')} onReset={resetTransform} right={keyframeBadge}>
        <PairRow
          label={t('inspector.position')}
          xLabel={t('inspector.positionX')}
          yLabel={t('inspector.positionY')}
          x={resolved.position.x}
          y={resolved.position.y}
          unit="px"
          onChange={(axis, value) => setVectorKeyframe(clip.id, 'position', frame, { ...resolved.position, [axis]: value })}
        />
        <PairRow
          label={t('inspector.scale')}
          xLabel={t('inspector.scaleX')}
          yLabel={t('inspector.scaleY')}
          x={resolved.scale.x}
          y={resolved.scale.y}
          unit="%"
          factor={100}
          onChange={(axis, value) => setVectorKeyframe(clip.id, 'scale', frame, { ...resolved.scale, [axis]: value })}
        />
        <NumberRow label={t('inspector.rotation')} unit="°" value={resolved.rotation} step={0.5} onChange={(value) => setNumberKeyframe(clip.id, 'rotation', frame, value)} />
        <SliderRow
          label={t('inspector.opacity')}
          value={resolved.opacity}
          typed={{ factor: 100, unit: '%', step: 1 }}
          onChange={(value) => setNumberKeyframe(clip.id, 'opacity', frame, value)}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-2xs text-slate-400">{t('inspector.keyframeHint', { frame })}</p>
          {keyframeCount > 0 && (
            <button
              type="button"
              className="tool-button tool-button-dense shrink-0 text-2xs hover:text-red-400"
              onClick={() => (['position', 'scale', 'rotation', 'opacity'] as Array<VectorProperty | NumberProperty>).forEach((property) => clearKeyframes(clip.id, property))}
            >
              <Trash2 size={11} />
              {t('inspector.clearAllKeyframes')}
            </button>
          )}
        </div>
      </Section>

      {shownEffects.some((effect) => effect.id === 'mask') && (
        <Section
          {...sectionProps('mask')}
          title={t('inspector.mask')}
          enabled={clip.mask.enabled}
          onEnabledChange={(enabled) => setEffect('mask', { enabled }, false)}
          onReset={() => resetEffect('mask')}
          onRemove={() => removeEffect('mask')}
        >
          <label className="grid grid-cols-[76px_1fr] items-center gap-2">
            <span className="field-label">{t('inspector.shape')}</span>
            <select
              className="numeric-input h-control-dense"
              value={clip.mask.type === 0 ? 1 : clip.mask.type}
              onChange={(event) => setEffect('mask', { type: Number(event.target.value) as MaskConfig['type'] }, false)}
            >
              {MASK_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>
          <PairRow
            label={t('inspector.center')}
            xLabel={t('inspector.centerX')}
            yLabel={t('inspector.centerY')}
            x={clip.mask.center.x}
            y={clip.mask.center.y}
            step={0.01}
            onChange={(axis, value) => setEffect('mask', { center: { ...clip.mask.center, [axis]: value } })}
          />
          <PairRow
            label={t('inspector.size')}
            xLabel={t('inspector.sizeX')}
            yLabel={t('inspector.sizeY')}
            x={clip.mask.size.x}
            y={clip.mask.size.y}
            step={0.01}
            onChange={(axis, value) => setEffect('mask', { size: { ...clip.mask.size, [axis]: value } })}
          />
          <SliderRow label={t('inspector.cornerRadius')} value={clip.mask.cornerRadius} max={0.5} onChange={(cornerRadius) => setEffect('mask', { cornerRadius })} />
          <SliderRow label={t('inspector.feather')} value={clip.mask.feather} max={200} step={1} format={(value) => `${Math.round(value)} px`} onChange={(feather) => setEffect('mask', { feather })} />
          <SliderRow label={t('inspector.maskRotation')} value={clip.mask.rotation} min={-Math.PI} max={Math.PI} format={degrees} onChange={(rotation) => setEffect('mask', { rotation })} />
          <SwitchRow label={t('inspector.invertMask')} checked={clip.mask.invert} onChange={(invert) => setEffect('mask', { invert }, false)} />
        </Section>
      )}

      {shownEffects.some((effect) => effect.id === 'chromaKey') && (
        <Section
          {...sectionProps('chromaKey')}
          title={t('inspector.chromaKey')}
          enabled={clip.chromaKey.enabled}
          onEnabledChange={(enabled) => setEffect('chromaKey', { enabled }, false)}
          onReset={() => resetEffect('chromaKey')}
          onRemove={() => removeEffect('chromaKey')}
        >
          <SliderRow label={t('inspector.similarity')} value={clip.chromaKey.similarity} onChange={(similarity) => setEffect('chromaKey', { similarity })} />
          <SliderRow label={t('inspector.smoothness')} value={clip.chromaKey.smoothness} onChange={(smoothness) => setEffect('chromaKey', { smoothness })} />
          <SliderRow label={t('inspector.spill')} value={clip.chromaKey.spill} onChange={(spill) => setEffect('chromaKey', { spill })} />
        </Section>
      )}

      {shownEffects.some((effect) => effect.id === 'pixelArt') && (
        <Section
          {...sectionProps('pixelArt')}
          title={t('inspector.pixelArt')}
          enabled={clip.pixelArt.enabled}
          onEnabledChange={(enabled) => setEffect('pixelArt', { enabled }, false)}
          onReset={() => resetEffect('pixelArt')}
          onRemove={() => removeEffect('pixelArt')}
        >
          <SliderRow label={t('inspector.pixelSize')} value={clip.pixelArt.pixelSize} min={1} max={32} step={1} format={(value) => `${Math.round(value)} px`} onChange={(pixelSize) => setEffect('pixelArt', { pixelSize })} />
          <SliderRow label={t('inspector.paletteSteps')} value={clip.pixelArt.paletteSteps} min={0} max={32} step={1} format={(value) => String(Math.round(value))} onChange={(paletteSteps) => setEffect('pixelArt', { paletteSteps })} />
          <SliderRow label={t('inspector.alphaCutoff')} value={clip.pixelArt.alphaThreshold} onChange={(alphaThreshold) => setEffect('pixelArt', { alphaThreshold })} />
          <p className="text-2xs leading-relaxed text-slate-400">{t('inspector.pixelArtHint')}</p>
        </Section>
      )}

      {addable.length > 0 && (
        <div className="p-2">
          <button
            ref={addButton}
            type="button"
            data-testid="inspector-add-effect"
            aria-haspopup="menu"
            className="tool-button h-control w-full justify-center border border-dashed border-panel-600"
            onClick={() => {
              const box = addButton.current?.getBoundingClientRect();
              openMenu(
                { preventDefault: () => undefined, clientX: box?.left ?? 0, clientY: (box?.bottom ?? 0) + 4 },
                addable.map((effect) => ({ label: t(effect.label), onSelect: () => addEffect(effect.id) })),
                { label: t('inspector.addEffect') },
              );
            }}
          >
            <Plus size={13} />
            {t('inspector.addEffect')}
          </button>
        </div>
      )}
    </>
  );

  /* Audio tab --------------------------------------------------------------- */

  const eq = clip.eq;
  const setEq = (patch: Partial<typeof eq>): void => updateClip(clip.id, { eq: { ...eq, ...patch } }, `eq:${clip.id}`);
  const audioTab = (
    <>
      <Section
        {...sectionProps('level')}
        title={t('inspector.level')}
        onReset={() => updateClip(clip.id, { volume: 1, pan: 0 })}
      >
        {levelRows}
      </Section>
      {audioOnly && (
        <Section {...sectionProps('eq')} title={t('inspector.equalizer')} onReset={() => updateClip(clip.id, { eq: { low: 0, mid: 0, high: 0 } }, `eq:${clip.id}`)}>
          <SliderRow label={t('inspector.eqLow')} value={eq.low} min={-24} max={24} step={0.5} format={signedDb} onChange={(low) => setEq({ low })} />
          <SliderRow label={t('inspector.eqMid')} value={eq.mid} min={-24} max={24} step={0.5} format={signedDb} onChange={(mid) => setEq({ mid })} />
          <SliderRow label={t('inspector.eqHigh')} value={eq.high} min={-24} max={24} step={0.5} format={signedDb} onChange={(high) => setEq({ high })} />
        </Section>
      )}
      <p className="p-3 text-2xs leading-relaxed text-slate-400">{t(audioOnly ? 'inspector.audioMixerHint' : 'inspector.videoMixerHint')}</p>
    </>
  );

  /* Color tab --------------------------------------------------------------- */

  const grading = clip.colorGrading;
  const setGrading = (patch: Partial<typeof grading>, merge = true): void =>
    // Moving a grade turns the grade on: a slider that changes nothing on
    // screen reads as broken.
    updateClip(clip.id, { colorGrading: { ...grading, enabled: true, ...patch } }, merge ? `grade:${clip.id}` : undefined);
  const colorTab = (
    <>
      <Section
        {...sectionProps('grading')}
        title={t('inspector.colorGrading')}
        enabled={grading.enabled}
        onEnabledChange={(enabled) => setGrading({ enabled }, false)}
        onReset={() =>
          updateClip(clip.id, {
            colorGrading: { ...grading, ...DEFAULTS.colorGrading, enabled: grading.enabled, lutUri: grading.lutUri, lutName: grading.lutName, lutSourcePath: grading.lutSourcePath, lutIntensity: grading.lutIntensity },
          })
        }
      >
        <SliderRow label={t('inspector.exposure')} value={grading.exposure} min={-2} max={2} onChange={(exposure) => setGrading({ exposure })} />
        <SliderRow label={t('inspector.contrast')} value={grading.contrast} max={2} onChange={(contrast) => setGrading({ contrast })} />
        <SliderRow label={t('inspector.saturation')} value={grading.saturation} max={2} onChange={(saturation) => setGrading({ saturation })} />
        <SliderRow label={t('inspector.temperature')} value={grading.temperature} min={-1} max={1} onChange={(temperature) => setGrading({ temperature })} />
        <SliderRow label={t('inspector.tint')} value={grading.tint} min={-1} max={1} onChange={(tint) => setGrading({ tint })} />
      </Section>

      <Section {...sectionProps('lut')} title={t('inspector.lut')}>
        <div className="flex items-center gap-2">
          <button type="button" className="tool-button h-control flex-1 justify-start border border-panel-600" onClick={() => void pickLut(clip.id)}>
            <FolderOpen size={13} />
            {grading.lutUri ? t('inspector.replaceLut') : t('inspector.loadLut')}
          </button>
          {grading.lutUri && (
            <button
              type="button"
              className="tool-button h-control w-7 px-0 hover:text-red-400"
              onClick={() => updateClip(clip.id, { colorGrading: { ...grading, lutUri: undefined, lutSourcePath: undefined, lutName: undefined } })}
              {...tip(t('inspector.removeLut'))}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
        <input
          ref={lutInputRef}
          type="file"
          accept=".cube"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void file.text().then((text) => applyLut(clip.id, file.name, text));
          }}
        />
        {lutError && (
          <p role="alert" className="text-2xs text-red-400">
            {lutError}
          </p>
        )}
        <p className="truncate text-2xs text-slate-400">
          {grading.lutUri
            ? `${grading.lutName ?? t('inspector.lutLoaded')}${grading.lutSourcePath ? '' : ` ${t('inspector.lutNotSaved')}`}`
            : t('inspector.noLut')}
        </p>
        {grading.lutUri && (
          <SliderRow label={t('inspector.lutIntensity')} value={grading.lutIntensity} format={percent} onChange={(lutIntensity) => setGrading({ lutIntensity })} />
        )}
      </Section>
    </>
  );

  const tabId = (id: Tab): string => `inspector-tab-${id}`;

  return (
    <aside data-testid="inspector-panel" className="panel w-full">
      {/* The name as the file has it. */}
      <header className="panel-header">
        <span className="truncate" title={clip.name}>
          {clip.name}
        </span>
      </header>

      {/* Only the tabs that apply; a segmented control, as Resolve's are. */}
      <div
        ref={tabIndicator.containerRef}
        role="tablist"
        aria-label={t('inspector.title')}
        className="relative flex shrink-0 gap-0.5 border-b border-panel-800 px-2 py-1.5"
      >
        <span ref={tabIndicator.indicatorRef} aria-hidden className="scf-indicator rounded-control bg-panel-700" />
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={tabId(id)}
            aria-selected={current === id}
            aria-controls="inspector-tabpanel"
            tabIndex={current === id ? 0 : -1}
            className={`relative h-control-dense flex-1 rounded-control text-xs transition-colors ${
              current === id ? 'font-semibold text-slate-100' : 'text-slate-400 hover:bg-panel-800 hover:text-slate-200'
            }`}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              // Arrow keys move between tabs, as a tab list should.
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              event.stopPropagation();
              const next = tabs[(tabs.indexOf(current) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              setTab(next);
              document.getElementById(tabId(next))?.focus();
            }}
          >
            {t(TAB_LABELS[id])}
          </button>
        ))}
      </div>

      <div ref={tabPanelRef} id="inspector-tabpanel" role="tabpanel" aria-labelledby={tabId(current)} data-tab={current} className="min-h-0 flex-1 overflow-y-auto">
        {current === 'video' && videoTab}
        {current === 'audio' && audioTab}
        {current === 'color' && colorTab}
        {current === 'info' && <InfoRows clip={clip} asset={asset} fps={project.fps} />}
      </div>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </aside>
  );
}

export default Inspector;
