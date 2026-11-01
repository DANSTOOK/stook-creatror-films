import type { AnimationCel, AnimationLayer, Clip, DrawnAnimation, OnionSkin, Stroke } from '@shared/types';

/**
 * The shape of a drawn animation, and the arithmetic of time in it.
 *
 * An animation has two clocks and keeping them apart is the whole of this
 * file. TIMELINE frames are the project's, the ones the playhead counts.
 * EXPOSURES are the animation's own: with `step` 2 - "on twos", which is what
 * most hand-drawn animation is shot at - one exposure lasts two timeline
 * frames, so twelve drawings cover a second of twenty-four.
 *
 * A drawing is held until the next one begins, exactly as a sheet of paper
 * stays under the camera until it is changed. So the cels of a layer need not
 * be one per exposure: three cels at 0, 4 and 10 are three drawings held for
 * four, six and the rest.
 */

export const DEFAULT_ONION: OnionSkin = { enabled: true, before: 1, after: 1, opacity: 0.35, by: 'drawings' };

/** The largest `step` worth allowing: beyond this a drawing is on screen so long it reads as a still. */
export const MAX_STEP = 8;
export const MAX_ONION = 8;

/** An empty animation with one layer, as a new animation clip starts. */
export function emptyAnimation(layerName = 'Layer 1'): DrawnAnimation {
  return { layers: [{ id: newId('layer'), name: layerName, visible: true, opacity: 1, cels: [] }], step: 2, onion: { ...DEFAULT_ONION } };
}

let counter = 0;
/** Ids are only ever compared, never parsed. */
export function newId(what: string): string {
  counter += 1;
  return `${what}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Which exposure a timeline frame falls in.
 *
 * `frame` is the frame of the TIMELINE; the clip's own start is taken off
 * here, so a clip moved along the timeline shows the same drawings at the
 * same points in itself. Before the clip starts, the first exposure - a
 * drawing does not begin halfway through.
 */
export function exposureAt(anim: DrawnAnimation, clip: Pick<Clip, 'startFrame'>, frame: number): number {
  const step = stepOf(anim);
  const into = Math.floor(frame) - Math.floor(clip.startFrame);
  if (into <= 0) return 0;
  return Math.floor(into / step);
}

/** The first timeline frame of an exposure, which is where a drawing appears. */
export function frameOfExposure(anim: DrawnAnimation, clip: Pick<Clip, 'startFrame'>, exposure: number): number {
  return Math.floor(clip.startFrame) + Math.max(0, Math.floor(exposure)) * stepOf(anim);
}

/** How many exposures a clip of this length holds; at least one. */
export function exposureCount(anim: DrawnAnimation, clip: Pick<Clip, 'durationFrames'>): number {
  return Math.max(1, Math.ceil(Math.max(1, Math.floor(clip.durationFrames)) / stepOf(anim)));
}

export function stepOf(anim: DrawnAnimation): number {
  const step = Math.round(anim.step);
  return Number.isFinite(step) && step >= 1 ? Math.min(step, MAX_STEP) : 1;
}

/**
 * The drawing a layer shows at an exposure: the last one that has begun.
 * Null before the layer's first drawing - a layer whose first cel is at 4
 * shows nothing for the first four exposures, which is how a character enters.
 */
export function celAt(layer: AnimationLayer, exposure: number): AnimationCel | null {
  let found: AnimationCel | null = null;
  for (const cel of layer.cels) {
    if (cel.at > exposure) break;
    found = cel;
  }
  return found;
}

/** Where a layer's drawings begin, ascending: the exposures a cel is ON, for the sheet and for onion skin. */
export function celExposures(layer: AnimationLayer): number[] {
  return layer.cels.map((cel) => cel.at);
}

/**
 * The neighbouring drawings to show faintly, nearest first, with the opacity
 * each should be drawn at.
 *
 * The two ways of counting are genuinely different and both are wanted:
 *
 * - `drawings` steps from one drawing to the next however long each is held.
 *   It answers "what did I draw before this one", which is what a hand asks.
 * - `frames` looks a fixed distance in time, so a drawing held for six
 *   exposures is its own neighbour at distance 1 and nothing new appears.
 *   It answers "what is on screen a moment either side".
 *
 * Opacity fades with distance, so the drawing just before is clearly the one
 * just before. The current exposure is never included.
 */
export function onionAround(layer: AnimationLayer, exposure: number, onion: OnionSkin): { cel: AnimationCel; opacity: number; side: 'before' | 'after' }[] {
  if (!onion.enabled) return [];
  const before = clampCount(onion.before);
  const after = clampCount(onion.after);
  const strongest = clamp01(onion.opacity);
  if (strongest <= 0 || (before === 0 && after === 0)) return [];
  const out: { cel: AnimationCel; opacity: number; side: 'before' | 'after' }[] = [];
  const current = celAt(layer, exposure);

  const fade = (distance: number, of: number): number => strongest * (1 - (distance - 1) / Math.max(1, of));

  if (onion.by === 'drawings') {
    const index = layer.cels.findIndex((cel) => cel === current);
    const from = index >= 0 ? index : layer.cels.length;
    for (let step = 1; step <= before; step += 1) {
      const cel = layer.cels[from - step];
      if (!cel) break;
      out.push({ cel, opacity: fade(step, before), side: 'before' });
    }
    for (let step = 1; step <= after; step += 1) {
      const cel = layer.cels[from + step];
      if (!cel) break;
      out.push({ cel, opacity: fade(step, after), side: 'after' });
    }
    return out;
  }

  // By exposures in time: a held drawing shows no new neighbour, and the same
  // drawing is never shown twice however many exposures away it is still on.
  const seen = new Set<string>();
  if (current) seen.add(current.id);
  for (let step = 1; step <= before; step += 1) {
    const cel = exposure - step >= 0 ? celAt(layer, exposure - step) : null;
    if (!cel || seen.has(cel.id)) continue;
    seen.add(cel.id);
    out.push({ cel, opacity: fade(step, before), side: 'before' });
  }
  for (let step = 1; step <= after; step += 1) {
    const cel = celAt(layer, exposure + step);
    if (!cel || seen.has(cel.id)) continue;
    seen.add(cel.id);
    out.push({ cel, opacity: fade(step, after), side: 'after' });
  }
  return out;
}

/**
 * A cel put in at an exposure, keeping the list ascending. An exposure that
 * already has a drawing of its OWN is replaced; one that is merely showing a
 * held drawing gets a new one, which is how a held drawing is broken into two.
 */
export function withCel(layer: AnimationLayer, cel: AnimationCel): AnimationLayer {
  const cels = layer.cels.filter((existing) => existing.at !== cel.at);
  cels.push(cel);
  cels.sort((a, b) => a.at - b.at);
  return { ...layer, cels };
}

/**
 * A stroke added to the drawing at an exposure.
 *
 * At an exposure that is only SHOWING a held drawing, this starts a new,
 * blank one. It does not copy the held drawing: a new exposure is a new
 * drawing, which is the whole of frame-by-frame animation, and the previous
 * one is what onion skin is for. Copying it would also make every drawing
 * carry every stroke before it, which grows without end. To draw on top of
 * the previous drawing on purpose, duplicate it first (`duplicateCel`).
 */
export function withStroke(layer: AnimationLayer, exposure: number, stroke: Stroke): AnimationLayer {
  const own = layer.cels.find((cel) => cel.at === exposure);
  if (own) return withCel(layer, { ...own, strokes: [...own.strokes, stroke] });
  return withCel(layer, { id: newId('cel'), at: exposure, strokes: [stroke] });
}

/** The drawing shown at an exposure copied to one of its own, to draw on top of. */
export function duplicateCel(layer: AnimationLayer, exposure: number): AnimationLayer {
  const held = celAt(layer, exposure);
  if (!held || held.at === exposure) return layer;
  return withCel(layer, { id: newId('cel'), at: exposure, strokes: [...held.strokes] });
}

/** Everything the layers draw, for a count to show. */
export function strokeCount(anim: DrawnAnimation): number {
  return anim.layers.reduce((total, layer) => total + layer.cels.reduce((sum, cel) => sum + cel.strokes.length, 0), 0);
}

export function celCount(anim: DrawnAnimation): number {
  return anim.layers.reduce((total, layer) => total + layer.cels.length, 0);
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const clampCount = (value: number): number => (Number.isFinite(value) ? Math.min(MAX_ONION, Math.max(0, Math.round(value))) : 0);

/**
 * An animation read from a file, in a shape this build can draw.
 *
 * Anything unreadable is dropped rather than guessed at: a stroke with an odd
 * number of coordinates is not a stroke, and half of one would draw wrongly.
 * Returns undefined when there is nothing left, so a clip carries no field
 * rather than an empty one.
 */
export function normalizeAnimation(value: unknown): DrawnAnimation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<DrawnAnimation>;
  if (!Array.isArray(raw.layers)) return undefined;
  const layers: AnimationLayer[] = [];
  for (const layer of raw.layers) {
    const normalized = normalizeLayer(layer);
    if (normalized) layers.push(normalized);
  }
  if (layers.length === 0) return undefined;
  const step = Math.round(Number(raw.step));
  return {
    layers,
    step: Number.isFinite(step) && step >= 1 ? Math.min(step, MAX_STEP) : 1,
    onion: normalizeOnion(raw.onion),
  };
}

function normalizeLayer(value: unknown): AnimationLayer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<AnimationLayer>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const cels: AnimationCel[] = [];
  const taken = new Set<number>();
  for (const cel of Array.isArray(raw.cels) ? raw.cels : []) {
    const normalized = normalizeCel(cel);
    if (!normalized || taken.has(normalized.at)) continue;
    taken.add(normalized.at);
    cels.push(normalized);
  }
  cels.sort((a, b) => a.at - b.at);
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Layer',
    visible: raw.visible !== false,
    opacity: Number.isFinite(raw.opacity) ? clamp01(raw.opacity as number) : 1,
    cels,
  };
}

function normalizeCel(value: unknown): AnimationCel | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<AnimationCel>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const at = Math.round(Number(raw.at));
  if (!Number.isFinite(at) || at < 0) return null;
  const strokes: Stroke[] = [];
  for (const stroke of Array.isArray(raw.strokes) ? raw.strokes : []) {
    const normalized = normalizeStroke(stroke);
    if (normalized) strokes.push(normalized);
  }
  return { id: raw.id, at, strokes };
}

function normalizeStroke(value: unknown): Stroke | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Stroke>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const points = Array.isArray(raw.points) ? raw.points : null;
  // Three numbers a point, at least one point, every one a real number: a
  // stroke that fails any of these cannot be drawn and is not kept.
  if (!points || points.length < 3 || points.length % 3 !== 0) return null;
  if (!points.every((number) => typeof number === 'number' && Number.isFinite(number))) return null;
  const brush = raw.brush === 'marker' || raw.brush === 'eraser' ? raw.brush : 'pencil';
  const size = Number(raw.size);
  return {
    id: raw.id,
    brush,
    color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : '#ffffff',
    size: Number.isFinite(size) && size > 0 ? Math.min(0.5, size) : 0.006,
    opacity: Number.isFinite(raw.opacity) ? clamp01(raw.opacity as number) : 1,
    points,
  };
}

function normalizeOnion(value: unknown): OnionSkin {
  if (!value || typeof value !== 'object') return { ...DEFAULT_ONION };
  const raw = value as Partial<OnionSkin>;
  return {
    enabled: raw.enabled !== false,
    before: clampCount(Number(raw.before ?? DEFAULT_ONION.before)),
    after: clampCount(Number(raw.after ?? DEFAULT_ONION.after)),
    opacity: Number.isFinite(raw.opacity) ? clamp01(raw.opacity as number) : DEFAULT_ONION.opacity,
    by: raw.by === 'frames' ? 'frames' : 'drawings',
  };
}
