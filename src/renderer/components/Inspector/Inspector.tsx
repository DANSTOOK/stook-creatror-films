import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Diamond, FolderOpen, Plus, RotateCcw, Trash2 } from 'lucide-react';
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
import { ColorWheels, neutralWheels, type WheelMode } from './ColorWheels';
import { CurveEditor } from './CurveEditor';
import { LEVEL_CURVES, OFFSET_CURVES, neutralCurve, type LevelCurve, type OffsetCurve } from '@renderer/color/curves';
import { neutralVignette } from '@renderer/color/grade';
import { NumberRow, PairRow, Section, SliderRow, SwitchRow, type SectionProps } from './rows';
import { TitleTab } from './TitleTab';

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

type Tab = 'title' | 'video' | 'audio' | 'color' | 'info';
type Effect = 'mask' | 'chromaKey' | 'pixelArt';

const TAB_LABELS: Record<Tab, MessageKey> = {
  title: 'inspector.tabTitle',
  video: 'inspector.tabVideo',
  audio: 'inspector.tabAudio',
  color: 'inspector.tabColor',
  info: 'inspector.tabInfo',
};

/** The settings a new clip starts with, to reset a section to. */
const WHEEL_MODE_KEY = 'scf.wheelMode';

const CURVE_NAME: Record<LevelCurve | OffsetCurve, MessageKey> = {
  master: 'curves.master',
  red: 'curves.red',
  green: 'curves.green',
  blue: 'curves.blue',
  hueVsHue: 'curves.hueVsHue',
  hueVsSat: 'curves.hueVsSat',
  hueVsLuma: 'curves.hueVsLuma',
  lumaVsSat: 'curves.lumaVsSat',
};
/** The dot beside each level curve's name, in its channel's colour. */
const CURVE_DOT: Record<LevelCurve, string> = { master: 'bg-slate-200', red: 'bg-red-400', green: 'bg-green-400', blue: 'bg-blue-400' };

const DEFAULTS = createClip({ trackId: '', name: '', sourceUri: '', startFrame: 0, durationFrames: 1 });

const MASK_TYPES: { value: MaskConfig['type']; label: MessageKey }[] = [
  { value: 1, label: 'inspector.maskRectangle' },
  { value: 2, label: 'inspector.maskEllipse' },
];

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const degrees = (radians: number): string => `${Math.round((radians * 180) / Math.PI)}°`;

/* Info -------------------------------------------------------------------- */

/** The clip's technical facts, like Final Cut's Info inspector. */
function InfoRows({ clip, asset, fps }: { clip: Clip; asset: MediaAsset | undefined; fps: number }): JSX.Element {
  const t = useT();
  const kind = clip.title ? 'title' : asset?.kind ?? (clip.hasAlphaChannel ? 'image' : 'video');
  const rows: Array<[string, string]> = [
    [
      t('inspector.infoType'),
      t(kind === 'title' ? 'inspector.kindTitle' : kind === 'audio' ? 'inspector.kindAudio' : kind === 'image' ? 'inspector.kindImage' : 'inspector.kindVideo'),
    ],
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
  // A title opens on its own tab, where what it says and how it looks are.
  const isTitle = Boolean(clip?.title);
  useEffect(() => {
    if (isTitle) setTab('title');
  }, [clip?.id, isTitle]);
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

  /** Wheels or numbers for the primaries: a preference, kept across sessions. */
  /** Which curve each curves group shows: a choice about the inspector, kept across clips. */
  const [levelCurve, setLevelCurve] = useState<LevelCurve>('master');
  const [versusCurve, setVersusCurve] = useState<OffsetCurve>('hueVsHue');

  const [wheelMode, setWheelModeState] = useState<WheelMode>(() => {
    try {
      return window.localStorage.getItem(WHEEL_MODE_KEY) === 'numbers' ? 'numbers' : 'wheels';
    } catch {
      return 'wheels';
    }
  });
  const setWheelMode = (mode: WheelMode): void => {
    setWheelModeState(mode);
    try {
      window.localStorage.setItem(WHEEL_MODE_KEY, mode);
    } catch {
      // Kept for this session only.
    }
  };

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
  // Only the tabs that mean something for this clip. A title has no sound, and
  // its colours are set on the Title tab rather than graded.
  const tabs: Tab[] = clip.title
    ? ['title', 'video', 'info']
    : audioOnly ? ['audio', 'info'] : still ? ['video', 'color', 'info'] : ['video', 'audio', 'color', 'info'];
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
  /**
   * Moving a grade turns the grade on: a slider that changes nothing on
   * screen reads as broken. Each control is its own undo step; a drag of
   * one is a single step.
   */
  const setGrading = (patch: Partial<typeof grading>, control: string | false = 'basic'): void =>
    updateClip(clip.id, { colorGrading: { ...grading, enabled: true, ...patch } }, control ? `grade:${clip.id}:${control}` : undefined);
  const basicDefaults = DEFAULTS.colorGrading;
  const colorTab = (
    <>
      <Section
        {...sectionProps('grading')}
        title={t('inspector.colorGrading')}
        enabled={grading.enabled}
        onEnabledChange={(enabled) => setGrading({ enabled }, false)}
        onReset={() =>
          // This group only: the wheels and the look have their own resets.
          updateClip(clip.id, {
            colorGrading: {
              ...grading,
              exposure: basicDefaults.exposure,
              temperature: basicDefaults.temperature,
              tint: basicDefaults.tint,
              contrast: basicDefaults.contrast,
              pivot: basicDefaults.pivot,
              saturation: basicDefaults.saturation,
            },
          })
        }
      >
        {/* In the order they are applied: light, white balance, then tone. */}
        <SliderRow label={t('inspector.exposure')} value={grading.exposure} min={-2} max={2} onChange={(exposure) => setGrading({ exposure }, 'exposure')} />
        <SliderRow label={t('inspector.temperature')} value={grading.temperature} min={-1} max={1} onChange={(temperature) => setGrading({ temperature }, 'temperature')} />
        <SliderRow label={t('inspector.tint')} value={grading.tint} min={-1} max={1} onChange={(tint) => setGrading({ tint }, 'tint')} />
        <SliderRow label={t('inspector.contrast')} value={grading.contrast} max={2} onChange={(contrast) => setGrading({ contrast }, 'contrast')} />
        <SliderRow label={t('inspector.pivot')} value={grading.pivot} onChange={(pivot) => setGrading({ pivot }, 'pivot')} />
        <SliderRow label={t('inspector.saturation')} value={grading.saturation} max={2} onChange={(saturation) => setGrading({ saturation }, 'saturation')} />
      </Section>

      <Section
        {...sectionProps('primaries')}
        title={t('grade.primaries')}
        right={
          <span role="group" aria-label={t('grade.mode')} className="mr-1 flex items-center gap-0.5">
            {(['wheels', 'numbers'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`wheel-mode-${mode}`}
                aria-pressed={wheelMode === mode}
                className={`tool-button tool-button-dense px-1.5 text-2xs ${wheelMode === mode ? 'tool-button-active' : ''}`}
                onClick={() => setWheelMode(mode)}
              >
                {t(mode === 'wheels' ? 'grade.wheelsMode' : 'grade.numbersMode')}
              </button>
            ))}
          </span>
        }
        onReset={() => updateClip(clip.id, { colorGrading: { ...grading, ...neutralWheels() } })}
      >
        <ColorWheels
          values={{ lift: grading.lift, gamma: grading.gamma, gain: grading.gain, offset: grading.offset }}
          mode={wheelMode}
          onChange={(wheel, value) => setGrading({ [wheel]: value }, wheel)}
        />
      </Section>

      {/* Curves: after the wheels, contrast and saturation; before the look. */}
      <Section
        {...sectionProps('curves')}
        title={t('curves.title')}
        onReset={() =>
          updateClip(clip.id, {
            colorGrading: { ...grading, curves: { ...grading.curves, ...Object.fromEntries(LEVEL_CURVES.map((id) => [id, neutralCurve(id)])) } },
          })
        }
      >
        <div className="flex items-center gap-1">
          <span role="group" aria-label={t('curves.choose')} className="flex min-w-0 flex-1 gap-0.5">
            {LEVEL_CURVES.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`curve-pick-${id}`}
                aria-pressed={levelCurve === id}
                className={`tool-button tool-button-dense min-w-0 flex-1 gap-1 px-1 text-2xs ${levelCurve === id ? 'tool-button-active' : ''}`}
                onClick={() => setLevelCurve(id)}
              >
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${CURVE_DOT[id]}`} />
                <span className="truncate">{t(CURVE_NAME[id])}</span>
              </button>
            ))}
          </span>
          <button
            type="button"
            data-testid="curve-reset-level"
            className="tool-button tool-button-dense w-6 px-0"
            onClick={() => setGrading({ curves: { ...grading.curves, [levelCurve]: neutralCurve(levelCurve) } }, false)}
            {...tip(t('curves.reset', { name: t(CURVE_NAME[levelCurve]) }))}
          >
            <RotateCcw size={12} />
          </button>
        </div>
        <CurveEditor
          curve={levelCurve}
          points={grading.curves[levelCurve]}
          label={t(CURVE_NAME[levelCurve])}
          onChange={(points) => setGrading({ curves: { ...grading.curves, [levelCurve]: points } }, `curve-${levelCurve}`)}
        />
      </Section>

      <Section
        {...sectionProps('versusCurves')}
        title={t('curves.versusTitle')}
        onReset={() =>
          updateClip(clip.id, {
            colorGrading: { ...grading, curves: { ...grading.curves, ...Object.fromEntries(OFFSET_CURVES.map((id) => [id, neutralCurve(id)])) } },
          })
        }
      >
        <div className="flex items-center gap-1">
          <label className="sr-only" htmlFor="versus-curve">
            {t('curves.choose')}
          </label>
          <select
            id="versus-curve"
            data-testid="curve-pick-versus"
            className="numeric-input h-control-dense min-w-0 flex-1 text-2xs"
            value={versusCurve}
            onChange={(event) => setVersusCurve(event.target.value as OffsetCurve)}
          >
            {OFFSET_CURVES.map((id) => (
              <option key={id} value={id}>
                {t(CURVE_NAME[id])}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="curve-reset-versus"
            className="tool-button tool-button-dense w-6 px-0"
            onClick={() => setGrading({ curves: { ...grading.curves, [versusCurve]: neutralCurve(versusCurve) } }, false)}
            {...tip(t('curves.reset', { name: t(CURVE_NAME[versusCurve]) }))}
          >
            <RotateCcw size={12} />
          </button>
        </div>
        <CurveEditor
          curve={versusCurve}
          points={grading.curves[versusCurve]}
          label={t(CURVE_NAME[versusCurve])}
          onChange={(points) => setGrading({ curves: { ...grading.curves, [versusCurve]: points } }, `curve-${versusCurve}`)}
        />
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

      {/* The vignette, after the look, as Lumetri orders them. */}
      <Section
        {...sectionProps('vignette')}
        title={t('vignette.title')}
        onReset={() => updateClip(clip.id, { colorGrading: { ...grading, vignette: neutralVignette() } })}
      >
        <SliderRow label={t('vignette.amount')} value={grading.vignette.amount} min={-1} max={1} onChange={(amount) => setGrading({ vignette: { ...grading.vignette, amount } }, 'vignette-amount')} />
        <SliderRow label={t('vignette.size')} value={grading.vignette.size} onChange={(size) => setGrading({ vignette: { ...grading.vignette, size } }, 'vignette-size')} />
        <SliderRow label={t('vignette.roundness')} value={grading.vignette.roundness} min={-1} max={1} onChange={(roundness) => setGrading({ vignette: { ...grading.vignette, roundness } }, 'vignette-roundness')} />
        <SliderRow label={t('vignette.feather')} value={grading.vignette.feather} onChange={(feather) => setGrading({ vignette: { ...grading.vignette, feather } }, 'vignette-feather')} />
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
        {current === 'title' && (
          <TitleTab
            clip={clip}
            frame={{ width: project.width, height: project.height, fps: project.fps }}
            sectionProps={sectionProps}
            position={resolved.position}
            onPosition={(axis, value) => setVectorKeyframe(clip.id, 'position', frame, { ...resolved.position, [axis]: value })}
          />
        )}
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
