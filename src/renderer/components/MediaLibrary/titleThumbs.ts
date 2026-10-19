import type { TitleContent } from '@shared/types';
import { rasterizeTitle } from '@renderer/text/render';
import { titleAnimationAt } from '@renderer/text/animation';
import { textMotionAt } from '@renderer/text/textMotion';
import { loadTitleFonts } from '@renderer/text/fonts';
import { titleFromTemplate, type TitleTemplate } from '@renderer/text/templates';
import type { FrameSize } from '@renderer/text/layout';

/**
 * The pictures on the Titles panel: each template drawn by the title
 * renderer itself on a small frame of its own shape - 16:9, or 9:16 for the
 * vertical ones - over a dim backdrop, as it will sit on footage.
 *
 * Drawn with Canvas2D on the panel's own canvases, never by the compositor:
 * a thumbnail must not cost the viewer a frame. Still until pointed at or
 * focused; then it plays the template's own entrance, a beat at rest, and
 * its exit, with the same arithmetic the timeline uses - only smaller.
 */

/** The frame a thumbnail's title is laid out on: small, so a picture at rest is cheap to keep. */
const LANDSCAPE: FrameSize = { width: 640, height: 360 };
const PORTRAIT: FrameSize = { width: 360, height: 640 };
const THUMB_FPS = 60;
/** At rest between the entrance and the exit, and nothing between loops. */
const HOLD_SECONDS = 1;
const GAP_SECONDS = 0.4;

export const thumbFrame = (template: TitleTemplate): FrameSize => (template.vertical ? PORTRAIT : LANDSCAPE);

export const thumbTitle = (template: TitleTemplate, text: string): TitleContent => titleFromTemplate(template, text, thumbFrame(template));

/** How long one loop of a template's thumbnail lasts. */
export function titleLoopSeconds(template: TitleTemplate): number {
  const { animation } = template;
  if (animation.roll) return 4;
  return (animation.in === 'none' ? 0 : animation.inSeconds) + HOLD_SECONDS + (animation.out === 'none' ? 0 : animation.outSeconds);
}

/** Ready to draw once the template's faces are in (bundled: milliseconds). */
export const titleThumbReady = (template: TitleTemplate, text: string): Promise<void> => loadTitleFonts(thumbTitle(template, text));

interface Still {
  canvas: HTMLCanvasElement;
  rect: { x: number; y: number; width: number; height: number };
}

/** Pictures at rest, by template, text and frame: the loop only moves and fades them. */
const stills = new Map<string, Still>();

function stillOf(title: TitleContent, frame: FrameSize, key: string): Still | null {
  const kept = stills.get(key);
  if (kept) return kept;
  try {
    const raster = rasterizeTitle(title, frame);
    // The renderer's canvas is shared with the viewer's titles: copied out.
    const canvas = document.createElement('canvas');
    canvas.width = raster.canvas.width;
    canvas.height = raster.canvas.height;
    canvas.getContext('2d')?.drawImage(raster.canvas, 0, 0);
    const still = { canvas, rect: raster.rect };
    stills.set(key, still);
    return still;
  } catch {
    return null;
  }
}

/**
 * Draw a template's title `seconds` into its hover loop, or at rest (fully
 * on) when seconds is null.
 */
export function drawTemplateThumb(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  template: TitleTemplate,
  text: string,
  seconds: number | null,
): void {
  const frame = thumbFrame(template);
  const title = thumbTitle(template, text);
  context.save();
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#0b0f16';
  context.fillRect(0, 0, width, height);

  // The frame's place in the tile: all of it, or a vertical strip in the middle.
  const k = Math.min(width / frame.width, height / frame.height);
  const region = { x: (width - frame.width * k) / 2, y: (height - frame.height * k) / 2, width: frame.width * k, height: frame.height * k };
  const backdrop = context.createLinearGradient(0, region.y, 0, region.y + region.height);
  backdrop.addColorStop(0, '#3b4a61');
  backdrop.addColorStop(1, '#1b2432');
  context.fillStyle = backdrop;
  context.fillRect(region.x, region.y, region.width, region.height);
  context.beginPath();
  context.rect(region.x, region.y, region.width, region.height);
  context.clip();

  const loop = titleLoopSeconds(template);
  const duration = Math.max(1, Math.round(loop * THUMB_FPS));
  let at: number;
  if (seconds === null) {
    // Resting: after the entrance; for a roll, its first lines in view.
    at = template.animation.roll ? Math.round(duration * 0.3) : Math.round((template.animation.in === 'none' ? 0 : template.animation.inSeconds) * THUMB_FPS + (HOLD_SECONDS * THUMB_FPS) / 2);
  } else {
    at = Math.round((seconds % (loop + GAP_SECONDS)) * THUMB_FPS);
  }
  if (at < duration) {
    const key = `${template.id}|${frame.width}x${frame.height}|${text}`;
    const still = stillOf(title, frame, key);
    const motion = textMotionAt(title.animation, at, duration, THUMB_FPS);
    const picture = motion ? rasterizeTitle(title, frame, 1, motion) : still;
    if (still && picture) {
      // A whole frame this small makes the letters a few pixels high, so the
      // view closes in on the text - about the frame's corner or edge nearest
      // it, so a lower third still sits low and to the left.
      const rest = still.rect;
      const zoom = template.animation.roll ? 1 : Math.max(1, Math.min(2.2, (frame.width * 0.85) / rest.width));
      const third = (value: number, size: number): number => (value < size / 3 ? 0 : value > (size * 2) / 3 ? size : size / 2);
      const pivotX = third(rest.x + rest.width / 2, frame.width);
      const pivotY = template.animation.roll ? frame.height / 2 : third(rest.y + rest.height / 2, frame.height);
      context.translate(region.x, region.y);
      context.scale(k, k);
      context.translate(pivotX, pivotY);
      context.scale(zoom, zoom);
      context.translate(-pivotX, -pivotY);
      const state = titleAnimationAt(title.animation, at, duration, THUMB_FPS, frame.height, { y: rest.y, height: rest.height });
      const rect = 'layout' in picture ? picture.rect : rest;
      const cx = rest.x + rest.width / 2 + state.offset.x;
      const cy = rest.y + rest.height / 2 + state.offset.y;
      context.globalAlpha = Math.min(1, Math.max(0, state.opacity));
      context.translate(cx, cy);
      context.scale(state.scale, state.scale);
      context.translate(-(rest.x + rest.width / 2), -(rest.y + rest.height / 2));
      if (state.reveal < 1.5) {
        // A wipe: only the part of the picture its edge has crossed.
        context.beginPath();
        context.rect(rect.x, rect.y, rect.width * Math.max(0, state.reveal), rect.height);
        context.clip();
      }
      context.drawImage(picture.canvas, rect.x, rect.y, rect.width, rect.height);
    }
  }
  context.restore();
}
