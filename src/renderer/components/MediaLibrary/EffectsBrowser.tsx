import { useEffect, useId, useRef, useState, type ComponentType, type DragEvent } from 'react';
import {
  Aperture,
  Clapperboard,
  Contrast,
  Droplet,
  Film,
  LogIn,
  LogOut,
  Move,
  Play,
  Repeat,
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
import { MOTION_PRESETS, motionPresetHint, motionPresetLabel, motionPreview, type MotionPresetId } from '@renderer/fx/motion/presets';
import { applyLibraryItem, type LibraryEffectItem } from '@renderer/fx/applyLibraryItem';
import { animationLabel, animationPreview, animationsOf, type AnimationPose, type ClipAnimationId, type ClipAnimationPhase } from '@renderer/fx/motion/animations';
import { drawEffectSample, drawEffectThumb } from './effectThumbs';
import { EFFECT_DRAG_TYPE, useLibraryDragStore } from './libraryDrag';
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
type EffectFilter = 'all' | 'motion' | 'animation' | EffectCategory;

const CATEGORY_ICON: Record<EffectFilter, ComponentType<LucideProps>> = {
  all: Sparkles,
  motion: Move,
  animation: Play,
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
  // The same scene the effect tiles show, so the panel reads as one.
  if (context) drawEffectSample(context, THUMB_WIDTH, THUMB_HEIGHT);
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

/** The sample, as a clip animation leaves it at one moment: placed, scaled, turned and faded on black. */
function drawAnimation(context: CanvasRenderingContext2D, width: number, height: number, pose: AnimationPose): void {
  const source = sample();
  context.save();
  context.fillStyle = '#05070b';
  context.fillRect(0, 0, width, height);
  context.globalAlpha = Math.min(1, Math.max(0, pose.opacity));
  context.translate(width / 2 + pose.x * width, height / 2 + pose.y * height);
  context.rotate((pose.rotation * Math.PI) / 180);
  context.scale(pose.scale, pose.scale);
  context.drawImage(source, -width / 2, -height / 2, width, height);
  context.restore();
}

/** Where a still tile catches each kind of animation: mid-move, so the tile reads as what it does. */
const STILL_AT: Record<ClipAnimationPhase, number> = { in: 0.22, out: 0.62, loop: 0.12 };

function AnimationThumb({ id, phase, playing }: { id: ClipAnimationId; phase: ClipAnimationPhase; playing: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return undefined;
    const still = (): void => drawAnimation(context, THUMB_WIDTH, THUMB_HEIGHT, animationPreview(id, STILL_AT[phase]));
    still();
    if (!playing || motionReduced() || motionQuiet()) return undefined;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number): void => {
      if (motionQuiet()) {
        still();
        return;
      }
      // A 1.8 s loop: long enough to read the move, short enough to watch again.
      drawAnimation(context, THUMB_WIDTH, THUMB_HEIGHT, animationPreview(id, ((now - started) / 1800) % 1));
      frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
    return () => {
      cancelFrame(frame);
      still();
    };
  }, [id, phase, playing]);
  return <canvas ref={canvasRef} width={THUMB_WIDTH} height={THUMB_HEIGHT} aria-hidden className="block aspect-video w-full rounded-control bg-panel-950" />;
}

const PHASE_ICON: Record<ClipAnimationPhase, ComponentType<LucideProps>> = { in: LogIn, out: LogOut, loop: Repeat };

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
  /** A per-tile description, shown on hover - the specific move or effect. */
  title?: string;
  Icon: ComponentType<LucideProps>;
  thumb: JSX.Element;
  /** What a drag onto a clip in the timeline carries (fx/applyLibraryItem). */
  item: LibraryEffectItem;
  onPointed(pointed: boolean): void;
  onApply(): void;
}

function Tile({ label, testId, hintId, title, Icon, thumb, item, onPointed, onApply }: TileProps): JSX.Element {
  const setDragging = useLibraryDragStore((state) => state.setDragging);
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid={testId}
        data-value={item}
        draggable
        aria-describedby={hintId}
        title={title}
        className="media-tile group w-full cursor-grab text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hover active:cursor-grabbing"
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
        onDragStart={(event: DragEvent<HTMLButtonElement>) => {
          event.dataTransfer.setData(EFFECT_DRAG_TYPE, item);
          event.dataTransfer.effectAllowed = 'copy';
          onPointed(false);
          setDragging('effect');
        }}
        onDragEnd={() => setDragging(null)}
      >
        <span className="relative block overflow-hidden rounded-control ring-1 ring-transparent group-hover:ring-panel-600">
          {thumb}
          <span aria-hidden className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-sm bg-black/70 text-slate-100">
            <Icon size={12} />
          </span>
        </span>
        {/* Two lines at most, so "Brightness and contrast" reads whole and never runs into its neighbour. */}
        <span className="mt-1 line-clamp-2 min-h-[2lh] w-full overflow-hidden break-words px-0.5 text-xs leading-snug text-slate-200">{label}</span>
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
      title={t(motionPresetHint(preset))}
      Icon={MOTION_ICON[preset]}
      thumb={<MotionThumb preset={preset} playing={pointed} />}
      item={`motion:${preset}`}
      onPointed={setPointed}
      onApply={onApply}
    />
  );
}

/** The effect itself, at its defaults, on the sample scene (effectThumbs). */
function AnimationTile({ id, phase, hintId, onApply }: { id: ClipAnimationId; phase: ClipAnimationPhase; hintId: string; onApply(): void }): JSX.Element {
  const t = useT();
  const [pointed, setPointed] = useState(false);
  return (
    <Tile
      label={t(animationLabel(id))}
      testId={`library-anim-${id}`}
      hintId={hintId}
      title={t(`fxa.hint.${phase}` as MessageKey)}
      Icon={PHASE_ICON[phase]}
      thumb={<AnimationThumb id={id} phase={phase} playing={pointed} />}
      item={`anim:${id}`}
      onPointed={setPointed}
      onApply={onApply}
    />
  );
}

function EffectThumb({ type }: { type: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return undefined;
    // Drawn a frame later, so opening the panel is not held up by twenty pictures.
    const frame = requestFrame(() => drawEffectThumb(context, THUMB_WIDTH, THUMB_HEIGHT, type));
    return () => cancelFrame(frame);
  }, [type]);
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
      thumb={<EffectThumb type={type} />}
      item={`effect:${type}`}
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

  /**
   * Put `item` on the right clip, or say why nothing happened. The clip is
   * brought forward so its new effect or move shows in the inspector, the way
   * Resolve selects a clip the moment you drop an effect on it.
   */
  const onClip = (item: LibraryEffectItem): void => {
    const clip = targetClip(useProjectStore.getState());
    if (!clip) {
      notify(t('library.noClip'), 'info');
      return;
    }
    applyLibraryItem(clip, item);
  };

  const motionMatches = (preset: MotionPresetId): boolean =>
    !needle || t(motionPresetLabel(preset)).toLocaleLowerCase().includes(needle) || preset.toLowerCase().includes(needle);
  const effectMatches = (type: string): boolean => !needle || t(effectLabel(type)).toLocaleLowerCase().includes(needle) || type.toLowerCase().includes(needle);

  const showMotion = (filter === 'all' || filter === 'motion') && MOTION_PRESETS.some(motionMatches);
  const animationMatches = (id: ClipAnimationId): boolean => !needle || t(animationLabel(id)).toLocaleLowerCase().includes(needle) || id.toLowerCase().includes(needle);
  const animationGroups = (filter === 'all' || filter === 'animation' ? (['in', 'out', 'loop'] as const) : [])
    .map((phase) => ({ phase, ids: animationsOf(phase).filter(animationMatches) }))
    .filter((group) => group.ids.length > 0);
  const effectGroups = EFFECT_CATEGORIES.filter((category) => filter === 'all' || filter === category)
    .map((category) => ({ category, types: EFFECTS.filter((effect) => effect.category === category && effectMatches(effect.type)).map((effect) => effect.type) }))
    .filter((group) => group.types.length > 0);

  const filters: EffectFilter[] = ['all', 'motion', 'animation', ...EFFECT_CATEGORIES];
  const nothing = !showMotion && animationGroups.length === 0 && effectGroups.length === 0;

  return (
    <div data-testid="library-effects" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
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
            {t(id === 'all' ? 'fx.category.all' : id === 'motion' ? MOTION_GROUP_LABEL : id === 'animation' ? 'fxa.filter' : effectCategoryLabel(id))}
          </button>
        ))}
      </div>

      {nothing && <p className="px-1 text-2xs text-slate-400">{t('fx.noMatch', { query })}</p>}

      {showMotion && (
        <section className="mb-3">
          <h3 className="section-title mb-1.5 px-0.5">{t(MOTION_GROUP_LABEL)}</h3>
          <ul className={GRID} aria-label={t(MOTION_GROUP_LABEL)}>
            {MOTION_PRESETS.filter(motionMatches).map((preset) => (
              <MotionTile key={preset} preset={preset} hintId={hintId} onApply={() => onClip(`motion:${preset}`)} />
            ))}
          </ul>
        </section>
      )}

      {animationGroups.map((group) => (
        <section key={group.phase} className="mb-3" data-testid={`library-anim-group-${group.phase}`}>
          <h3 className="section-title mb-1.5 px-0.5">{t(`fxa.group.${group.phase}` as MessageKey)}</h3>
          <ul className={GRID} aria-label={t(`fxa.group.${group.phase}` as MessageKey)}>
            {group.ids.map((id) => (
              <AnimationTile key={id} id={id} phase={group.phase} hintId={hintId} onApply={() => onClip(`anim:${id}`)} />
            ))}
          </ul>
        </section>
      ))}

      {effectGroups.map((group) => (
        <section key={group.category} className="mb-3">
          <h3 className="section-title mb-1.5 px-0.5">{t(effectCategoryLabel(group.category))}</h3>
          <ul className={GRID} aria-label={t(effectCategoryLabel(group.category))}>
            {group.types.map((type) => (
              <EffectTile key={type} type={type} category={group.category} hintId={hintId} onApply={() => onClip(`effect:${type}`)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
