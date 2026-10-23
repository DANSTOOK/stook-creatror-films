import { useEffect, useId, useRef, useState, type DragEvent, type RefObject } from 'react';
import type { MessageKey } from '@shared/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { TRANSITION_PRESETS, presetLabel, type BuiltinTransitionPreset, type TransitionPreset } from '@renderer/timing/transitions';
import { SHADER_TRANSITION_CATEGORIES, SHADER_TRANSITIONS, transitionCategoryLabel, type ShaderTransitionCategory } from '@renderer/fx/transitions/catalog';
import { cancelShaderThumbs, drawShaderThumb, shaderStillProgress, shaderThumbReady } from './shaderThumbs';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { notify } from '@renderer/notifications/notifications';
import { useT } from '@renderer/i18n';
import { drawTransitionThumb, transitionLoopProgress } from './libraryThumbs';
import { TITLE_DRAG_TYPE, TRANSITION_DRAG_TYPE, useLibraryDragStore, type LibraryDragKind } from './libraryDrag';
import { cancelFrame, requestFrame } from '@renderer/timing/animationFrame';
import { LibraryFinder } from './LibraryFinder';

/**
 * The Titles and Transitions tabs of the library panel: templates to drag
 * onto the timeline, as Final Cut's Titles and Transitions browsers and
 * Resolve's Effects Library offer them.
 *
 * A title goes onto a track (or, with Enter, at the playhead); a transition
 * onto a cut (or, with Enter, onto the selected clips or the cut at the
 * playhead - what Ctrl+T does, in the kind picked). Each picture plays only
 * while pointed at or focused (see libraryThumbs).
 */

/** Canvas pixels of a thumbnail: sharp at the panel's widest tiles on a 2x screen. */
export const THUMB_WIDTH = 256;
export const THUMB_HEIGHT = 144;

const TRANSITION_LABEL: Record<BuiltinTransitionPreset, MessageKey> = {
  crossDissolve: 'transition.crossDissolve',
  dipToBlack: 'transition.dipToBlack',
  dipToWhite: 'transition.dipToWhite',
  wipe: 'transition.wipe',
  slide: 'transition.slide',
  push: 'transition.push',
};

export type Draw = (context: CanvasRenderingContext2D, seconds: number | null) => void;

/**
 * A thumbnail that is still, and plays its loop while `playing` - unless the
 * system asks for less motion or the preview is playing, when it stays still.
 */
function Thumb({ draw, playing, ready }: { draw: Draw; playing: boolean; ready: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context || !ready) return undefined;
    draw(context, null);
    if (!playing || motionReduced() || motionQuiet()) return undefined;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number): void => {
      if (motionQuiet()) {
        // Playback started under the pointer: the picture comes first.
        draw(context, null);
        return;
      }
      draw(context, (now - started) / 1000);
      frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
    return () => {
      cancelFrame(frame);
      draw(context, null);
    };
  }, [draw, playing, ready]);
  return (
    <canvas
      ref={canvasRef}
      width={THUMB_WIDTH}
      height={THUMB_HEIGHT}
      aria-hidden
      className="block aspect-video w-full rounded-control bg-panel-950"
    />
  );
}

interface ItemProps {
  label: string;
  testId: string;
  dragKind: LibraryDragKind;
  dragValue: string;
  hintId: string;
  draw: Draw;
  ready: boolean;
  /** A small mark over the picture's corner, such as a vertical template's 9:16. */
  badge?: { text: string; hint: string };
  /** The tile's list item, for a panel that draws pictures only once they scroll into view. */
  itemRef?: RefObject<HTMLLIElement>;
  onAdd(): void;
}

export function LibraryItem({ label, testId, dragKind, dragValue, hintId, draw, ready, badge, itemRef, onAdd }: ItemProps): JSX.Element {
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const setDragging = useLibraryDragStore((state) => state.setDragging);
  return (
    <li ref={itemRef} className="min-w-0">
      <button
        type="button"
        data-testid={testId}
        data-value={dragValue}
        draggable
        aria-describedby={hintId}
        className="media-tile group w-full cursor-grab text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hover active:cursor-grabbing"
        onPointerEnter={() => setPointed(true)}
        onPointerLeave={() => setPointed(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onDoubleClick={onAdd}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          onAdd();
        }}
        onDragStart={(event: DragEvent<HTMLButtonElement>) => {
          event.dataTransfer.setData(dragKind === 'title' ? TITLE_DRAG_TYPE : TRANSITION_DRAG_TYPE, dragValue);
          event.dataTransfer.effectAllowed = 'copy';
          setPointed(false);
          setDragging(dragKind);
        }}
        onDragEnd={() => setDragging(null)}
      >
        <span className="relative block overflow-hidden rounded-control ring-1 ring-transparent group-hover:ring-panel-600">
          <Thumb draw={draw} playing={pointed || focused} ready={ready} />
          {badge && (
            <span className="absolute right-1 top-1 rounded-sm bg-black/70 px-1 text-[10px] font-semibold leading-4 text-slate-100" {...tip(badge.hint)}>
              {badge.text}
            </span>
          )}
        </span>
        <span className="mt-1 block truncate px-0.5 text-xs text-slate-200">{label}</span>
      </button>
    </li>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-x-2 gap-y-2.5';

/** Stable per preset, so a re-render does not restart a playing thumbnail. */
const TRANSITION_DRAW = Object.fromEntries(
  TRANSITION_PRESETS.map((preset) => [
    preset,
    ((context, seconds) =>
      drawTransitionThumb(context, THUMB_WIDTH, THUMB_HEIGHT, preset, seconds === null ? null : transitionLoopProgress(seconds))) as Draw,
  ]),
) as Record<BuiltinTransitionPreset, Draw>;

/** A shader transition's picture: the real shader, still at its still point or looping. */
const SHADER_DRAW = new Map<string, Draw>();
const shaderDraw = (id: string): Draw => {
  let draw = SHADER_DRAW.get(id);
  if (!draw) {
    draw = (context, seconds) =>
      drawShaderThumb(context, THUMB_WIDTH, THUMB_HEIGHT, id, seconds === null ? shaderStillProgress(id) : transitionLoopProgress(seconds));
    SHADER_DRAW.set(id, draw);
  }
  return draw;
};

type Filter = 'all' | 'basic' | ShaderTransitionCategory;

/** A shader transition's tile: still until its program is compiled (see shaderThumbs). */
function ShaderItem({ id, hintId, onAdd }: { id: string; hintId: string; onAdd(): void }): JSX.Element {
  const t = useT();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void shaderThumbReady(id).then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <LibraryItem
      label={t(presetLabel(id))}
      testId={`library-transition-${id}`}
      dragKind="transition"
      dragValue={id}
      hintId={hintId}
      draw={shaderDraw(id)}
      ready={ready}
      onAdd={onAdd}
    />
  );
}

export function TransitionsBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const add = (preset: TransitionPreset): void => {
    const store = useProjectStore.getState();
    const before = store.project;
    store.addTransitions(preset);
    const after = useProjectStore.getState();
    // Enter with no clip selected and no cut near the playhead: say why
    // nothing happened, instead of nothing.
    if (after.project === before && !after.ui.pendingTransition) notify(t('library.noCut'), 'info');
  };
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  useEffect(() => cancelShaderThumbs, []);
  // Searched by name in the interface's language, and by the id as well.
  const needle = query.trim().toLocaleLowerCase();
  const matches = (preset: TransitionPreset): boolean =>
    !needle || t(presetLabel(preset)).toLocaleLowerCase().includes(needle) || preset.toLowerCase().includes(needle);
  const found: Array<{ id: 'basic' | ShaderTransitionCategory; presets: TransitionPreset[] }> = [
    { id: 'basic' as const, presets: [...TRANSITION_PRESETS] as TransitionPreset[] },
    ...SHADER_TRANSITION_CATEGORIES.map((category) => ({ id: category, presets: SHADER_TRANSITIONS.filter((entry) => entry.category === category).map((entry) => entry.id) })),
  ].map((group) => ({ ...group, presets: group.presets.filter(matches) }));
  const groups = found.filter((group) => (filter === 'all' || group.id === filter) && group.presets.length > 0);
  const options = [
    { id: 'all', label: t('fx.category.all'), count: found.reduce((sum, group) => sum + group.presets.length, 0) },
    ...found.map((group) => ({ id: group.id, label: t(transitionCategoryLabel(group.id)), count: group.presets.length })),
  ];
  return (
    <div data-testid="library-transitions" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <LibraryFinder
        query={query}
        onQuery={setQuery}
        placeholder={t('fx.search')}
        searchTestId="library-transitions-search"
        options={options}
        value={filter}
        onChange={(id) => setFilter(id as Filter)}
        filterTestId="library-transitions-filter"
        hint={t('library.transitionsHint')}
        hintId={hintId}
        categoriesLabel={t('library.categories')}
      />
      {groups.length === 0 && <p className="px-1 text-2xs text-slate-400">{t('fx.noMatch', { query })}</p>}
      {groups.map((group) => (
        <section key={group.id} className="mb-3">
          <h3 className="section-title mb-1.5 px-0.5">{t(transitionCategoryLabel(group.id))}</h3>
          <ul className={GRID} aria-label={t(transitionCategoryLabel(group.id))}>
            {group.presets.map((preset) =>
              (TRANSITION_PRESETS as readonly string[]).includes(preset) ? (
                <LibraryItem
                  key={preset}
                  label={t(TRANSITION_LABEL[preset as BuiltinTransitionPreset])}
                  testId={`library-transition-${preset}`}
                  dragKind="transition"
                  dragValue={preset}
                  hintId={hintId}
                  draw={TRANSITION_DRAW[preset as BuiltinTransitionPreset]}
                  ready
                  onAdd={() => add(preset)}
                />
              ) : (
                <ShaderItem key={preset} id={preset} hintId={hintId} onAdd={() => add(preset)} />
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
