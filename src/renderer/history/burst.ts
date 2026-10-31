import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Undo and redo, one render per frame however fast the keys come.
 *
 * Holding Ctrl+Z is not one edit, it is a key repeating: every press arrives
 * as its own task, and each one swapped the whole project document and made
 * the editor render again. Measured on a 120-clip project (tests/perf/editing,
 * "25 undos and 25 redos"): 27% of the frames dropped, with two frames of 58
 * and 73 ms whose time was ALL before rendering and in NO script long enough
 * to be named - fifty small tasks in one frame, not one slow function.
 *
 * So the first press is applied at once - a single undo must not wait for a
 * frame to feel immediate - and anything that arrives before the next frame is
 * queued and applied with it, all in one task. Every step still happens, in
 * order, through the same store: what is dropped is only the rendering of the
 * states in between, which nobody could see anyway.
 *
 * `flushHistory` exists because those in-between states must not be skipped by
 * anything that READS the project: an edit arriving while steps are queued
 * would be recorded against a document the queue has not finished rewinding.
 * `transact` calls it before every edit.
 */

type Step = 'undo' | 'redo';

let queued: Step[] = [];
let appliedThisFrame = false;
let scheduled = 0;

function schedule(): void {
  if (scheduled) return;
  scheduled = requestAnimationFrame(flush);
}

function flush(): void {
  scheduled = 0;
  if (queued.length === 0) {
    // A frame with nothing queued closes the window: the next press is again
    // applied the moment it arrives.
    appliedThisFrame = false;
    return;
  }
  const steps = queued;
  queued = [];
  const store = useProjectStore.getState();
  for (const step of steps) {
    if (step === 'undo') store.undo();
    else store.redo();
  }
  schedule();
}

/** Take a step back or forward, coalescing a burst into one render per frame. */
export function historyStep(step: Step): void {
  // The old path, a render per press, kept so the two can be measured against
  // each other in the same build (tests/perf/editing).
  const direct = (globalThis as { __scfNoHistoryBurst?: boolean }).__scfNoHistoryBurst === true;
  if (!direct && appliedThisFrame) {
    queued.push(step);
    schedule();
    return;
  }
  const store = useProjectStore.getState();
  if (step === 'undo') store.undo();
  else store.redo();
  if (direct) return;
  appliedThisFrame = true;
  schedule();
}

/** Apply anything still queued, now. Safe to call when nothing is. */
export function flushHistory(): void {
  if (queued.length === 0) return;
  if (scheduled) {
    cancelAnimationFrame(scheduled);
    scheduled = 0;
  }
  flush();
}

/** Forget a pending burst: a new project has nothing to rewind. */
export function clearHistoryBurst(): void {
  queued = [];
  appliedThisFrame = false;
  if (scheduled) {
    cancelAnimationFrame(scheduled);
    scheduled = 0;
  }
}
