import { useCallback, useEffect, useRef } from 'react';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Playback clock.
 *
 * The playhead advances off `performance.now()` rather than off a frame
 * counter, so a dropped render frame costs a skipped picture instead of
 * desynchronising the timeline from real time (and from the audio clock).
 */
export function useTransport(): {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(frame: number): void;
  step(delta: number): void;
} {
  const isPlaying = useProjectStore((state) => state.ui.isPlaying);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);
  const frameAccumulator = useRef(0);

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

      frameAccumulator.current += elapsedSeconds * project.fps;
      const wholeFrames = Math.floor(frameAccumulator.current);

      if (wholeFrames >= 1) {
        frameAccumulator.current -= wholeFrames;
        const next = project.currentFrame + wholeFrames;

        if (next >= project.durationFrames) {
          if (ui.loopPlayback) {
            setCurrentFrame(0);
          } else {
            setCurrentFrame(project.durationFrames);
            setPlaying(false);
            return;
          }
        } else {
          setCurrentFrame(next);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying]);

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
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [transport]);
}
