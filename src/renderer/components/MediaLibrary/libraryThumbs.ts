import type { TitleContent, TitlePreset, TransitionDirection } from '@shared/types';
import { presetKind, type TransitionPreset } from '@renderer/timing/transitions';
import { rasterizeTitle } from '@renderer/text/render';
import { presetStyle } from '@renderer/text/titleStyle';
import { presetAnimation, titleAnimationAt } from '@renderer/text/animation';
import { loadTitleFonts } from '@renderer/text/fonts';

/**
 * The pictures on the Titles and Transitions panels.
 *
 * Drawn with Canvas2D on the panel's own small canvases, never by the
 * compositor: a thumbnail must not cost the viewer a frame. They are still
 * until pointed at or focused, then play one loop after another, and stay
 * still when the system asks for less motion or while the preview plays.
 *
 * Each follows the real thing's arithmetic - the transition shader's
 * directions and edge, a title's own animation curves - so what the panel
 * shows is what the timeline will do, only smaller.
 */

/* Transitions ------------------------------------------------------------------- */

/** Hold on A, the transition (linear, as the real one's progress is), hold on B. */
export const TRANSITION_LOOP = { holdA: 0.35, run: 1, holdB: 0.55 } as const;
const TRANSITION_LOOP_SECONDS = TRANSITION_LOOP.holdA + TRANSITION_LOOP.run + TRANSITION_LOOP.holdB;

/** Where a still transition thumbnail stops: far enough in to show what it does. */
const STILL_PROGRESS: Record<TransitionPreset, number> = {
  crossDissolve: 0.5,
  dipToBlack: 0.3,
  dipToWhite: 0.3,
  wipe: 0.5,
  slide: 0.6,
  push: 0.5,
};

/** A side's picture, drawn once per size: a warm A and a cool B, each with its letter. */
const sides = new Map<string, HTMLCanvasElement>();

function sidePicture(letter: 'A' | 'B', width: number, height: number): HTMLCanvasElement {
  const key = `${letter}:${width}x${height}`;
  const cached = sides.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    // Amber and blue: told apart by lightness as well as hue, so they read
    // as two pictures to someone who does not see the colours.
    if (letter === 'A') {
      gradient.addColorStop(0, '#fbbf24');
      gradient.addColorStop(1, '#b45309');
    } else {
      gradient.addColorStop(0, '#38bdf8');
      gradient.addColorStop(1, '#1e3a8a');
    }
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = letter === 'A' ? 'rgba(69, 26, 3, 0.85)' : 'rgba(255, 255, 255, 0.92)';
    context.font = `700 ${Math.round(height * 0.5)}px system-ui, "Segoe UI", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(letter, width / 2, height / 2 + height * 0.03);
  }
  sides.set(key, canvas);
  return canvas;
}

/** Screen offset of a direction, canvas pixels (y down); the shader's texture space is y up. */
function screenVector(direction: TransitionDirection, width: number, height: number): { x: number; y: number } {
  switch (direction) {
    case 'left':
      return { x: -width, y: 0 };
    case 'right':
      return { x: width, y: 0 };
    case 'up':
      return { x: 0, y: -height };
    case 'down':
    default:
      return { x: 0, y: height };
  }
}

let scratch: HTMLCanvasElement | null = null;

/** Draw `preset` at `progress` (0..1), or at its still point when progress is null. */
export function drawTransitionThumb(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  preset: TransitionPreset,
  progress: number | null,
): void {
  const p = Math.min(1, Math.max(0, progress ?? STILL_PROGRESS[preset]));
  const a = sidePicture('A', width, height);
  const b = sidePicture('B', width, height);
  const { kind, color, direction } = presetKind(preset);
  context.save();
  context.clearRect(0, 0, width, height);
  context.globalAlpha = 1;

  if (kind === 'crossDissolve') {
    context.drawImage(a, 0, 0);
    context.globalAlpha = p;
    context.drawImage(b, 0, 0);
  } else if (kind === 'dip') {
    // Out through the colour, then in from it, as the shader does.
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = p < 0.5 ? 1 - p * 2 : p * 2 - 1;
    context.drawImage(p < 0.5 ? a : b, 0, 0);
  } else if (kind === 'wipe') {
    // B behind an edge that travels the direction's way, softened as the
    // default softness softens it (a tenth of the frame).
    context.drawImage(a, 0, 0);
    scratch ??= document.createElement('canvas');
    if (scratch.width !== width) scratch.width = width;
    if (scratch.height !== height) scratch.height = height;
    const mask = scratch.getContext('2d');
    if (mask) {
      mask.globalCompositeOperation = 'source-over';
      mask.clearRect(0, 0, width, height);
      mask.drawImage(b, 0, 0);
      mask.globalCompositeOperation = 'destination-in';
      const travel = screenVector(direction, width, height);
      // From the side the edge starts at to the side it ends at.
      const x0 = travel.x < 0 ? width : 0;
      const y0 = travel.y < 0 ? height : 0;
      const gradient = mask.createLinearGradient(x0, y0, x0 + travel.x, y0 + travel.y);
      const soft = 0.1;
      const edge = -soft / 2 + p * (1 + soft);
      const stop = (at: number): number => Math.min(1, Math.max(0, at));
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(stop(edge - soft / 2), 'rgba(0,0,0,1)');
      gradient.addColorStop(stop(edge + soft / 2), 'rgba(0,0,0,0)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      mask.fillStyle = edge + soft / 2 <= 0 ? 'rgba(0,0,0,0)' : gradient;
      mask.fillRect(0, 0, width, height);
      mask.globalCompositeOperation = 'source-over';
      context.drawImage(scratch, 0, 0);
    }
  } else {
    // Slide: B comes in from the far side over A. Push: A goes out ahead of it.
    const travel = screenVector(direction, width, height);
    if (kind === 'push') context.drawImage(a, travel.x * p, travel.y * p);
    else context.drawImage(a, 0, 0);
    context.drawImage(b, -travel.x * (1 - p), -travel.y * (1 - p));
  }
  context.restore();
}

/** The transition's progress `seconds` into a hover loop. */
export function transitionLoopProgress(seconds: number): number {
  const at = seconds % TRANSITION_LOOP_SECONDS;
  return Math.min(1, Math.max(0, (at - TRANSITION_LOOP.holdA) / TRANSITION_LOOP.run));
}

/* Titles -------------------------------------------------------------------------- */

/** The loop a title plays on hover: its template's in and out, or a whole roll. */
export const titleLoopSeconds = (preset: TitlePreset): number => (preset === 'credits' ? 4 : 2.4);
/** A beat of nothing between loops, so the entrance is seen as one. */
const TITLE_GAP_SECONDS = 0.4;
const THUMB_FPS = 60;

interface TitlePicture {
  canvas: HTMLCanvasElement;
  rect: { x: number; y: number; width: number; height: number };
}

const titlePictures = new Map<string, TitlePicture>();

/**
 * A template's text drawn by the title renderer itself, at the thumbnail's
 * size, once (per text and size): the loop only moves and fades it.
 */
export function titlePicture(preset: TitlePreset, text: string, width: number, height: number): TitlePicture | null {
  const key = `${preset}:${width}x${height}:${text}`;
  const cached = titlePictures.get(key);
  if (cached) return cached;
  const title = thumbTitle(preset, text);
  try {
    const raster = rasterizeTitle(title, { width, height });
    // The renderer's canvas is shared with the viewer's titles: copied out.
    const canvas = document.createElement('canvas');
    canvas.width = raster.canvas.width;
    canvas.height = raster.canvas.height;
    canvas.getContext('2d')?.drawImage(raster.canvas, 0, 0);
    const picture = { canvas, rect: raster.rect };
    titlePictures.set(key, picture);
    return picture;
  } catch {
    return null;
  }
}

export const thumbTitle = (preset: TitlePreset, text: string): TitleContent => ({
  preset,
  text,
  style: presetStyle(preset),
  animation: presetAnimation(preset),
  origin: 'text',
});

/** Ready to draw once the template's faces are in (bundled: milliseconds). */
export const titleThumbReady = (preset: TitlePreset, text: string): Promise<void> => loadTitleFonts(thumbTitle(preset, text));

/**
 * Draw a template's title over a neutral backdrop, `seconds` into its hover
 * loop, or resting (fully on) when seconds is null.
 */
export function drawTitleThumb(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  preset: TitlePreset,
  text: string,
  seconds: number | null,
): void {
  context.save();
  context.clearRect(0, 0, width, height);
  // A dim scene for the text to sit on, as it will sit on footage.
  const backdrop = context.createLinearGradient(0, 0, 0, height);
  backdrop.addColorStop(0, '#3b4a61');
  backdrop.addColorStop(1, '#1b2432');
  context.fillStyle = backdrop;
  context.fillRect(0, 0, width, height);

  const picture = titlePicture(preset, text, width, height);
  if (picture) {
    const loop = titleLoopSeconds(preset);
    const duration = Math.round(loop * THUMB_FPS);
    let frame: number;
    if (seconds === null) {
      // Resting: the middle of a title; for a roll, its first lines in view.
      frame = preset === 'credits' ? Math.round(duration * 0.3) : Math.round(duration / 2);
    } else {
      frame = Math.round((seconds % (loop + TITLE_GAP_SECONDS)) * THUMB_FPS);
    }
    if (frame <= duration) {
      const { rect } = picture;
      // A whole frame this small makes the letters a few pixels high, so the
      // view closes in on the text - about the frame's corner or edge nearest
      // it, so a lower third still sits low and to the left.
      const zoom = Math.max(1, Math.min(2.2, (width * 0.8) / rect.width));
      const third = (at: number, size: number): number => (at < size / 3 ? 0 : at > (size * 2) / 3 ? size : size / 2);
      const pivotX = third(rect.x + rect.width / 2, width);
      const pivotY = preset === 'credits' ? height / 2 : third(rect.y + rect.height / 2, height);
      context.translate(pivotX, pivotY);
      context.scale(zoom, zoom);
      context.translate(-pivotX, -pivotY);
      const state = titleAnimationAt(presetAnimation(preset), frame, duration, THUMB_FPS, height, { y: rect.y, height: rect.height });
      const cx = rect.x + rect.width / 2 + state.offset.x;
      const cy = rect.y + rect.height / 2 + state.offset.y;
      context.globalAlpha = Math.min(1, Math.max(0, state.opacity));
      context.translate(cx, cy);
      context.scale(state.scale, state.scale);
      context.drawImage(picture.canvas, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
    }
  }
  context.restore();
}
