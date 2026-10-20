import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import {
  Aperture,
  Clapperboard,
  Contrast,
  Droplet,
  Film,
  Move,
  Sparkles,
  Waves,
  ZoomIn,
  ZoomOut,
  type LucideProps,
} from 'lucide-react';
import type { Clip, ProjectState } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { notify } from '@renderer/notifications/notifications';
import { useT } from '@renderer/i18n';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';
import { cancelFrame, requestFrame } from '@renderer/timing/animationFrame';
import { EFFECT_CATEGORIES, EFFECTS, effectCategoryLabel, effectLabel, type EffectCategory } from '@renderer/fx/effects/catalog';
import { addStackEffect } from '@renderer/components/Inspector/EffectStack';
import { MOTION_PRESETS, motionPresetLabel, motionPreview, type MotionPresetId } from '@renderer/fx/motion/presets';
import { applyMotionPreset } from '@renderer/fx/motion/apply';
import { drawTransitionThumb } from './libraryThumbs';
import { THUMB_HEIGHT, THUMB_WIDTH } from './LibraryBrowsers';

/**
 * The Effects tab of the library panel: the shader effects and the screen-zoom
 * and pan moves, to apply to a clip. It follows the same browse-and-apply shape
 * as the Titles and Transitions tabs - a search, category chips, a grid of
 * tiles that preview on hover - which is how DaVinci Resolve's Effects library
 * and Premiere's Effects panel present theirs.
 *
 * A tile applies to the selected clip, or, with nothing selected, to the clip
 * under the playhead - the clip the viewer is already showing. The screen-zoom
 * moves (Movement) come first because they are what the user asked for and what
 * short-form video leans on most.
 */

/** The whole set the tab shows: the "Movement" group, then the effect categories. */
type EffectFilter = 'all' | 'motion' | EffectCategory;

const CATEGORY_ICON: Record<EffectFilter, ComponentType<LucideProps>> = {
  all: Sparkles,
  motion: Move,
  color: Contrast,
  blur: Droplet,
  distort: Waves,
  stylize: Aperture,
  film: Film,
};

const MOTION_ICON: Record<MotionPresetId, ComponentType<LucideProps>> = {
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  kenBurns: Clapperboard,
  panLeft: Move,
  panRight: Move,
  panUp: Move,
  panDown: Move,
};

/**
 * The clip an effect lands on: the selected one, or failing that the clip
 * under the playhead on the topmost visual track - the one the viewer draws.
 */
function targetClip(state: { project: ProjectState; ui: { selectedClipIds: string[] } }): Clip | null {
  const { project, ui } = state;
  if (ui.selectedClipIds.length === 1) return project.clips[ui.selectedClipIds[0]] ?? null;
  const order = new Map(project.tracks.map((track) => [track.id, track]));
  const visual = (clip: Clip): boolean => {
    const type = order.get(clip.trackId)?.type;
    return type !== undefined && type !== 'audio' && type !== 'captions';
  };
  const under = Object.values(project.clips).filter(
    (clip) => visual(clip) && project.currentFrame >= clip.startFrame && project.currentFrame < clip.startFrame + clip.durationFrames,
  );
  if (under.length === 0) return null;
  // Topmost: the track drawn last sits on top (Compositor sorts by order).
  return under.sort((a, b) => (order.get(b.trackId)?.order ?? 0) - (order.get(a.trackId)?.order ?? 0))[0];
}

/* The sample scene, drawn once and reused, so a tile is cheap -------------- */

let sampleCanvas: HTMLCanvasElement | null = null;
function sample(): HTMLCanvasElement {
  if (sampleCanvas) return sampleCanvas;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const context = canvas.getContext('2d');
  // The same side-A picture the transition tiles use, so the panel reads as one.
  if (context) drawTransitionThumb(context, THUMB_WIDTH, THUMB_HEIGHT, 'crossDissolve', 0);
  sampleCanvas = canvas;
  return canvas;
}

/** Draw the sample, zoomed by `factor` and drifted by `offset`, as the move would. */
function drawMotion(context: CanvasRenderingContext2D, width: number, height: number, factor: number, offsetX: number, offsetY: number): void {
  const source = sample();
  const cropW = source.width / factor;
  const cropH = source.height / factor;
  // Centre the crop, then drift it, and keep it inside the picture.
  const sx = Math.min(source.width - cropW, Math.max(0, (source.width - cropW) / 2 + offsetX * source.width));
  const sy = Math.min(source.height - cropH, Math.max(0, (source.height - cropH) / 2 + offsetY * source.height));
  context.clearRect(0, 0, width, height);
  context.drawImage(source, sx, sy, cropW, cropH, 0, 0, width, height);
}

/* Tiles -------------------------------------------------------------------- */

function MotionThumb({ preset, playing }: { preset: MotionPresetId; playing: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return undefined;
    const still = motionPreview(preset, 0);
    drawMotion(context, THUMB_WIDTH, THUMB_HEIGHT, still.factor, still.offsetX, still.offsetY);
    if (!playing || motionReduced() || motionQuiet()) return undefined;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number): void => {
      if (motionQuiet()) {
        drawMotion(context, THUMB_WIDTH, THUMB_HEIGHT, still.factor, still.offsetX, still.offsetY);
        return;
      }
      // A 2.6 s there-and-back loop, so the move reads without racing.
      const cycle = ((now - started) / 2600) % 1;
      const t = cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
      const view = motionPreview(preset, t);
      drawMotion(context, THUMB_WIDTH, THUMB_HEIGHT, view.factor, view.offsetX, view.offsetY);
      frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
    return () => cancelFrame(frame);
  }, [preset, playing]);
  return <canvas ref={canvasRef} width={THUMB_WIDTH} height={THUMB_HEIGHT} aria-hidden className="block aspect-video w-full rounded-control bg-panel-950" />;
}

interface TileProps {
  label: string;
  testId: string;
  hintId: string;
  Icon: ComponentType<LucideProps>;
  thumb: JSX.Element;
  onPointed(pointed: boolean): void;
  onApply(): void;
}

function Tile({ label, testId, hintId, Icon, thumb, onPointed, onApply }: TileProps): JSX.Element {
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid={testId}
        aria-describedby={hintId}
        className="media-tile group w-full cursor-pointer text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hover"
        onPointerEnter={() => onPointed(true)}
        onPointerLeave={() => onPointed(false)}
        onFocus={() => onPointed(true)}
        onBlur={() => onPointed(false)}
        onClick={onApply}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          onApply();
        }}
      >
        <span className="relative block overflow-hidden rounded-control ring-1 ring-transparent group-hover:ring-panel-600">
          {thumb}
          <span aria-hidden className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-sm bg-black/70 text-slate-100">
            <Icon size={12} />
          </span>
        </span>
        <span className="mt-1 block truncate px-0.5 text-xs text-slate-200">{label}</span>
      </button>
    </li>
  );
}

function MotionTile({ preset, hintId, onApply }: { preset: MotionPresetId; hintId: string; onApply(): void }): JSX.Element {
  const t = useT();
  const [pointed, setPointed] = useState(false);
  return (
    <Tile
      label={t(motionPresetLabel(preset))}
      testId={`library-motion-${preset}`}
      hintId={hintId}
      Icon={MOTION_ICON[preset]}
      thumb={<MotionThumb preset={preset} playing={pointed} />}
      onPointed={setPointed}
      onApply={onApply}
    />
  );
}

function EffectThumb(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (context) context.drawImage(sample(), 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  }, []);
  return <canvas ref={canvasRef} width={THUMB_WIDTH} height={THUMB_HEIGHT} aria-hidden className="block aspect-video w-full rounded-control bg-panel-950" />;
}

function EffectTile({ type, category, hintId, onApply }: { type: string; category: EffectCategory; hintId: string; onApply(): void }): JSX.Element {
  const t = useT();
  return (
    <Tile
      label={t(effectLabel(type))}
      testId={`library-effect-${type}`}
      hintId={hintId}
      Icon={CATEGORY_ICON[category]}
      thumb={<EffectThumb />}
      onPointed={() => undefined}
      onApply={onApply}
    />
  );
}

/* The browser -------------------------------------------------------------- */

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-x-2 gap-y-2.5';

function Hint({ id, text }: { id: string; text: string }): JSX.Element {
  return (
    <p id={id} className="px-1 pb-2 text-2xs leading-relaxed text-slate-400">
      {text}
    </p>
  );
}

const MOTION_GROUP_LABEL: MessageKey = 'fx.effectCategory.motion';

export function EffectsBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [filter, setFilter] = useState<EffectFilter>('all');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();

  /** Apply `run` to the right clip, or say why nothing happened. */
  const onClip = (run: (clip: Clip) => void): void => {
    const state = useProjectStore.getState();
    const clip = targetClip(state);
    if (!clip) {
      notify(t('library.noClip'), 'info');
      return;
    }
    run(clip);
    // Bring the clip forward so its new effect or move shows in the inspector,
    // the way Resolve selects a clip the moment you drop an effect on it.
    state.setUi({ selectedClipIds: [clip.id], selectedTrackId: clip.trackId });
  };

  const motionMatches = (preset: MotionPresetId): boolean =>
    !needle || t(motionPresetLabel(preset)).toLocaleLowerCase().includes(needle) || preset.toLowerCase().includes(needle);
  const effectMatches = (type: string): boolean => !needle || t(effectLabel(type)).toLocaleLowerCase().includes(needle) || type.toLowerCase().includes(needle);

  const showMotion = (filter === 'all' || filter === 'motion') && MOTION_PRESETS.some(motionMatches);
  const effectGroups = EFFECT_CATEGORIES.filter((category) => filter === 'all' || filter === category)
    .map((category) => ({ category, types: EFFECTS.filter((effect) => effect.category === category && effectMatches(effect.type)).map((effect) => effect.type) }))
    .filter((group) => group.types.length > 0);

  const filters: EffectFilter[] = ['all', 'motion', ...EFFECT_CATEGORIES];
  const nothing = !showMotion && effectGroups.length === 0;

  return (
    <div data-testid="library-effects" className="min-h-0 flex-1 overflow-y-auto p-2">
      <Hint id={hintId} text={t('library.effectsHint')} />
      <input
        type="search"
        data-testid="library-effects-search"
        aria-label={t('fx.searchEffects')}
        placeholder={t('fx.searchEffects')}
        className="numeric-input mb-2 h-control-dense w-full px-2 text-left"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div role="group" aria-label={t('library.effects')} className="mb-2 flex flex-wrap gap-1">
        {filters.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`library-effects-filter-${id}`}
            aria-pressed={filter === id}
            className={`tool-button tool-button-dense px-2 text-2xs ${filter === id ? 'tool-button-active' : ''}`}
            onClick={() => setFilter(id)}
          >
            {t(id === 'all' ? 'fx.category.all' : id === 'motion' ? MOTION_GROUP_LABEL : effectCategoryLabel(id))}
          </button>
        ))}
      </div>

      {nothing && <p className="px-1 text-2xs text-slate-400">{t('fx.noMatch', { query })}</p>}

      {showMotion && (
        <section className="mb-3">
          <h3 className="section-title mb-1.5 px-0.5">{t(MOTION_GROUP_LABEL)}</h3>
          <ul className={GRID} aria-label={t(MOTION_GROUP_LABEL)}>
            {MOTION_PRESETS.filter(motionMatches).map((preset) => (
              <MotionTile key={preset} preset={preset} hintId={hintId} onApply={() => onClip((clip) => applyMotionPreset(clip.id, preset))} />
            ))}
          </ul>
        </section>
      )}

      {effectGroups.map((group) => (
        <section key={group.category} className="mb-3">
          <h3 className="section-title mb-1.5 px-0.5">{t(effectCategoryLabel(group.category))}</h3>
          <ul className={GRID} aria-label={t(effectCategoryLabel(group.category))}>
            {group.types.map((type) => (
              <EffectTile key={type} type={type} category={group.category} hintId={hintId} onApply={() => onClip((clip) => addStackEffect(clip, type))} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
