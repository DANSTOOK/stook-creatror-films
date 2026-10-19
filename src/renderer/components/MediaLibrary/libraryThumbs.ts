import type { TransitionDirection } from '@shared/types';
import { presetKind, type TransitionPreset } from '@renderer/timing/transitions';

/**
 * The pictures on the Transitions panel (the Titles panel's are titleThumbs.ts).
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
