import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import type { TitlePreset } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { TITLE_PRESETS } from '@renderer/text/titleStyle';
import { TITLE_NAME, TITLE_TEXT } from '@renderer/text/titleClip';
import { TRANSITION_PRESETS, type TransitionPreset } from '@renderer/timing/transitions';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { notify } from '@renderer/notifications/notifications';
import { useT } from '@renderer/i18n';
import {
  drawTitleThumb,
  drawTransitionThumb,
  titleThumbReady,
  transitionLoopProgress,
} from './libraryThumbs';
import { TITLE_DRAG_TYPE, TRANSITION_DRAG_TYPE, useLibraryDragStore, type LibraryDragKind } from './libraryDrag';

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
const THUMB_WIDTH = 256;
const THUMB_HEIGHT = 144;

const TRANSITION_LABEL: Record<TransitionPreset, MessageKey> = {
  crossDissolve: 'transition.crossDissolve',
  dipToBlack: 'transition.dipToBlack',
  dipToWhite: 'transition.dipToWhite',
  wipe: 'transition.wipe',
  slide: 'transition.slide',
  push: 'transition.push',
};

type Draw = (context: CanvasRenderingContext2D, seconds: number | null) => void;

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
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
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
  onAdd(): void;
}

function LibraryItem({ label, testId, dragKind, dragValue, hintId, draw, ready, onAdd }: ItemProps): JSX.Element {
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const setDragging = useLibraryDragStore((state) => state.setDragging);
  return (
    <li className="min-w-0">
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
        <span className="block overflow-hidden rounded-control ring-1 ring-transparent group-hover:ring-panel-600">
          <Thumb draw={draw} playing={pointed || focused} ready={ready} />
        </span>
        <span className="mt-1 block truncate px-0.5 text-xs text-slate-200">{label}</span>
      </button>
    </li>
  );
}

function Hint({ id, text }: { id: string; text: string }): JSX.Element {
  return (
    <p id={id} className="px-1 pb-2 text-2xs leading-relaxed text-slate-400">
      {text}
    </p>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-x-2 gap-y-2.5';

export function TitlesBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  return (
    <div data-testid="library-titles" className="min-h-0 flex-1 overflow-y-auto p-2">
      <Hint id={hintId} text={t('library.titlesHint')} />
      <ul className={GRID} aria-label={t('library.titles')}>
        {TITLE_PRESETS.map((preset) => (
          <TitleItem key={preset} preset={preset} hintId={hintId} />
        ))}
      </ul>
    </div>
  );
}

function TitleItem({ preset, hintId }: { preset: TitlePreset; hintId: string }): JSX.Element {
  const t = useT();
  const text = t(TITLE_TEXT[preset]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    // Drawn in the template's own faces, never in a fallback caught mid-load.
    void titleThumbReady(preset, text).finally(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [preset, text]);
  const drawRef = useRef<{ key: string; draw: Draw } | null>(null);
  const key = `${preset}|${text}`;
  if (drawRef.current?.key !== key) {
    drawRef.current = { key, draw: (context, seconds) => drawTitleThumb(context, THUMB_WIDTH, THUMB_HEIGHT, preset, text, seconds) };
  }
  return (
    <LibraryItem
      label={t(TITLE_NAME[preset])}
      testId={`library-title-${preset}`}
      dragKind="title"
      dragValue={preset}
      hintId={hintId}
      draw={drawRef.current.draw}
      ready={ready}
      onAdd={() => useProjectStore.getState().addTitle(preset)}
    />
  );
}

/** Stable per preset, so a re-render does not restart a playing thumbnail. */
const TRANSITION_DRAW = Object.fromEntries(
  TRANSITION_PRESETS.map((preset) => [
    preset,
    ((context, seconds) =>
      drawTransitionThumb(context, THUMB_WIDTH, THUMB_HEIGHT, preset, seconds === null ? null : transitionLoopProgress(seconds))) as Draw,
  ]),
) as Record<TransitionPreset, Draw>;

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
  return (
    <div data-testid="library-transitions" className="min-h-0 flex-1 overflow-y-auto p-2">
      <Hint id={hintId} text={t('library.transitionsHint')} />
      <ul className={GRID} aria-label={t('library.transitions')}>
        {TRANSITION_PRESETS.map((preset) => (
          <LibraryItem
            key={preset}
            label={t(TRANSITION_LABEL[preset])}
            testId={`library-transition-${preset}`}
            dragKind="transition"
            dragValue={preset}
            hintId={hintId}
            draw={TRANSITION_DRAW[preset]}
            ready
            onAdd={() => add(preset)}
          />
        ))}
      </ul>
    </div>
  );
}
