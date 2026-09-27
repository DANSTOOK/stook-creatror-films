import type { ProjectState } from '@shared/types';
import type { ScopeCapture } from '@renderer/engine/Compositor';
import type { FrameRenderer } from '@renderer/engine/FrameRenderer';

/**
 * When the video scopes look at the picture, and who gets what they saw.
 *
 * The scopes panel subscribes while it is on screen; with nobody subscribed
 * nothing here does any work, and the GPU surfaces are given back. The viewer's
 * draw loop calls `tickScopes` after every frame it draws, and this decides:
 *
 *   - paused: a new reading after each change - the project was edited, or a
 *     seek landed a new picture - and none at all while nothing changes;
 *   - playing: about 12 a second (every 80 ms), and none on a frame that came
 *     late, so the picture always gets the frame first. Resolve and Premiere
 *     also slow their scopes down during playback;
 *   - exporting: nothing. The export owns the GPU and the canvas.
 *
 * The reading itself is asynchronous (Compositor.captureForScopes): the draw
 * loop never waits for it.
 */

/** Pixels across the frame the scopes measure. 512 is plenty for a panel. */
export const SCOPE_SAMPLE_WIDTH = 512;
/** Minimum time between readings during playback: 12.5 a second. */
export const PLAYING_INTERVAL_MS = 80;

type Listener = (capture: ScopeCapture) => void;

const listeners = new Set<Listener>();
let latest: ScopeCapture | null = null;

/** Counters for the tests and for measuring what the scopes cost. */
export interface ScopeStats {
  captures: number;
  published: number;
  skippedLate: number;
  skippedExport: number;
  /** Main-thread milliseconds spent starting readbacks. */
  captureMs: number;
  /** Main-thread milliseconds spent handing frames to the scopes' worker. */
  postMs: number;
  /** Milliseconds the worker spent measuring and drawing (off the main thread). */
  drawMs: number;
  lastDrawMs: number;
  drawn: number;
}

export const scopeStats: ScopeStats = {
  captures: 0,
  published: 0,
  skippedLate: 0,
  skippedExport: 0,
  captureMs: 0,
  postMs: 0,
  drawMs: 0,
  lastDrawMs: 0,
  drawn: 0,
};

// For the interface tests: what the scopes cost, and the last frame they read.
if (typeof window !== 'undefined') {
  const scoped = window as { __scfScopeStats?: ScopeStats; __scfScopeCapture?: () => ScopeCapture | null };
  scoped.__scfScopeStats = scopeStats;
  scoped.__scfScopeCapture = () => latest;
}

/** Listen for readings. The last one arrives at once, if there is one. */
export function subscribeScopes(listener: Listener): () => void {
  listeners.add(listener);
  forceNext = true;
  if (latest) listener(latest);
  return () => {
    listeners.delete(listener);
  };
}

export const scopesWanted = (): boolean => listeners.size > 0;

/** The last reading, for a panel redrawing after a resize or a change of scope. */
export const latestScopeCapture = (): ScopeCapture | null => latest;

function publish(capture: ScopeCapture): void {
  latest = capture;
  scopeStats.published += 1;
  for (const listener of listeners) listener(capture);
}

/* The scheduler ----------------------------------------------------------- */

let forceNext = true;
let holdingResources = false;
let lastProject: ProjectState | null = null;
let lastGeneration = -1;
let lastCaptureAt = -Infinity;
let lastTickAt = 0;
/** Smoothed gap between draw-loop ticks, to recognise a late one. */
let typicalGap = 1000 / 60;

/** Called by the viewer's draw loop after each frame it draws. */
export function tickScopes(renderer: FrameRenderer, project: ProjectState, playing: boolean, now: number): void {
  const gap = lastTickAt > 0 ? now - lastTickAt : typicalGap;
  lastTickAt = now;
  const late = gap > Math.max(20, typicalGap * 1.5);
  if (!late) typicalGap += (gap - typicalGap) * 0.1;

  const { compositor } = renderer;
  if (!scopesWanted()) {
    if (holdingResources) {
      compositor.releaseScopes();
      holdingResources = false;
      latest = null;
      lastProject = null;
    }
    return;
  }
  if (renderer.isExclusive) {
    compositor.cancelScopeCapture();
    scopeStats.skippedExport += 1;
    forceNext = true;
    return;
  }

  const capture = compositor.takeScopeCapture();
  if (capture) publish(capture);

  const generation = renderer.textures.generation;
  if (playing) {
    if (now - lastCaptureAt < PLAYING_INTERVAL_MS) return;
    if (late) {
      scopeStats.skippedLate += 1;
      return;
    }
  } else if (!forceNext && project === lastProject && generation === lastGeneration) {
    return;
  }

  const started = performance.now();
  if (compositor.captureForScopes(SCOPE_SAMPLE_WIDTH)) {
    holdingResources = true;
    forceNext = false;
    lastCaptureAt = now;
    lastProject = project;
    lastGeneration = generation;
    scopeStats.captures += 1;
  }
  scopeStats.captureMs += performance.now() - started;
}

/** Note time the worker spent measuring and drawing a frame. */
export function noteScopeDraw(ms: number): void {
  scopeStats.drawMs += ms;
  scopeStats.lastDrawMs = ms;
  scopeStats.drawn += 1;
}

/** Note main-thread time spent handing a frame to the worker. */
export function noteScopePost(ms: number): void {
  scopeStats.postMs += ms;
}
