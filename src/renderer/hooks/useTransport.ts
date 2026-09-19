import { useCallback, useEffect, useRef } from 'react';
import { emitScrub } from '@renderer/audio/scrubAudio';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { shuttleRate } from './shuttle';

/**
 * Playback transport.
 *
 * The CLOCK and the COMMANDS are deliberately separate hooks. The clock owns a
 * `requestAnimationFrame` loop that advances the playhead, so mounting it twice
 * would advance the playhead twice per frame and play everything at double
 * speed. `usePlaybackClock` must therefore be mounted exactly once, by `App`;
 * `useTransport` is free of effects and safe to call from any component.
 */

export interface Transport {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(frame: number): void;
  step(delta: number): void;
  /** Move the playhead by hand, with sound: a drag or a click on a scrubber. */
  scrub(frame: number): void;
}

/** Commands only. No effects, no timers - safe to call anywhere. */
export function useTransport(): Transport {
  const play = useCallback(() => useProjectStore.getState().setPlaying(true), []);
  const pause = useCallback(() => useProjectStore.getState().setPlaying(false), []);
  const toggle = useCallback(() => {
    const { ui, setPlaying } = useProjectStore.getState();
    setPlaying(!ui.isPlaying);
  }, []);
  const seek = useCallback((frame: number) => useProjectStore.getState().setCurrentFrame(frame), []);
  const step = useCallback((delta: number) => {
    useProjectStore.getState().stepFrames(delta);
    emitScrub(useProjectStore.getState().project.currentFrame);
  }, []);
  const scrub = useCallback((frame: number) => {
    useProjectStore.getState().setCurrentFrame(frame);
    emitScrub(useProjectStore.getState().project.currentFrame);
  }, []);

  return { play, pause, toggle, seek, step, scrub };
}

export interface ClockTick {
  /** Frame to move the playhead to. */
  frame: number;
  /** Fractional remainder carried into the next tick. */
  accumulator: number;
  /** True when the playhead reached the end and playback should stop. */
  stopped: boolean;
}

/**
 * Advance the playhead by real elapsed time.
 *
 * Pure, so the clock's behaviour is testable without a browser: the accumulator
 * carries the fractional frame between ticks, which is what keeps playback at
 * true speed when the display refresh rate and the project rate disagree (60 Hz
 * screen, 24 fps timeline).
 */
export function advancePlayhead(
  options: {
    currentFrame: number;
    durationFrames: number;
    fps: number;
    loop: boolean;
    /** Speed and direction; 1 is ordinary play, negative runs backwards. */
    rate?: number;
  },
  elapsedSeconds: number,
  accumulator: number,
): ClockTick {
  const rate = options.rate ?? 1;
  const carried = accumulator + Math.max(0, elapsedSeconds) * options.fps * rate;
  // Truncated towards zero, so running backwards counts whole frames too.
  const wholeFrames = Math.trunc(carried);

  if (wholeFrames === 0) {
    return { frame: options.currentFrame, accumulator: carried, stopped: false };
  }

  const remainder = carried - wholeFrames;
  const next = options.currentFrame + wholeFrames;

  if (wholeFrames < 0) {
    if (next > 0) return { frame: next, accumulator: remainder, stopped: false };
    // Back at the head: round again when looping, otherwise stand there.
    if (options.loop) return { frame: Math.max(0, options.durationFrames - 1), accumulator: remainder, stopped: false };
    return { frame: 0, accumulator: 0, stopped: true };
  }

  if (next >= options.durationFrames) {
    if (options.loop) return { frame: 0, accumulator: remainder, stopped: false };
    return { frame: options.durationFrames, accumulator: 0, stopped: true };
  }

  return { frame: next, accumulator: remainder, stopped: false };
}

/**
 * How many playback clocks are currently mounted.
 *
 * Exposed because mounting two is a silent, nasty bug: each one advances the
 * shared playhead, so everything plays at double speed. It happened once
 * already, by calling the hook from two components.
 */
let mountedClocks = 0;
export const getMountedClockCount = (): number => mountedClocks;

/**
 * The playback clock. Mount exactly once, from `App`.
 *
 * The playhead advances off `performance.now()` rather than off a frame
 * counter, so a dropped render frame costs a skipped picture instead of
 * desynchronising the timeline from real time (and from the audio clock).
 */
export function usePlaybackClock(): void {
  const isPlaying = useProjectStore((state) => state.ui.isPlaying);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);
  const frameAccumulator = useRef(0);

  useEffect(() => {
    mountedClocks += 1;
    if (mountedClocks > 1) {
      // Loud on purpose: the symptom is "everything plays too fast", which is
      // very hard to trace back to a duplicated hook.
      console.error(
        `usePlaybackClock is mounted ${mountedClocks} times. The playhead will ` +
          'advance once per clock, so playback will run at that multiple of ' +
          'real speed. Mount it only from App.',
      );
    }
    return () => {
      mountedClocks -= 1;
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }

    lastTimeRef.current = performance.now();
    frameAccumulator.current = 0;

    const tick = (now: number): void => {
      const { project, ui, setCurrentFrame, setPlaying } = useProjectStore.getState();
      const elapsedSeconds = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      const result = advancePlayhead(
        {
          currentFrame: project.currentFrame,
          durationFrames: project.durationFrames,
          fps: project.fps,
          loop: ui.loopPlayback,
          rate: ui.playbackRate,
        },
        elapsedSeconds,
        frameAccumulator.current,
      );

      frameAccumulator.current = result.accumulator;
      if (result.frame !== project.currentFrame) setCurrentFrame(result.frame);

      if (result.stopped) {
        setPlaying(false);
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying]);
}

/** Global editing shortcuts, matching the layout Filmora users expect. */
export function useEditorShortcuts(): void {
  const transport = useTransport();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a field the user is typing into.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      // The start screen is not the editor: no playing, cutting or nudging behind it.
      if (useSessionStore.getState().view !== 'editor') return;

      const store = useProjectStore.getState();
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }

      // Copy, cut and paste clips (point 10). Handled here, before the single
      // letters below: Ctrl+C used to fall through to "C" and pick the razor.
      // Clearing the marks, before Ctrl+X is read as cut.
      if (modifier && event.shiftKey) {
        switch (event.key.toLowerCase()) {
          case 'i':
            event.preventDefault();
            store.setUi({ inFrame: null });
            return;
          case 'o':
            event.preventDefault();
            store.setUi({ outFrame: null });
            return;
          case 'x':
            event.preventDefault();
            store.clearMarks();
            return;
          default:
            break;
        }
      }

      if (modifier) {
        switch (event.key.toLowerCase()) {
          case 'c':
            event.preventDefault();
            store.copySelection();
            return;
          case 'x':
            event.preventDefault();
            store.cutSelection();
            return;
          case 'v':
            event.preventDefault();
            store.paste();
            return;
          case 'y':
            event.preventDefault();
            store.redo();
            return;
          default:
            // Any other Ctrl combination belongs to the app or the system, not
            // to the single-letter tool keys.
            return;
        }
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          transport.toggle();
          return;
        // With clips selected the arrows move them - Shift for ten frames, up
        // and down to another track. With nothing selected they step the
        // playhead, as they always did; Escape clears the selection to get back.
        case 'ArrowLeft':
        case 'ArrowRight': {
          event.preventDefault();
          const frames = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1);
          if (store.ui.selectedClipIds.length > 0) store.nudgeSelection(frames, 0, event.repeat);
          else transport.step(frames);
          return;
        }
        case 'ArrowUp':
        case 'ArrowDown':
          if (store.ui.selectedClipIds.length > 0) {
            event.preventDefault();
            store.nudgeSelection(0, event.key === 'ArrowUp' ? -1 : 1, event.repeat);
          }
          return;
        case 'Escape':
          if (store.ui.selectedClipIds.length > 0) store.selectClips([]);
          return;
        case 'Home':
          event.preventDefault();
          transport.seek(0);
          return;
        case 'End':
          event.preventDefault();
          transport.seek(store.project.durationFrames);
          return;
        // Premiere's keys: "\" shows the whole sequence, = and - zoom around
        // the playhead.
        case '\\':
          event.preventDefault();
          store.zoomToFit();
          return;
        case '=':
        case '+':
          event.preventDefault();
          store.zoomBy(1.4);
          return;
        case '-':
          event.preventDefault();
          store.zoomBy(1 / 1.4);
          return;
        case 'Delete':
        case 'Backspace':
          if (store.ui.selectedClipIds.length > 0) {
            event.preventDefault();
            store.removeClips(store.ui.selectedClipIds);
          }
          return;
        default:
          break;
      }

      switch (event.key.toLowerCase()) {
        case 'c':
          store.setTool('razor');
          return;
        case 'v':
          store.setTool('select');
          return;
        case 'h':
          store.setTool('hand');
          return;
        case 'b':
          // Razor at the playhead, the keyboard equivalent of a razor click.
          store.razorAtFrame();
          return;
        case 's':
          store.setUi({ snappingEnabled: !store.ui.snappingEnabled });
          return;
        case 'n':
          // The magnet: close gaps left by deleting, moving or trimming.
          store.setUi({ rippleEnabled: !store.ui.rippleEnabled });
          return;
        case 'm':
          // Drop a marker at the playhead, the way every NLE spells it.
          store.addMarker();
          return;
        case 'i':
          store.markIn();
          return;
        case 'o':
          store.markOut();
          return;
        case 'l':
          // The shuttle: L forward, J back, K stopped, each press faster.
          store.setPlaybackRate(shuttleRate(store.ui.isPlaying ? store.ui.playbackRate : 0, 1));
          return;
        case 'j':
          store.setPlaybackRate(shuttleRate(store.ui.isPlaying ? store.ui.playbackRate : 0, -1));
          return;
        case 'k':
          store.setPlaybackRate(0);
          return;
        case ',':
          // Three-point edits from the library clip in hand.
          store.insertSelectedAsset();
          return;
        case '.':
          store.overwriteSelectedAsset();
          return;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [transport]);
}
