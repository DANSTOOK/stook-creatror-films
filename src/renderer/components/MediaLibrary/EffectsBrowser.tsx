import { useEffect, useId, useRef, useState, type ComponentType, type DragEvent } from 'react';
import {
  Aperture,
  Clapperboard,
  Sun,
  Tv,
  Video,
  Vibrate,
  Contrast,
  Droplet,
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
import { EFFECT_CATEGORIES, EFFECTS, effectCategoryLabel, effectFamily, effectLabel, type EffectCategory, type EffectFamily } from '@renderer/fx/effects/catalog';
import { MOTION_PRESETS, motionPresetHint, motionPresetLabel, motionPreview, type MotionPresetId } from '@renderer/fx/motion/presets';
import { applyLibraryItem, type LibraryEffectItem } from '@renderer/fx/applyLibraryItem';
import { animationLabel, animationPreview, animationsOf, type AnimationPose, type ClipAnimationId, type ClipAnimationPhase } from '@renderer/fx/motion/animations';
import { drawEffectCompare, drawEffectFrame, drawEffectSample, drawEffectThumb, effectMoves } from './effectThumbs';
import { EFFECT_DRAG_TYPE, useLibraryDragStore } from './libraryDrag';
import { THUMB_HEIGHT, THUMB_WIDTH } from './LibraryBrowsers';
import { LibraryFinder } from './LibraryFinder';

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

/**
 * What the drop-down can show: everything, one of the two families, or one
 * group - the Movement presets, the animations or an effect category.
 */
type EffectGroup = 'motion' | 'animation' | EffectCategory;
type EffectFilter = 'all' | `family:${EffectFamily}` | EffectGroup;

const CATEGORY_ICON: Record<EffectGroup, ComponentType<LucideProps>> = {
  motion: Move,
  animation: Play,
  camera: Vibrate,
  color: Contrast,
  blur: Droplet,
  distort: Waves,
  glitch: Tv,
  stylize: Aperture,
  film: Sun,
};

/** The groups of each family, in the order the panel shows them. */
const FAMILY_GROUPS: Record<EffectFamily, readonly EffectGroup[]> = {
  camera: ['motion', 'camera', 'animation'],
  look: EFFECT_CATEGORIES.filter((category) => effectFamily(category) === 'look'),
};

/**
 * Each family's colour, on its heading, its band and the badge of every tile -
 * blue for what moves the camera, violet for what changes the picture - so the
 * two read apart at a glance, as well as by where they sit.
 */
const FAMILY_LOOK: Record<EffectFamily, { Icon: ComponentType<LucideProps>; badge: string; band: string; heading: string }> = {
  camera: { Icon: Video, badge: 'bg-sky-600/90 text-white', band: 'border-sky-500/70 bg-sky-500/[0.06]', heading: 'text-sky-300' },
  look: { Icon: Sparkles, badge: 'bg-violet-600/90 text-white', band: 'border-violet-500/70 bg-violet-500/[0.06]', heading: 'text-violet-300' },
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
  family: EffectFamily;
  thumb: JSX.Element;
  /** What a drag onto a clip in the timeline carries (fx/applyLibraryItem). */
  item: LibraryEffectItem;
  onPointed(pointed: boolean): void;
  onApply(): void;
}

function Tile({ label, testId, hintId, title, Icon, family, thumb, item, onPointed, onApply }: TileProps): JSX.Element {
  const setDragging = useLibraryDragStore((state) => state.setDragging);
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid={testId}
        data-value={item}
        data-family={family}
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
          <span aria-hidden className={`absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-sm shadow-sm ${FAMILY_LOOK[family].badge}`}>
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
      family="camera"
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
      family="camera"
      thumb={<AnimationThumb id={id} phase={phase} playing={pointed} />}
      item={`anim:${id}`}
      onPointed={setPointed}
      onApply={onApply}
    />
  );
}

/**
 * An effect's tile: still, the effect at its defaults. Pointed at, one that
 * moves by itself (a glitch, a shake, a flash) plays live; a still one wipes
 * between the scene as it is and the scene with the effect, so the change
 * shows however subtle it is.
 */
function EffectThumb({ type, playing }: { type: string; playing: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return undefined;
    const still = (): void => drawEffectThumb(context, THUMB_WIDTH, THUMB_HEIGHT, type);
    // Drawn a frame later, so opening the panel is not held up by sixty pictures.
    let frame = requestFrame(still);
    if (!playing || motionReduced() || motionQuiet()) return () => cancelFrame(frame);
    const started = performance.now();
    const moves = effectMoves(type);
    const tick = (now: number): void => {
      if (motionQuiet()) {
        still();
        return;
      }
      const seconds = (now - started) / 1000;
      if (moves) drawEffectFrame(context, THUMB_WIDTH, THUMB_HEIGHT, type, seconds);
      else {
        // A 2.4 s sweep there and back, easing at each end.
        const cycle = (seconds / 2.4) % 1;
        const there = cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
        drawEffectCompare(context, THUMB_WIDTH, THUMB_HEIGHT, type, 0.5 - 0.5 * Math.cos(Math.PI * there));
      }
      frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
    return () => {
      cancelFrame(frame);
      still();
    };
  }, [type, playing]);
  return <canvas ref={canvasRef} width={THUMB_WIDTH} height={THUMB_HEIGHT} aria-hidden className="block aspect-video w-full rounded-control bg-panel-950" />;
}

function EffectTile({ type, category, hintId, onApply }: { type: string; category: EffectCategory; hintId: string; onApply(): void }): JSX.Element {
  const t = useT();
  const [pointed, setPointed] = useState(false);
  return (
    <Tile
      label={t(effectLabel(type))}
      testId={`library-effect-${type}`}
      hintId={hintId}
      Icon={CATEGORY_ICON[category]}
      family={effectFamily(category)}
      thumb={<EffectThumb type={type} playing={pointed} />}
      item={`effect:${type}`}
      onPointed={setPointed}
      onApply={onApply}
    />
  );
}

/* The browser -------------------------------------------------------------- */

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-x-2 gap-y-2.5';

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

  const matches = (label: MessageKey, id: string): boolean => !needle || t(label).toLocaleLowerCase().includes(needle) || id.toLowerCase().includes(needle);
  const motionShown = MOTION_PRESETS.filter((preset) => matches(motionPresetLabel(preset), preset));
  const animationShown = (['in', 'out', 'loop'] as const)
    .map((phase) => ({ phase, ids: animationsOf(phase).filter((id) => matches(animationLabel(id), id)) }))
    .filter((group) => group.ids.length > 0);
  const effectsShown = (category: EffectCategory): string[] =>
    EFFECTS.filter((effect) => effect.category === category && matches(effectLabel(effect.type), effect.type)).map((effect) => effect.type);

  // How many each group holds of what the search leaves, whichever is shown.
  const count = (group: EffectGroup): number =>
    group === 'motion' ? motionShown.length : group === 'animation' ? animationShown.reduce((sum, entry) => sum + entry.ids.length, 0) : effectsShown(group).length;
  const groupLabel = (group: EffectGroup): string =>
    t(group === 'motion' ? MOTION_GROUP_LABEL : group === 'animation' ? 'fxa.filter' : effectCategoryLabel(group));
  const familyCount = (family: EffectFamily): number => FAMILY_GROUPS[family].reduce((sum, group) => sum + count(group), 0);
  const options = [
    { id: 'all', label: t('fx.category.all'), count: familyCount('camera') + familyCount('look') },
    ...(['camera', 'look'] as const).flatMap((family) => [
      { id: `family:${family}`, label: t(`fx.family.${family}` as MessageKey), count: familyCount(family), heading: true },
      ...FAMILY_GROUPS[family].map((group) => ({ id: group, label: groupLabel(group), count: count(group), indent: true })),
    ]),
  ];
  const shows = (family: EffectFamily, group: EffectGroup): boolean => filter === 'all' || filter === `family:${family}` || filter === group;
  const nothing = (['camera', 'look'] as const).every((family) => FAMILY_GROUPS[family].every((group) => !shows(family, group) || count(group) === 0));

  const section = (group: EffectGroup): JSX.Element | null => {
    if (group === 'motion') {
      return motionShown.length === 0 ? null : (
        <section key="motion" className="mb-3">
          <h3 className="section-title mb-1.5 px-0.5">{t(MOTION_GROUP_LABEL)}</h3>
          <ul className={GRID} aria-label={t(MOTION_GROUP_LABEL)}>
            {motionShown.map((preset) => (
              <MotionTile key={preset} preset={preset} hintId={hintId} onApply={() => onClip(`motion:${preset}`)} />
            ))}
          </ul>
        </section>
      );
    }
    if (group === 'animation') {
      return (
        <div key="animation">
          {animationShown.map((entry) => (
            <section key={entry.phase} className="mb-3" data-testid={`library-anim-group-${entry.phase}`}>
              <h3 className="section-title mb-1.5 px-0.5">{t(`fxa.group.${entry.phase}` as MessageKey)}</h3>
              <ul className={GRID} aria-label={t(`fxa.group.${entry.phase}` as MessageKey)}>
                {entry.ids.map((id) => (
                  <AnimationTile key={id} id={id} phase={entry.phase} hintId={hintId} onApply={() => onClip(`anim:${id}`)} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      );
    }
    const types = effectsShown(group);
    return types.length === 0 ? null : (
      <section key={group} className="mb-3">
        <h3 className="section-title mb-1.5 px-0.5">{t(effectCategoryLabel(group))}</h3>
        <ul className={GRID} aria-label={t(effectCategoryLabel(group))}>
          {types.map((type) => (
            <EffectTile key={type} type={type} category={group} hintId={hintId} onApply={() => onClip(`effect:${type}`)} />
          ))}
        </ul>
      </section>
    );
  };

  return (
    <div data-testid="library-effects" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <LibraryFinder
        query={query}
        onQuery={setQuery}
        placeholder={t('fx.searchEffects')}
        searchTestId="library-effects-search"
        options={options}
        value={filter}
        onChange={(id) => setFilter(id as EffectFilter)}
        filterTestId="library-effects-filter"
        hint={t('library.effectsHint')}
        hintId={hintId}
        categoriesLabel={t('library.categories')}
      />

      {nothing && <p className="px-1 text-2xs text-slate-400">{t('fx.noMatch', { query })}</p>}

      {(['camera', 'look'] as const).map((family) => {
        const groups = FAMILY_GROUPS[family].filter((group) => shows(family, group) && count(group) > 0);
        if (groups.length === 0) return null;
        const { Icon, band, heading } = FAMILY_LOOK[family];
        return (
          <div key={family} data-testid={`library-effects-family-${family}`} className="mb-2">
            {/* The family's heading: its colour, its name and what it does. */}
            <div className={`mb-2 flex items-start gap-2 rounded-md border-l-[3px] px-2 py-1.5 ${band}`}>
              <Icon size={15} aria-hidden className={`mt-0.5 shrink-0 ${heading}`} />
              <div className="min-w-0">
                <h2 className={`text-xs font-semibold ${heading}`}>{t(`fx.family.${family}` as MessageKey)}</h2>
                <p className="text-2xs leading-snug text-slate-400">{t(`fx.family.${family}Hint` as MessageKey)}</p>
              </div>
            </div>
            {groups.map(section)}
          </div>
        );
      })}
    </div>
  );
}
