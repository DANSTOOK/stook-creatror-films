/**
 * How many pixels the viewer draws.
 *
 * Paused, every pixel of the frame: a still is looked at closely. Playing,
 * fewer can do - each effect, transition and grade is a pass over every
 * pixel drawn, and a 4K edit in a viewer a thousand pixels wide drew four
 * times what reached the screen, which an integrated GPU could not keep up
 * with once a zoom, a blur and a brightness were stacked. 'auto' draws what
 * the viewer shows (on a high-DPI screen, its device pixels); the fractions
 * are Resolve's and Premiere's playback resolutions. Exports never come
 * here: they draw the whole frame.
 */

export type PreviewQuality = 'auto' | 'full' | 'half' | 'quarter';

export const PREVIEW_QUALITIES: readonly PreviewQuality[] = ['auto', 'full', 'half', 'quarter'];

const FRACTION: Record<Exclude<PreviewQuality, 'auto'>, number> = { full: 1, half: 1 / 2, quarter: 1 / 4 };

/** Not worth a coarser picture: within this of the whole frame, the whole frame is drawn. */
const NEAR_FULL = 0.85;
/** Never fewer lines than this, however small the viewer: titles stay legible. */
const MIN_HEIGHT = 270;

export function previewSize(
  frame: { width: number; height: number },
  options: {
    playing: boolean;
    quality: PreviewQuality;
    display: { width: number; height: number } | null;
    /** Pixel art keeps every pixel: a coarser draw would smear its grid. */
    exact?: boolean;
  },
): { width: number; height: number } {
  if (!options.playing || options.exact || options.quality === 'full') return frame;
  let scale: number;
  if (options.quality === 'auto') {
    if (!options.display || options.display.width <= 0 || options.display.height <= 0) return frame;
    scale = Math.max(options.display.width / frame.width, options.display.height / frame.height);
  } else {
    scale = FRACTION[options.quality];
  }
  scale = Math.max(scale, Math.min(1, MIN_HEIGHT / frame.height));
  if (scale >= NEAR_FULL) return frame;
  // Even sizes: chroma and the canvas's scaling both like them.
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(frame.width * scale), height: even(frame.height * scale) };
}
