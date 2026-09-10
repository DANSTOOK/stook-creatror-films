import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Diamond, FolderOpen, Trash2 } from 'lucide-react';
import type { Clip, MaskConfig } from '@shared/types';
import { evaluateNumber, evaluateVector } from '@renderer/engine/KeyframeEvaluator';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { useProjectStore, type NumberProperty, type VectorProperty } from '@renderer/store/useProjectStore';

/**
 * Property inspector for the selected clip: transform with keyframes, mask,
 * color grading with a LUT slot, chroma key and the pixel-art filter.
 *
 * Every numeric control writes through `updateClip` with a merge key, so
 * dragging a slider produces one undo step rather than one per pixel.
 */

interface FieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
}

function NumberField({ label, value, min, max, step = 0.01, onChange }: FieldProps): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      <input
        type="number"
        className="numeric-input"
        value={Number.isFinite(value) ? Number(value.toFixed(4)) : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SliderField({ label, value, min = 0, max = 1, step = 0.01, onChange }: FieldProps): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label">
        {label} <span className="text-slate-400">{value.toFixed(2)}</span>
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
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
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

const MASK_TYPES: { value: MaskConfig['type']; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Rectangle' },
  { value: 2, label: 'Ellipse' },
];

export function Inspector(): JSX.Element {
  const project = useProjectStore((state) => state.project);
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
  const loadLut = useCallback(
    async (file: File | undefined, clipId: string) => {
      if (!file) return;
      setLutError(null);

      try {
        const uri = URL.createObjectURL(new Blob([await file.text()], { type: 'text/plain' }));
        const renderer = getActiveFrameRenderer();
        // Parsing happens here, so a malformed file reports an error rather
        // than silently doing nothing when the frame is drawn.
        await renderer?.lutLoader.load(uri);

        const current = useProjectStore.getState().project.clips[clipId];
        if (!current) return;

        useProjectStore.getState().updateClip(clipId, {
          colorGrading: { ...current.colorGrading, enabled: true, lutUri: uri },
        });
      } catch (error) {
        setLutError(error instanceof Error ? error.message : String(error));
      }
    },
    [],
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
      <aside className="panel w-[300px] shrink-0">
        <header className="panel-header">Inspector</header>
        <p className="p-4 text-xs text-slate-500">
          {selectedIds.length > 1
            ? `${selectedIds.length} clips selected. Select a single clip to edit its properties.`
            : 'Select a clip on the timeline to edit its properties.'}
        </p>
      </aside>
    );
  }

  const keyframeButton = (
    property: VectorProperty | NumberProperty,
    count: number,
  ): JSX.Element => (
    <span className="flex items-center gap-1">
      <span className="text-2xs text-slate-500">{count}</span>
      <Diamond size={11} className={count > 0 ? 'text-accent' : 'text-slate-600'} />
      {count > 0 && (
        <button
          type="button"
          title={`Clear ${property} keyframes`}
          className="text-slate-600 hover:text-red-400"
          onClick={() => clearKeyframes(clip.id, property)}
        >
          <Trash2 size={11} />
        </button>
      )}
    </span>
  );

  return (
    <aside className="panel w-[300px] shrink-0">
      <header className="panel-header justify-between">
        <span className="truncate">{clip.name}</span>
        <span className="normal-case tracking-normal text-slate-500">
          {clip.hasAlphaChannel ? 'RGBA' : 'RGB'}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Transform" right={keyframeButton('position', clip.transform.position.length)}>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Position X (px)"
              value={resolved.position.x}
              step={1}
              onChange={(x) => setVectorKeyframe(clip.id, 'position', frame, { ...resolved.position, x })}
            />
            <NumberField
              label="Position Y (px)"
              value={resolved.position.y}
              step={1}
              onChange={(y) => setVectorKeyframe(clip.id, 'position', frame, { ...resolved.position, y })}
            />
            <NumberField
              label="Scale X"
              value={resolved.scale.x}
              onChange={(x) => setVectorKeyframe(clip.id, 'scale', frame, { ...resolved.scale, x })}
            />
            <NumberField
              label="Scale Y"
              value={resolved.scale.y}
              onChange={(y) => setVectorKeyframe(clip.id, 'scale', frame, { ...resolved.scale, y })}
            />
            <NumberField
              label="Rotation (deg)"
              value={resolved.rotation}
              step={0.5}
              onChange={(value) => setNumberKeyframe(clip.id, 'rotation', frame, value)}
            />
            <NumberField
              label="Opacity"
              value={resolved.opacity}
              min={0}
              max={1}
              onChange={(value) => setNumberKeyframe(clip.id, 'opacity', frame, value)}
            />
          </div>
          <p className="text-2xs text-slate-600">
            Editing a value adds a keyframe at frame {frame}.
          </p>
        </Section>

        <Section title="Mask">
          <Toggle
            label="Enable mask"
            checked={clip.mask.enabled}
            onChange={(enabled) => updateClip(clip.id, { mask: { ...clip.mask, enabled } })}
          />
          <label className="flex flex-col gap-1">
            <span className="field-label">Shape</span>
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
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Center X"
              value={clip.mask.center.x}
              onChange={(x) =>
                updateClip(clip.id, { mask: { ...clip.mask, center: { ...clip.mask.center, x } } }, `mask:${clip.id}`)
              }
            />
            <NumberField
              label="Center Y"
              value={clip.mask.center.y}
              onChange={(y) =>
                updateClip(clip.id, { mask: { ...clip.mask, center: { ...clip.mask.center, y } } }, `mask:${clip.id}`)
              }
            />
            <NumberField
              label="Size X"
              value={clip.mask.size.x}
              onChange={(x) =>
                updateClip(clip.id, { mask: { ...clip.mask, size: { ...clip.mask.size, x } } }, `mask:${clip.id}`)
              }
            />
            <NumberField
              label="Size Y"
              value={clip.mask.size.y}
              onChange={(y) =>
                updateClip(clip.id, { mask: { ...clip.mask, size: { ...clip.mask.size, y } } }, `mask:${clip.id}`)
              }
            />
          </div>

          <SliderField
            label="Corner radius"
            value={clip.mask.cornerRadius}
            max={0.5}
            onChange={(cornerRadius) =>
              updateClip(clip.id, { mask: { ...clip.mask, cornerRadius } }, `mask:${clip.id}`)
            }
          />
          <SliderField
            label="Feather (px)"
            value={clip.mask.feather}
            max={200}
            step={1}
            onChange={(feather) => updateClip(clip.id, { mask: { ...clip.mask, feather } }, `mask:${clip.id}`)}
          />
          <SliderField
            label="Rotation (rad)"
            value={clip.mask.rotation}
            min={-Math.PI}
            max={Math.PI}
            onChange={(rotation) => updateClip(clip.id, { mask: { ...clip.mask, rotation } }, `mask:${clip.id}`)}
          />
          <Toggle
            label="Invert mask"
            checked={clip.mask.invert}
            onChange={(invert) => updateClip(clip.id, { mask: { ...clip.mask, invert } })}
          />
        </Section>

        <Section title="Color grading">
          <Toggle
            label="Enable grading"
            checked={clip.colorGrading.enabled}
            onChange={(enabled) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, enabled } })
            }
          />
          <SliderField
            label="Exposure"
            value={clip.colorGrading.exposure}
            min={-2}
            max={2}
            onChange={(exposure) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, exposure } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label="Contrast"
            value={clip.colorGrading.contrast}
            max={2}
            onChange={(contrast) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, contrast } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label="Saturation"
            value={clip.colorGrading.saturation}
            max={2}
            onChange={(saturation) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, saturation } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label="Temperature"
            value={clip.colorGrading.temperature}
            min={-1}
            max={1}
            onChange={(temperature) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, temperature } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label="Tint"
            value={clip.colorGrading.tint}
            min={-1}
            max={1}
            onChange={(tint) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, tint } }, `grade:${clip.id}`)
            }
          />
          <SliderField
            label="LUT intensity"
            value={clip.colorGrading.lutIntensity}
            onChange={(lutIntensity) =>
              updateClip(clip.id, { colorGrading: { ...clip.colorGrading, lutIntensity } }, `grade:${clip.id}`)
            }
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="tool-button flex-1 justify-start"
              onClick={() => lutInputRef.current?.click()}
            >
              <FolderOpen size={13} />
              {clip.colorGrading.lutUri ? 'Replace LUT' : 'Load .cube LUT'}
            </button>
            {clip.colorGrading.lutUri && (
              <button
                type="button"
                title="Remove LUT"
                className="tool-button hover:text-red-400"
                onClick={() =>
                  updateClip(clip.id, {
                    colorGrading: { ...clip.colorGrading, lutUri: undefined },
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
              void loadLut(event.target.files?.[0], clip.id);
              event.target.value = '';
            }}
          />
          {lutError && <p className="text-2xs text-red-400">{lutError}</p>}
          <p className="truncate text-2xs text-slate-600">
            {clip.colorGrading.lutUri ? 'LUT loaded' : 'No LUT loaded'}
          </p>
        </Section>

        <Section title="Chroma key">
          <Toggle
            label="Enable chroma key"
            checked={clip.chromaKey.enabled}
            onChange={(enabled) => updateClip(clip.id, { chromaKey: { ...clip.chromaKey, enabled } })}
          />
          <SliderField
            label="Similarity"
            value={clip.chromaKey.similarity}
            onChange={(similarity) =>
              updateClip(clip.id, { chromaKey: { ...clip.chromaKey, similarity } }, `key:${clip.id}`)
            }
          />
          <SliderField
            label="Smoothness"
            value={clip.chromaKey.smoothness}
            onChange={(smoothness) =>
              updateClip(clip.id, { chromaKey: { ...clip.chromaKey, smoothness } }, `key:${clip.id}`)
            }
          />
          <SliderField
            label="Spill removal"
            value={clip.chromaKey.spill}
            onChange={(spill) =>
              updateClip(clip.id, { chromaKey: { ...clip.chromaKey, spill } }, `key:${clip.id}`)
            }
          />
        </Section>

        <Section title="Pixel art">
          <Toggle
            label="Enable pixelization"
            checked={clip.pixelArt.enabled}
            onChange={(enabled) => updateClip(clip.id, { pixelArt: { ...clip.pixelArt, enabled } })}
          />
          <SliderField
            label="Pixel size"
            value={clip.pixelArt.pixelSize}
            min={1}
            max={32}
            step={1}
            onChange={(pixelSize) =>
              updateClip(clip.id, { pixelArt: { ...clip.pixelArt, pixelSize } }, `pixel:${clip.id}`)
            }
          />
          <SliderField
            label="Palette steps"
            value={clip.pixelArt.paletteSteps}
            min={0}
            max={32}
            step={1}
            onChange={(paletteSteps) =>
              updateClip(clip.id, { pixelArt: { ...clip.pixelArt, paletteSteps } }, `pixel:${clip.id}`)
            }
          />
          <SliderField
            label="Alpha cutoff"
            value={clip.pixelArt.alphaThreshold}
            onChange={(alphaThreshold) =>
              updateClip(clip.id, { pixelArt: { ...clip.pixelArt, alphaThreshold } }, `pixel:${clip.id}`)
            }
          />
          <p className="text-2xs text-slate-600">
            A hard alpha cutoff removes the antialiased halo that would otherwise
            show up around a sprite in Godot.
          </p>
        </Section>

        <Section title="Audio">
          <SliderField
            label="Volume"
            value={clip.volume}
            max={2}
            onChange={(volume) => updateClip(clip.id, { volume }, `volume:${clip.id}`)}
          />
        </Section>
      </div>
    </aside>
  );
}

export default Inspector;
