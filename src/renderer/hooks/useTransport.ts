import { useCallback, useEffect, useRef } from 'react';
import { useProjectStore } from '@renderer/store/useProjectStore';

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
  const step = useCallback((delta: number) => useProjectStore.getState().stepFrames(delta), []);

  return { play, pause, toggle, seek, step };
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
  },
  elapsedSeconds: number,
  accumulator: number,
): ClockTick {
  const carried = accumulator + Math.max(0, elapsedSeconds) * options.fps;
  const wholeFrames = Math.floor(carried);

  if (wholeFrames < 1) {
    return { frame: options.currentFrame, accumulator: carried, stopped: false };
  }

  const remainder = carried - wholeFrames;
  const next = options.currentFrame + wholeFrames;

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

      const store = useProjectStore.getState();
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          transport.toggle();
          return;
        case 'ArrowLeft':
          event.preventDefault();
          transport.step(event.shiftKey ? -10 : -1);
          return;
        case 'ArrowRight':
          event.preventDefault();
          transport.step(event.shiftKey ? 10 : 1);
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
        case 'm':
          // Drop a marker at the playhead, the way every NLE spells it.
          store.addMarker();
          return;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [transport]);
}
