import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, Palette, Trash2, X } from 'lucide-react';
import { BLEND_MODES, type BlendMode } from '@shared/types';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { useLutLibrary, type LibraryLut } from '@renderer/store/useLutLibrary';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { dbLabel } from '@renderer/audio/levels';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { DetachButton } from '@renderer/components/Layout/DetachButton';
import { useT, type MessageKey } from '@renderer/i18n';
import { ScrubLabel, Section, plain, type SectionProps } from './rows';
import {
  blendOf,
  groupSelection,
  sameLook,
  sameNumber,
  samePath,
  shared,
  staticOpacity,
  withBlend,
  withLut,
  withLutIntensity,
  withOpacity,
  withoutLut,
  type LutChoice,
  type Shared,
} from './multiSelection';

/**
 * The inspector with several clips selected.
 *
 * It used to say how many there were and nothing else, so a look, a blend
 * mode or an opacity had to be set clip by clip - and grading a sequence is
 * exactly a look set on a run of shots. This is Premiere's Properties panel
 * with several clips selected (25.0 and later): only the settings one value
 * makes sense for across clips, each showing the shared value or "Mixed",
 * and a change sets it on every selected clip it applies to, as one undo
 * step.
 *
 * Kept to what a sequence is graded and comped with: opacity and blend mode,
 * the LUT and its intensity, and volume. Position, scale and the grade's own
 * sliders are left out on purpose: a shared position stacks every shot in one
 * place, and a grade is matched shot by shot, then copied with Paste grade.
 */

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * A slider and its value over several clips. The same elements are drawn
 * whether the value is mixed or not, so typing into a "Mixed" field keeps the
 * caret: the first digit makes the value shared, and a field swapped for
 * another element at that moment would lose the rest of the number.
 */
function MixedSliderRow({
  label,
  state,
  hint,
  min = 0,
  max = 1,
  step = 0.01,
  format = plain,
  typed,
  testId,
  onChange,
}: {
  label: string;
  state: Shared<number>;
  /** Where a mixed slider sits for the keyboard; never drawn. */
  hint: number;
  min?: number;
  max?: number;
  step?: number;
  format?(value: number): string;
  typed?: { factor: number; unit: string; step: number };
  testId: string;
  onChange(value: number): void;
}): JSX.Element {
  const t = useT();
  const id = useId();
  const value = state.mixed ? hint : state.value;
  const clamp = (next: number): number => Math.min(max, Math.max(min, next));
  const fill = !state.mixed && min >= 0 ? { '--fill': `${((value - min) / (max - min || 1)) * 100}%` } : undefined;
  return (
    <div className="grid grid-cols-[76px_1fr_64px] items-center gap-2" data-testid={testId} data-mixed={state.mixed || undefined}>
      <ScrubLabel htmlFor={id} value={value} step={step} onChange={(next) => onChange(clamp(next))} className="field-label truncate">
        {label}
      </ScrubLabel>
      <input
        id={id}
        type="range"
        className="min-w-0"
        data-mixed={state.mixed || undefined}
        aria-valuetext={state.mixed ? t('inspector.mixed') : undefined}
        style={fill as React.CSSProperties | undefined}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {typed ? (
        <span className="relative block min-w-0 flex-1">
          <input
            type="number"
            aria-label={label}
            className={`numeric-input timecode h-control-dense pl-1.5 text-right placeholder:text-slate-400 ${state.mixed ? 'pr-1.5' : 'pr-4'}`}
            placeholder={state.mixed ? t('inspector.mixed') : undefined}
            value={state.mixed ? '' : Number((value * typed.factor).toFixed(4))}
            min={min * typed.factor}
            max={max * typed.factor}
            step={typed.step}
            onChange={(event) => {
              // An emptied field is not a value; the clips keep theirs.
              if (event.target.value === '') return;
              onChange(clamp(Number(event.target.value) / typed.factor));
            }}
          />
          {!state.mixed && (
            <span aria-hidden className="pointer-events-none absolute inset-y-0 right-1 flex items-center text-2xs text-slate-400">
              {typed.unit}
            </span>
          )}
        </span>
      ) : (
        <span className="timecode truncate text-right text-2xs text-slate-300">{state.mixed ? t('inspector.mixed') : format(value)}</span>
      )}
    </div>
  );
}

/** Where a mixed slider rests for the keyboard: between the values it stands for. */
const middle = (values: readonly number[]): number =>
  values.length === 0 ? 0 : (Math.min(...values) + Math.max(...values)) / 2;

export function MultiInspector({ ids }: { ids: readonly string[] }): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const assets = useProjectStore((state) => state.assets);
  const updateClips = useProjectStore((state) => state.updateClips);
  const library = useLutLibrary((state) => state.luts);
  const forgetLut = useLutLibrary((state) => state.forget);

  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [lutError, setLutError] = useState<string | null>(null);
  const lutInputRef = useRef<HTMLInputElement>(null);
  const selectionKey = ids.join(',');
  // An error was about the clips it was raised for.
  useEffect(() => setLutError(null), [selectionKey]);

  const groups = groupSelection(ids, project, assets);
  const visualIds = groups.visual.map((clip) => clip.id);
  const gradeableIds = groups.gradeable.map((clip) => clip.id);
  const audibleIds = groups.audible.map((clip) => clip.id);
  /** One merge key per setting and selection: a drag over the selection is one undo step. */
  const mergeKey = (setting: string): string => `multi:${setting}:${selectionKey}`;

  /**
   * Parse and upload the look once, before any clip refers to it, then put it
   * on every gradeable clip in one step. The clips are the ones selected when
   * it was asked for: reading the file takes a moment, and a selection
   * changed meanwhile is not what was meant.
   */
  const applyLut = useCallback(async (targets: readonly string[], name: string, contents: string, sourcePath?: string) => {
    setLutError(null);
    try {
      const uri = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
      // A malformed file reports here, instead of drawing nothing later.
      await getActiveFrameRenderer()?.lutLoader.load(uri);
      const lut: LutChoice = { uri, name, sourcePath };
      useProjectStore.getState().updateClips(targets, (clip) => withLut(clip, lut));
      if (sourcePath) useLutLibrary.getState().remember(sourcePath, name);
    } catch (error) {
      setLutError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const applyFromLibrary = async (targets: readonly string[], lut: LibraryLut): Promise<void> => {
    setLutError(null);
    let contents: string;
    try {
      contents = await window.filmora.readTextFile(lut.path);
    } catch {
      // The one way reading a listed look fails is the file not being there.
      setLutError(t('inspector.lutMissing', { name: lut.name }));
      return;
    }
    await applyLut(targets, lut.name, contents, lut.path);
  };

  const pickLut = async (targets: readonly string[]): Promise<void> => {
    if (!hasNativeBridge()) {
      lutInputRef.current?.click();
      return;
    }
    const picked = await window.filmora.openLut();
    if (!picked) return;
    await applyLut(targets, picked.path.split(/[\\/]/).pop() ?? 'LUT', picked.contents, picked.path);
  };

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

  /** Said at the top of a group that reaches only some of the selection, before anything is changed. */
  const appliesTo = (count: number): JSX.Element | null =>
    count < groups.all.length ? (
      <p className="text-2xs text-slate-400">{t('inspector.multiAppliesTo', { count, total: groups.all.length })}</p>
    ) : null;

  /* Composite --------------------------------------------------------------- */

  const opacities = groups.visual.map(staticOpacity).filter((value): value is number => value !== null);
  const animatedOpacity = groups.visual.length - opacities.length;
  const opacity = shared(opacities, 1, sameNumber);
  const blend = shared(groups.visual.map(blendOf), 'normal' as BlendMode);

  /* LUT --------------------------------------------------------------------- */

  const withLook = groups.gradeable.filter((clip) => clip.colorGrading.lutUri);
  const anyLook = withLook.length > 0;
  const oneLook = anyLook && withLook.length === groups.gradeable.length && withLook.every((clip) => sameLook(withLook[0], clip));
  const intensities = withLook.map((clip) => clip.colorGrading.lutIntensity);
  const intensity = shared(intensities, 1, sameNumber);
  const lookLine = (): string => {
    if (!anyLook) return t('inspector.noLut');
    if (!oneLook) {
      return withLook.length < groups.gradeable.length
        ? t('inspector.lutOnSome', { count: withLook.length, total: groups.gradeable.length })
        : t('inspector.lutDifferent');
    }
    const grading = withLook[0].colorGrading;
    const unsaved = withLook.some((clip) => !clip.colorGrading.lutSourcePath);
    return `${grading.lutName ?? t('inspector.lutLoaded')}${unsaved ? ` ${t('inspector.lutNotSaved')}` : ''}`;
  };

  /* Level ------------------------------------------------------------------- */

  const volumes = groups.audible.map((clip) => clip.volume);
  const volume = shared(volumes, 1, sameNumber);

  const nothing = groups.visual.length === 0 && groups.audible.length === 0;

  return (
    <aside data-testid="inspector-panel" className="panel w-full">
      <header className="panel-header">
        <span className="min-w-0 flex-1 truncate">{t('inspector.manySelected', { count: groups.all.length })}</span>
        <DetachButton panel="inspector" />
      </header>

      <div data-testid="multi-inspector" className="min-h-0 flex-1 overflow-y-auto">
        <p className="border-b border-panel-800 px-3 py-2 text-2xs leading-relaxed text-slate-400">
          {t(nothing ? 'inspector.multiNothing' : 'inspector.multiHint')}
        </p>

        {groups.visual.length > 0 && (
          <Section {...sectionProps('composite')} title={t('inspector.composite')}>
            {appliesTo(groups.visual.length)}
            {opacities.length > 0 && (
              <MixedSliderRow
                testId="multi-opacity"
                label={t('inspector.opacity')}
                state={opacity}
                hint={middle(opacities)}
                typed={{ factor: 100, unit: '%', step: 1 }}
                onChange={(value) => updateClips(visualIds, (clip) => withOpacity(clip, value), mergeKey('opacity'))}
              />
            )}
            {animatedOpacity > 0 && (
              <p className="text-2xs text-slate-400">{t('inspector.multiOpacityAnimated', { count: animatedOpacity, total: groups.visual.length })}</p>
            )}
            <label className="flex items-center justify-between gap-2">
              <span className="text-2xs text-slate-400">{t('blend.title')}</span>
              <select
                data-testid="clip-blend-mode"
                className="numeric-input h-control-dense w-36"
                value={blend.mixed ? '' : blend.value}
                onChange={(event) => {
                  const chosen = event.target.value as BlendMode;
                  updateClips(visualIds, () => withBlend(chosen));
                }}
              >
                {/* Mixed is what the clips are, not a mode to choose. */}
                {blend.mixed && (
                  <option value="" disabled>
                    {t('inspector.mixed')}
                  </option>
                )}
                {BLEND_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`blend.${mode}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
          </Section>
        )}

        {groups.gradeable.length > 0 && (
          <Section {...sectionProps('lut')} title={t('inspector.lut')}>
            {appliesTo(groups.gradeable.length)}
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="multi-load-lut"
                className="tool-button h-control flex-1 justify-start border border-panel-600"
                onClick={() => void pickLut(gradeableIds)}
              >
                <FolderOpen size={13} />
                {anyLook ? t('inspector.replaceLut') : t('inspector.loadLut')}
              </button>
              {anyLook && (
                <button
                  type="button"
                  data-testid="multi-remove-lut"
                  className="tool-button h-control w-7 px-0 hover:text-red-400"
                  onClick={() => updateClips(gradeableIds, withoutLut)}
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
                if (file) void file.text().then((text) => applyLut(gradeableIds, file.name, text));
              }}
            />
            {lutError && (
              <p role="alert" className="text-2xs text-red-400">
                {lutError}
              </p>
            )}
            <p data-testid="lut-current" className="truncate text-2xs text-slate-400">
              {lookLine()}
            </p>
            {anyLook && (
              <MixedSliderRow
                testId="multi-lut-intensity"
                label={t('inspector.lutIntensity')}
                state={intensity}
                hint={middle(intensities)}
                format={percent}
                onChange={(value) => updateClips(gradeableIds, (clip) => withLutIntensity(clip, value), mergeKey('lutIntensity'))}
              />
            )}

            <div className="space-y-1 border-t border-panel-700 pt-2">
              <span className="section-title">{t('inspector.lutLibrary')}</span>
              {library.length === 0 ? (
                <p className="text-2xs text-slate-500">{t('inspector.lutLibraryEmpty')}</p>
              ) : (
                <ul className="space-y-0.5" data-testid="lut-library">
                  {library.map((lut) => {
                    // Marked only when it is on every one of them.
                    const applied = groups.gradeable.every((clip) => samePath(clip.colorGrading.lutSourcePath, lut.path));
                    return (
                      <li key={lut.path} className="flex items-center gap-1">
                        <button
                          type="button"
                          data-testid={`lut-apply-${lut.name}`}
                          className={`tool-button h-control-dense min-w-0 flex-1 justify-start ${applied ? 'text-accent-hover' : ''}`}
                          onClick={() => void applyFromLibrary(gradeableIds, lut)}
                          {...tip(t('inspector.applyLut', { name: lut.name }))}
                        >
                          <Palette size={12} className="shrink-0" />
                          <span className="truncate text-2xs">{lut.name}</span>
                        </button>
                        <button
                          type="button"
                          data-testid={`lut-forget-${lut.name}`}
                          className="tool-button h-control-dense w-6 px-0 hover:text-red-400"
                          onClick={() => forgetLut(lut.path)}
                          {...tip(t('inspector.forgetLut', { name: lut.name }))}
                        >
                          <X size={11} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Section>
        )}

        {groups.audible.length > 0 && (
          <Section {...sectionProps('level')} title={t('inspector.level')}>
            {appliesTo(groups.audible.length)}
            <MixedSliderRow
              testId="multi-volume"
              label={t('inspector.volume')}
              state={volume}
              hint={middle(volumes)}
              max={2}
              format={dbLabel}
              onChange={(value) => updateClips(audibleIds, () => ({ volume: value }), mergeKey('volume'))}
            />
          </Section>
        )}
      </div>
    </aside>
  );
}
