import type { AnimationLayer, Clip, DrawnAnimation } from '@shared/types';
import { celExposures, exposureAt, exposureCount } from './model';

/**
 * Moving about the drawings, and the keys that do it.
 *
 * The keys here act only while the brush is in hand, which is what makes them
 * safe: they are a tool's keys, as in Krita or Photoshop, not the editor's.
 * `[` and `]` for brush width are the convention everywhere, and neither is
 * bound by the editor. `,` and `.` step between DRAWINGS - the editor binds
 * them to insert and overwrite, which mean nothing with a brush in hand.
 *
 * Deliberately NOT taken: B (split) and C (razor), which the editor binds to
 * tools a hand reaches for between strokes.
 */

/** How much `[` and `]` change the brush each press: a fifth, so a few presses cross the range. */
export const SIZE_STEP = 1.2;

/**
 * The exposure to go to from here, stepping between drawings that EXIST
 * rather than between exposures.
 *
 * Forwards past the last drawing goes to the next exposure that has none, so
 * a new drawing can be started there - which is how an animation grows. It
 * stops at the end of the clip rather than running past it.
 */
export function nextDrawing(anim: DrawnAnimation, clip: Pick<Clip, 'startFrame' | 'durationFrames'>, layer: AnimationLayer | undefined, from: number): number {
  const last = exposureCount(anim, clip) - 1;
  const after = (layer ? celExposures(layer) : []).find((at) => at > from);
  if (after !== undefined) return Math.min(after, last);
  return Math.min(from + 1, last);
}

export function previousDrawing(layer: AnimationLayer | undefined, from: number): number {
  const before = (layer ? celExposures(layer) : []).filter((at) => at < from);
  if (before.length > 0) return before[before.length - 1];
  return Math.max(0, from - 1);
}

/** What a key press means with the brush in hand; null when it means nothing here. */
export type DrawKey =
  | { kind: 'size'; by: number }
  | { kind: 'step'; by: -1 | 1 }
  | { kind: 'brush'; brush: 'pencil' | 'eraser' };

export function drawKeyOf(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): DrawKey | null {
  // A key with a modifier belongs to the editor, always: Ctrl+Z must undo
  // while drawing, which is the whole point of a stroke being one step.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case '[':
      return { kind: 'size', by: 1 / SIZE_STEP };
    case ']':
      return { kind: 'size', by: SIZE_STEP };
    case ',':
      return { kind: 'step', by: -1 };
    case '.':
      return { kind: 'step', by: 1 };
    case 'e':
    case 'E':
      return { kind: 'brush', brush: 'eraser' };
    case 'p':
    case 'P':
      return { kind: 'brush', brush: 'pencil' };
    default:
      return null;
  }
}

/** The exposure the playhead is on, for a clip known to be an animation. */
export const exposureOf = (clip: Clip, frame: number): number => (clip.anim ? exposureAt(clip.anim, clip, frame) : 0);
