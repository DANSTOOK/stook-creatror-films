import type { ClipDrawn } from '@shared/types';

/**
 * A colour laid over something this app drew.
 *
 * `source-atop` rather than a blend mode or a hue rotation, and each of those
 * was tried on paper:
 *
 * - A hue rotation does NOTHING to grey. Paper, concrete, marble and every
 *   safe-area guide are grey or near it, so the one lever would have worked on
 *   half the catalogue and quietly ignored the rest.
 * - The 'color' blend mode does colourise grey, but over a TRANSPARENT backdrop
 *   it paints anyway - which fills the hole in the middle of a frame, and the
 *   hole is the whole point of a frame.
 *
 * `source-atop` paints only where something is already drawn, so a frame keeps
 * its hole and a background takes the wash over all of it. At a strength below
 * one the structure underneath still reads through.
 */
export function applyTint(context: CanvasRenderingContext2D, width: number, height: number, tint: NonNullable<ClipDrawn['tint']>): void {
  if (tint.strength <= 0) return;
  context.save();
  context.globalCompositeOperation = 'source-atop';
  context.globalAlpha = Math.min(1, tint.strength);
  context.fillStyle = tint.color;
  context.fillRect(0, 0, width, height);
  context.restore();
}

/** Part of the file name, so two tints of one picture are two files. */
export const tintSuffix = (tint: ClipDrawn['tint']): string =>
  tint && tint.strength > 0 ? `-${tint.color.replace('#', '')}-${Math.round(tint.strength * 100)}` : '';
