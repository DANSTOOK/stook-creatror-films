import type { TitleAnchor } from '@shared/types';

/**
 * Captions from several tracks on screen at once, stacked rather than drawn
 * over each other.
 *
 * Every captions track pins its text to the same edge of the title-safe
 * area, so two burned in together landed on the same lines. At each frame
 * the caption of the lowest track keeps its place at the edge; one from a
 * track above it, pinned to the same edge, is moved inward by the height of
 * the ones already there and a gap - so the stack only exists while they
 * share the screen, and a caption alone is exactly where it always was.
 */

export interface StackedCaption {
  id: string;
  anchor: TitleAnchor;
  /** Height of what it draws - its lines, or its box - in project pixels. */
  height: number;
  /** Room left between it and the next one up the stack, project pixels. */
  gap: number;
}

/**
 * How far each caption moves, in project pixels with y pointing down:
 * negative lifts one at the bottom, positive lowers one at the top. Given
 * bottom track first, as the compositor draws them; a caption that need not
 * move is left out.
 */
export function captionOffsets(captions: readonly StackedCaption[]): Map<string, number> {
  const offsets = new Map<string, number>();
  const taken = { top: 0, bottom: 0 };
  for (const caption of captions) {
    const edge = caption.anchor.startsWith('top') ? 'top' : caption.anchor.startsWith('bottom') ? 'bottom' : null;
    if (!edge) continue;
    if (taken[edge] > 0) offsets.set(caption.id, edge === 'bottom' ? -taken[edge] : taken[edge]);
    taken[edge] += caption.height + caption.gap;
  }
  return offsets;
}
