import { computeScopes, type ScopeData, type ScopeKind } from './scopeMath';
import { drawScope, type ScopeLabels } from './scopeDraw';

/**
 * The scopes' own thread.
 *
 * Measuring 150 thousand pixels and drawing the traces takes several
 * milliseconds - on a 180 Hz display, more than a whole frame. On the page's
 * thread that came out of the picture's time: 4K playback dropped a frame now
 * and then with the scopes open. Here it costs the page nothing: the page
 * posts the frame it read back, and each scope's canvas was handed over as an
 * OffscreenCanvas, so the result goes to the screen from here.
 *
 * Only the newest frame matters. The page sends one at a time and holds any
 * that arrive meanwhile, keeping just the latest (ScopesPanel).
 */

export type ScopeWorkerMessage =
  /** A canvas handed over, known by `id` from now on. */
  | { type: 'canvas'; id: number; canvas: OffscreenCanvas }
  /** Which canvas shows scope `slot`; null when that slot is gone. */
  | { type: 'assign'; slot: number; id: number | null }
  /** A canvas whose element is gone for good. */
  | { type: 'release'; id: number }
  | { type: 'clear' }
  | { type: 'resize'; slot: number; width: number; height: number }
  | { type: 'settings'; kinds: ScopeKind[]; scale: number; labels: ScopeLabels; debug: boolean }
  | { type: 'frame'; rgba: Uint8Array; width: number; height: number };

export interface ScopeWorkerReply {
  type: 'drawn';
  /** Time spent here measuring and drawing. */
  ms: number;
  /** What was drawn, when the page asked for it (the interface tests). */
  data?: ScopeData;
}

const canvases = new Map<number, OffscreenCanvas>();
const slots = new Map<number, number>();
const canvasFor = (slot: number): OffscreenCanvas | undefined => {
  const id = slots.get(slot);
  return id === undefined ? undefined : canvases.get(id);
};
let kinds: ScopeKind[] = [];
let scale = 1;
let labels: ScopeLabels = { skin: 'Skin' };
let debug = false;
let lastFrame: { rgba: Uint8Array; width: number; height: number } | null = null;

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<ScopeWorkerMessage>) => void) | null;
  postMessage(message: ScopeWorkerReply): void;
};

/** Measure the last frame for the scopes on show and draw them. */
function render(reply: boolean): void {
  const started = performance.now();
  const data = lastFrame ? computeScopes(lastFrame, new Set(kinds)) : null;
  kinds.forEach((kind, slot) => {
    const canvas = canvasFor(slot);
    if (canvas) drawScope(canvas, kind, data, scale, labels);
  });
  if (reply) worker.postMessage({ type: 'drawn', ms: performance.now() - started, ...(debug && data ? { data } : {}) });
}

worker.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'canvas':
      canvases.set(message.id, message.canvas);
      return;
    case 'assign':
      if (message.id === null) slots.delete(message.slot);
      else slots.set(message.slot, message.id);
      render(false);
      return;
    case 'release':
      canvases.delete(message.id);
      return;
    case 'clear':
      // The panel closed: nothing to draw on, nothing worth keeping.
      slots.clear();
      lastFrame = null;
      return;
    case 'resize': {
      const canvas = canvasFor(message.slot);
      if (!canvas) return;
      canvas.width = Math.max(1, message.width);
      canvas.height = Math.max(1, message.height);
      render(false);
      return;
    }
    case 'settings':
      kinds = message.kinds;
      scale = message.scale;
      labels = message.labels;
      debug = message.debug;
      render(debug);
      return;
    case 'frame':
      lastFrame = { rgba: message.rgba, width: message.width, height: message.height };
      render(true);
      return;
    default:
      return;
  }
};
