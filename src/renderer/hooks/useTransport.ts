import { useCallback, useEffect } from 'react';
import { emitScrub } from '@renderer/audio/scrubAudio';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { currentLoopRange } from '@renderer/timing/loopRange';
import { notify } from '@renderer/notifications/notifications';
import { t } from '@renderer/i18n';
import { shuttleRate } from './shuttle';
import { cancelFrame, requestFrame } from '@renderer/timing/animationFrame';
import { spaceFromSlider } from './spaceFromSlider';

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

/**
 * Where playback begins when the transport is asked to play.
 *
 * Pressing play with the playhead at the end used to start playback and stop
 * it in the same instant: there is nothing left to show, so the clock reported
 * "stopped" on its first tick. On screen that reads as a dead space bar, and
 * it stays dead until the project changes and the playhead goes back - which
 * is exactly how the user met it. Play from the end means play again.
 *
 * Looping is left alone: the clock wraps by itself, so moving the playhead
 * here would only fight it.
 */
export function playStartFrame(currentFrame: number, durationFrames: number, loop: boolean): number {
  if (loop || durationFrames <= 0) return currentFrame;
  return currentFrame >= durationFrames - 1 ? 0 : currentFrame;
}

/** Start playback, rewinding first when the playhead has nothing left to play. */
function startPlaying(): void {
  const { project, ui, setCurrentFrame, setPlaying } = useProjectStore.getState();
  const from = playStartFrame(project.currentFrame, project.durationFrames, ui.loopPlayback);
  if (from !== project.currentFrame) setCurrentFrame(from);
  setPlaying(true);
}

/** Commands only. No effects, no timers - safe to call anywhere. */
export function useTransport(): Transport {
  const play = useCallback(() => startPlaying(), []);
  const pause = useCallback(() => useProjectStore.getState().setPlaying(false), []);
  const toggle = useCallback(() => {
    const { ui, setPlaying } = useProjectStore.getState();
    if (ui.isPlaying) setPlaying(false);
    else startPlaying();
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
    /**
     * What a loop goes round (timing/loopRange): `start` included, `end` not.
     * Without one, the whole canvas, as it always was.
     */
    loopStart?: number;
    loopEnd?: number;
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
  const current = options.currentFrame;
  const next = current + wholeFrames;

  if (options.loop) {
    const start = Math.max(0, Math.round(options.loopStart ?? 0));
    const end = Math.max(start + 1, Math.round(options.loopEnd ?? options.durationFrames));
    const length = end - start;
    /*
      The wrap is exact: the frames that ran past the end carry on from the
      start, as the sound does (the audio engine lays the next time round
      on its clock ahead of the join). Snapping to the start dropped them,
      so every time round the picture lost up to a frame against the sound.
    */
    if (wholeFrames > 0) {
      // Put somewhere past the loop while it plays: back to its start.
      if (current >= end) return { frame: start, accumulator: remainder, stopped: false };
      if (next >= end) return { frame: start + ((next - start) % length), accumulator: remainder, stopped: false };
      return { frame: next, accumulator: remainder, stopped: false };
    }
    // Backwards: round the other way, from the start to the last frame.
    if (current < start) return { frame: end - 1, accumulator: remainder, stopped: false };
    if (next < start) return { frame: end - 1 - ((start - 1 - next) % length), accumulator: remainder, stopped: false };
    return { frame: next, accumulator: remainder, stopped: false };
  }

  if (wholeFrames < 0) {
    if (next > 0) return { frame: next, accumulator: remainder, stopped: false };
    // Back at the head: stand there.
    return { frame: 0, accumulator: 0, stopped: true };
  }

  if (next >= options.durationFrames) {
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

  useEffect(() => (isPlaying ? runPlaybackClock() : undefined), [isPlaying]);
}

/** Where the clock's frames come from: the editor's windows, or a test's hand. */
export interface FrameSource {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

const editorFrames: FrameSource = { request: requestFrame, cancel: cancelFrame };

/**
 * The loop behind `usePlaybackClock`: from now until the returned function
 * is called, every frame moves the playhead on by the time that has passed,
 * and the end of the timeline stops playback. Apart from the hook so that
 * a test can hand it frames one at a time.
 */
export function runPlaybackClock(frames: FrameSource = editorFrames, startTime = performance.now()): () => void {
  let lastTime = startTime;
  let accumulator = 0;
  let handle: number | null = null;
  let reported = false;

  const tick = (now: number): void => {
    // The next frame is asked for first. Asked for last, as it was, any
    // exception on the way - from anything the playhead's move notifies -
    // ended the loop for good while the store still said "playing": the
    // button showed Pause and the playhead stood still. The frame source
    // reports an exception and carries on with the other loops, but it
    // cannot ask again for a loop that never did.
    handle = frames.request(tick);

    try {
      const { project, ui, setCurrentFrame, setPlaying } = useProjectStore.getState();
      const elapsedSeconds = (now - lastTime) / 1000;
      lastTime = now;
      const loop = ui.loopPlayback ? currentLoopRange(project, ui) : null;

      const result = advancePlayhead(
        {
          currentFrame: project.currentFrame,
          durationFrames: project.durationFrames,
          fps: project.fps,
          loop: loop !== null,
          loopStart: loop?.start,
          loopEnd: loop?.end,
          rate: ui.playbackRate,
        },
        elapsedSeconds,
        accumulator,
      );

      accumulator = result.accumulator;
      if (result.frame !== project.currentFrame) setCurrentFrame(result.frame);

      if (result.stopped) {
        frames.cancel(handle);
        handle = null;
        setPlaying(false);
      }
    } catch (error) {
      // Said once per play, not thirty times a second.
      if (!reported) console.error('Playback clock: a tick failed; playback carries on.', error);
      reported = true;
    }
  };

  handle = frames.request(tick);

  return () => {
    if (handle !== null) frames.cancel(handle);
    handle = null;
  };
}

/**
 * Detach the sound of the selected clips, and say so when there was nothing
 * to detach - a key that does nothing silently reads as a key that is broken.
 * Shared by the key, the menu and the timeline's right-click menu.
 */
export function detachSelectionAudio(clipIds?: string[]): void {
  const store = useProjectStore.getState();
  const made = store.detachAudio(clipIds);
  if (made.length === 0) notify(t('detach.nothing'), 'warning');
}

/** Rejoin, with a word when some sound had been moved apart and was left alone. */
export function rejoinSelectionAudio(clipIds?: string[]): void {
  const { joined, apart } = useProjectStore.getState().rejoinAudio(clipIds);
  if (apart > 0) notify(t('detach.apart', { count: apart }), 'warning');
  else if (joined === 0) notify(t('detach.nothingToJoin'), 'warning');
}

/** Global editing shortcuts, matching the layout Filmora users expect. */
export function useEditorShortcuts(): void {
  const transport = useTransport();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a field the user is typing into - except Space
      // from a slider, which has no use for it (spaceFromSlider).
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !spaceFromSlider(event)) return;
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

      // A title at the playhead: Ctrl+Alt+T, and a lower third with Shift -
      // Final Cut's Control-T and Control-Shift-T, with Ctrl+T left for
      // transitions as Final Cut and Resolve have it. By physical key, since
      // Ctrl+Alt is AltGr on many layouts.
      if (modifier && event.altKey && event.code === 'KeyT') {
        event.preventDefault();
        store.addTitle(event.shiftKey ? 'lowerThird' : 'title');
        return;
      }

      // Detach audio: Ctrl+Alt+S. Final Cut's Control-Shift-S, and CapCut's
      // Ctrl+Shift+S, is Save As here, as in Premiere and every Windows app;
      // Alt is the next modifier over, and S still says Separate. By physical
      // key, since Ctrl+Alt is AltGr on many layouts.
      if (modifier && event.altKey && !event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        detachSelectionAudio();
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
          case 'l':
            // Ctrl+Shift+L unlinks, the mirror of Ctrl+L, as in Premiere.
            event.preventDefault();
            store.unlinkSelection();
            return;
          default:
            break;
        }
      }

      // A grade, copied and pasted between clips: Ctrl+Alt+C and Ctrl+Alt+V,
      // Premiere's and Final Cut's Paste Attributes pair. Checked by physical
      // key, since Ctrl+Alt is AltGr on many layouts.
      if (modifier && event.altKey && !event.shiftKey && (event.code === 'KeyC' || event.code === 'KeyV')) {
        event.preventDefault();
        if (event.code === 'KeyC') store.copyGrade();
        else store.pasteGrade();
        return;
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
          case 'l':
            // Link the selection: from here on it moves and trims as one.
            event.preventDefault();
            store.linkSelection();
            return;
          case '/':
            // Loop playback on or off: Ctrl+/, Resolve's Loop/Unloop. (On a
            // Spanish keyboard / is Shift+7, and Ctrl+Shift+7 arrives here.)
            // Final Cut's Command-L is Link here, as in Premiere.
            event.preventDefault();
            store.setLoopPlayback(!store.ui.loopPlayback);
            return;
          case 't':
          case 'd':
            // The default transition: Ctrl+T as in Final Cut and Resolve,
            // Ctrl+D as in Premiere.
            if (event.shiftKey) return;
            event.preventDefault();
            store.addTransitions();
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
          // A picked transition goes on its own; the clips it joins stay.
          if (store.ui.selectedTransitionId) {
            event.preventDefault();
            store.removeTransition(store.ui.selectedTransitionId);
            return;
          }
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
        case 't':
          // Shift+T puts the transform handles on the selected clip, the key
          // Final Cut uses; plain T is the trim tool.
          if (event.shiftKey) store.setUi({ transformMode: !store.ui.transformMode });
          else store.setTool('trim');
          return;
        case 'f':
          // Shift+F fills the window with the picture; Escape comes back.
          if (event.shiftKey) store.setUi({ fullscreenViewer: !store.ui.fullscreenViewer });
          return;
        case 'd':
          // Shift+D shows the picture with every grade off, as in Resolve.
          if (event.shiftKey) store.setUi({ gradeBypass: !store.ui.gradeBypass });
          return;
        case 'w':
          // Shift+W puts the before/after curtain up, or takes it down.
          if (event.shiftKey) store.setUi({ compareSplit: store.ui.compareSplit === null ? 0.5 : null });
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
