import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ChevronDown, Diamond, FolderOpen, Trash2 } from 'lucide-react';
import type { Clip, MaskConfig, MediaAsset, ProjectState } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { evaluateNumber, evaluateVector } from '@renderer/engine/KeyframeEvaluator';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { dbLabel, panLabel, signedDb } from '@renderer/audio/levels';
import { useT, type MessageKey } from '@renderer/i18n';
import { useProjectStore, type NumberProperty, type VectorProperty } from '@renderer/store/useProjectStore';

/**
 * Property inspector for the selected clip: transform with keyframes, mask,
 * color grading with a LUT slot, chroma key and the pixel-art filter.
 *
 * Every numeric control writes through `updateClip` with a merge key, so
 * dragging a slider produces one undo step rather than one per pixel.
 *
 * Values are shown in the units an editor is read in, not the ones the engine
 * stores: scale and opacity in percent, rotation in degrees, level in dB and
 * pan as L/C/R - the same readings the Mixer gives, so one clip never shows
 * two different numbers for one setting. The engine's own values are
 * untouched; only the display and the typing are converted.
 */

interface FieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number, inside the field: "%", "px", "°". */
  unit?: string;
  /** Displayed value = stored value x this; typing divides it back out. */
  factor?: number;
  onChange(value: number): void;
}

function NumberField({ label, value, min, max, step = 0.01, unit, factor = 1, onChange }: FieldProps): JSX.Element {
  const shown = Number.isFinite(value) ? Number((value * factor).toFixed(4)) : 0;
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      <span className="relative block">
        <input
          type="number"
          className={`numeric-input timecode ${unit ? 'pr-7' : ''}`}
          value={shown}
          min={min === undefined ? undefined : min * factor}
          max={max === undefined ? undefined : max * factor}
          step={step}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value) / factor)}
        />
        {unit && (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-slate-400">
            {unit}
          </span>
        )}
      </span>
    </label>
  );
}

interface SliderProps extends FieldProps {
  /** How the value is read out beside the label; two decimals when absent. */
  format?(value: number): string;
}

function SliderField({ label, value, min = 0, max = 1, step = 0.01, format, onChange }: SliderProps): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label flex items-center justify-between gap-2">
        <span>{label}</span>
        <span className="timecode text-slate-300">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        className="w-full accent-blue-500"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }): JSX.Element {
  return (
    <section className="border-b border-panel-800 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="section-title">{title}</h3>
        {right}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-300">
      <input
        type="checkbox"
        className="accent-blue-500"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

const MASK_TYPES: { value: MaskConfig['type']; label: MessageKey }[] = [
  { value: 0, label: 'inspector.maskOff' },
  { value: 1, label: 'inspector.maskRectangle' },
  { value: 2, label: 'inspector.maskEllipse' },
];

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const degrees = (radians: number): string => `${Math.round((radians * 180) / Math.PI)}°`;

/**
 * The clip's technical facts, which used to sit in the header as a bare "RGB"
 * or "Audio" tag beside the name. They are reference, not something to act
 * on, so they go last, folded away like Final Cut's Info inspector, and the
 * header keeps just the name.
 */
function InfoSection({ clip, asset, fps }: { clip: Clip; asset: MediaAsset | undefined; fps: number }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
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
    <section className="px-3 py-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="inspector-info"
        className="flex w-full items-center justify-between rounded-control text-left hover:text-white"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="section-title">{t('inspector.info')}</span>
        <ChevronDown size={13} className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <dl id="inspector-info" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
          {rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-slate-400">{name}</dt>
              <dd className="timecode truncate text-slate-200" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * True for a clip whose source is audio only: it sits on an audio track, or
 * its media is an audio file wherever it sits.
 */
export function isAudioClip(
  clip: Clip,
  project: ProjectState,
  assets: readonly MediaAsset[],
): boolean {
  const track = project.tracks.find((candidate) => candidate.id === clip.trackId);
  if (track?.type === 'audio') return true;
  return assets.find((asset) => asset.uri === clip.sourceUri)?.kind === 'audio';
}

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

  const lutInputRef = useRef<HTMLInputElement>(null);
  const [lutError, setLutError] = useState<string | null>(null);

  /**
   * Load a `.cube` file and upload it before it is referenced, so the very next
   * composited frame already has the look applied.
   */
  const applyLut = useCallback(
    async (clipId: string, name: string, contents: string, sourcePath?: string) => {
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
    },
    [],
  );

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
          {selectedIds.length > 1
            ? t('inspector.manySelected', { count: selectedIds.length })
            : t('inspector.noneSelected')}
        </p>
      </aside>
    );
  }

  const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
  // The name as the file has it: the header used to set it in capitals.
  const header = (
    <header className="panel-header">
      <span className="truncate" title={clip.name}>
        {clip.name}
      </span>
    </header>
  );

  const levelSection = (
    <>
      <SliderField
        label={t('inspector.volume')}
        value={clip.volume}
        max={2}
        format={dbLabel}
        onChange={(volume) => updateClip(clip.id, { volume }, `volume:${clip.id}`)}
      />
      <SliderField
        label={t('inspector.pan')}
        value={clip.pan}
        min={-1}
        max={1}
        format={panLabel}
        onChange={(pan) => updateClip(clip.id, { pan }, `pan:${clip.id}`)}
      />
    </>
  );

  // An audio clip has no picture: transform, mask, grading, chroma key and
  // pixel art mean nothing for it, and showing them - as the inspector did -
  // only buries the controls that do apply.
  if (isAudioClip(clip, project, assets)) {
    const eq = clip.eq;
    const setEq = (patch: Partial<typeof eq>): void =>
      updateClip(clip.id, { eq: { ...eq, ...patch } }, `eq:${clip.id}`);

    return (
      <aside data-testid="inspector-panel" className="panel w-full">
        {header}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title={t('inspector.level')}>{levelSection}</Section>

          <Section
            title={t('inspector.equalizer')}
            right={
              <button
                type="button"
                className="text-2xs text-slate-400 hover:text-slate-300"
                onClick={() => updateClip(clip.id, { eq: { low: 0, mid: 0, high: 0 } }, `eq:${clip.id}`)}
              >
                {t('inspector.reset')}
              </button>
            }
          >
            <SliderField label={t('inspector.eqLow')} value={eq.low} min={-24} max={24} step={0.5} format={signedDb} onChange={(low) => setEq({ low })} />
            <SliderField label={t('inspector.eqMid')} value={eq.mid} min={-24} max={24} step={0.5} format={signedDb} onChange={(mid) => setEq({ mid })} />
            <SliderField label={t('inspector.eqHigh')} value={eq.high} min={-24} max={24} step={0.5} format={signedDb} onChange={(high) => setEq({ high })} />
          </Section>

          <p className="border-b border-panel-800 px-3 py-3 text-2xs text-slate-400">{t('inspector.audioMixerHint')}</p>
          <InfoSection clip={clip} asset={asset} fps={project.fps} />
        </div>
      </aside>
    );
  }

  const keyframeButton = (
    property: VectorProperty | NumberProperty,
    count: number,
  ): JSX.Element => (
    <span className="flex items-center gap-1">
      <span className="text-2xs text-slate-400">{count}</span>
      <Diamond size={11} className={count > 0 ? 'text-accent' : 'text-slate-400'} />
      {count > 0 && (
        <button
          type="button"
          title={t('inspector.clearKeyframes', { property })}
          className="text-slate-400 hover:text-red-400"
          onClick={() => clearKeyframes(clip.id, property)}
        >
          <Trash2 size={11} />
        </button>
      )}
    </span>
  );

  return (
    <aside data-testid="inspector-panel" className="panel w-full">
      {header}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title={t('inspector.transform')} right={keyframeButton('position', clip.transform.position.length)}>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label={t('inspector.positionX')}
              unit="px"
              value={resolved.position.x}
              step={1}
              onChange={(x) => setVectorKeyframe(clip.id, 'position', frame, { ...resolved.position, x })}
            />
            <NumberField
              label={t('inspector.positionY')}
              unit="px"
              value={resolved.position.y}
              step={1}
              onChange={(y) => setVectorKeyframe(clip.id, 'position', frame, { ...resolved.position, y })}
            />
            <NumberField
              label={t('inspector.scaleX')}
              unit="%"
              factor={100}
              step={1}
              value={resolved.scale.x}
              onChange={(x) => setVectorKeyframe(clip.id, 'scale', frame, { ...resolved.scale, x })}
            />
            <NumberField
              label={t('inspector.scaleY')}
              unit="%"
              factor={100}
              step={1}
              value={resolved.scale.y}
              onChange={(y) => setVectorKeyframe(clip.id, 'scale', frame, { ...resolved.scale, y })}
            />
            <NumberField
              label={t('inspector.rotation')}
              unit="°"
              value={resolved.rotation}
              step={0.5}
              onChange={(value) => setNumberKeyframe(clip.id, 'rotation', frame, value)}
            />
            <NumberField
              label={t('inspector.opacity')}
              unit="%"
              factor={100}
              step={1}
              value={resolved.opacity}
              min={0}
              max={1}
              onChange={(value) => setNumberKeyframe(clip.id, 'opacity', frame, value)}
            />
          </div>
          <p className="text-2xs text-slate-400">{t('inspector.keyframeHint', { frame })}</p>
        </Section>

        <Section title={t('inspector.mask')}>
          <Toggle
            label={t('inspector.enableMask')}
            checked={clip.mask.enabled}
            onChange={(enabled) => updateClip(clip.id, { mask: { ...clip.mask, enabled } })}
          />
          <label className="flex flex-col gap-1">
            <span className="field-label">{t('inspector.shape')}</span>
            <select
              className="numeric-input"
              value={clip.mask.type}
              onChange={(event) =>
                updateClip(clip.id, {
                  mask: { ...clip.mask, type: Number(event.target.value) as MaskConfig['type'] },
                })
              }
            >
              {MASK_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label={t('inspector.centerX')}
              value={clip.mask.center.x}
              onChange={(x) =>
                updateClip(clip.id, { mask: { ...clip.mask, center: { ...clip.mask.center, x } } }, `mask:${clip.id}`)
              }
            />
            <NumberField
              label={t('inspector.centerY')}
              value={clip.mask.center.y}
              onChange={(y) =>
                updateClip(clip.id, { mask: { ...clip.mask, center: { ...clip.mask.center, y } } }, `mask:${clip.id}`)
              }
            />
            <NumberField
              label={t('inspector.sizeX')}
              value={clip.mask.size.x}
              onChange={(x) =>
                updateClip(clip.id, { mask: { ...clip.mask, size: { ...clip.mask.size, x } } }, `mask:${clip.id}`)
              }
            />
            <NumberField
              label={t('inspector.sizeY')}
              value={clip.mask.size.y}
              onChange={(y) =>
                updateClip(clip.id, { mask: { ...clip.mask, size: { ...clip.mask.size, y } } }, `mask:${clip.id}`)
              }
            />
          </div>

          <SliderField
            label={t('inspector.cornerRadius')}
            value={clip.mask.cornerRadius}
            max={0.5}
            onChange={(cornerRadius) =>
              updateClip(clip.id, { mask: { ...clip.mask, cornerRadius } }, `mask:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.feather')}
            value={clip.mask.feather}
            max={200}
            step={1}
            format={(value) => `${Math.round(value)} px`}
            onChange={(feather) => updateClip(clip.id, { mask: { ...clip.mask, feather } }, `mask:${clip.id}`)}
          />
          <SliderField
            label={t('inspector.maskRotation')}
            value={clip.mask.rotation}
            min={-Math.PI}
            max={Math.PI}
            format={degrees}
            onChange={(rotation) => updateClip(clip.id, { mask: { ...clip.mask, rotation } }, `mask:${clip.id}`)}
          />
          <Toggle
            label={t('inspector.invertMask')}
            checked={clip.mask.invert}
            onChange={(invert) => updateClip(clip.id, { mask: { ...clip.mask, invert } })}
          />
        </Section>

        <Section title={t('inspector.colorGrading')}>
          <Toggle
            label={t('inspector.enableGrading')}
            checked={clip.colorGrading.enabled}
            onChange={(enabled) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, enabled } })
            }
          />
          <SliderField
            label={t('inspector.exposure')}
            value={clip.colorGrading.exposure}
            min={-2}
            max={2}
            onChange={(exposure) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, exposure } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.contrast')}
            value={clip.colorGrading.contrast}
            max={2}
            onChange={(contrast) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, contrast } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.saturation')}
            value={clip.colorGrading.saturation}
            max={2}
            onChange={(saturation) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, saturation } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.temperature')}
            value={clip.colorGrading.temperature}
            min={-1}
            max={1}
            onChange={(temperature) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, temperature } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.tint')}
            value={clip.colorGrading.tint}
            min={-1}
            max={1}
            onChange={(tint) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, tint } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.lutIntensity')}
            value={clip.colorGrading.lutIntensity}
            format={percent}
            onChange={(lutIntensity) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, lutIntensity } }, `grade:${clip.id}`)
            }
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="tool-button flex-1 justify-start"
              onClick={() => void pickLut(clip.id)}
            >
              <FolderOpen size={13} />
              {clip.colorGrading.lutUri ? t('inspector.replaceLut') : t('inspector.loadLut')}
            </button>
            {clip.colorGrading.lutUri && (
              <button
                type="button"
                title={t('inspector.removeLut')}
                aria-label={t('inspector.removeLut')}
                className="tool-button hover:text-red-400"
                onClick={() =>
                  updateClip(clip.id, {
                    colorGrading: {
                      ...clip.colorGrading,
                      lutUri: undefined,
                      lutSourcePath: undefined,
                      lutName: undefined,
                    },
                  })
                }
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
          {lutError && <p role="alert" className="text-2xs text-red-400">{lutError}</p>}
          <p className="truncate text-2xs text-slate-400">
            {clip.colorGrading.lutUri
              ? `${clip.colorGrading.lutName ?? t('inspector.lutLoaded')}${
                  clip.colorGrading.lutSourcePath ? '' : ` ${t('inspector.lutNotSaved')}`
                }`
              : t('inspector.noLut')}
          </p>
        </Section>

        <Section title={t('inspector.chromaKey')}>
          <Toggle
            label={t('inspector.enableChromaKey')}
            checked={clip.chromaKey.enabled}
            onChange={(enabled) => updateClip(clip.id, { chromaKey: { ...clip.chromaKey, enabled } })}
          />
          <SliderField
            label={t('inspector.similarity')}
            value={clip.chromaKey.similarity}
            onChange={(similarity) =>
              updateClip(clip.id, { chromaKey: { ...clip.chromaKey, similarity } }, `key:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.smoothness')}
            value={clip.chromaKey.smoothness}
            onChange={(smoothness) =>
              updateClip(clip.id, { chromaKey: { ...clip.chromaKey, smoothness } }, `key:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.spill')}
            value={clip.chromaKey.spill}
            onChange={(spill) =>
              updateClip(clip.id, { chromaKey: { ...clip.chromaKey, spill } }, `key:${clip.id}`)
            }
          />
        </Section>

        <Section title={t('inspector.pixelArt')}>
          <Toggle
            label={t('inspector.enablePixelArt')}
            checked={clip.pixelArt.enabled}
            onChange={(enabled) => updateClip(clip.id, { pixelArt: { ...clip.pixelArt, enabled } })}
          />
          <SliderField
            label={t('inspector.pixelSize')}
            value={clip.pixelArt.pixelSize}
            min={1}
            max={32}
            step={1}
            format={(value) => `${Math.round(value)} px`}
            onChange={(pixelSize) =>
              updateClip(clip.id, { pixelArt: { ...clip.pixelArt, pixelSize } }, `pixel:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.paletteSteps')}
            value={clip.pixelArt.paletteSteps}
            min={0}
            max={32}
            step={1}
            format={(value) => String(Math.round(value))}
            onChange={(paletteSteps) =>
              updateClip(clip.id, { pixelArt: { ...clip.pixelArt, paletteSteps } }, `pixel:${clip.id}`)
            }
          />
          <SliderField
            label={t('inspector.alphaCutoff')}
            value={clip.pixelArt.alphaThreshold}
            onChange={(alphaThreshold) =>
              updateClip(clip.id, { pixelArt: { ...clip.pixelArt, alphaThreshold } }, `pixel:${clip.id}`)
            }
          />
          <p className="text-2xs text-slate-400">{t('inspector.pixelArtHint')}</p>
        </Section>

        <Section title={t('inspector.audio')}>
          {levelSection}
          <p className="text-2xs text-slate-400">{t('inspector.videoMixerHint')}</p>
        </Section>

        <InfoSection clip={clip} asset={asset} fps={project.fps} />
      </div>
    </aside>
  );
}

export default Inspector;
