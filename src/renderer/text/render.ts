import type { TitleContent } from '@shared/types';
import { fontString } from './fonts';
import { layoutTitle, type FrameSize, type Measurer, type Rect, type TitleLayout } from './layout';

/**
 * Titles drawn with Canvas2D, into a picture the compositor uploads as a
 * texture.
 *
 * Canvas2D because Chromium already does everything text needs: shaping
 * (HarfBuzz), kerning and ligatures, bidirectional text, colour emoji, and
 * falling back to the system font that has a character the chosen family
 * lacks. A GPU glyph atlas (SDF/MSDF) would have to rebuild all of that.
 *
 * Drawn at the size it will be shown - the project's pixels, times the
 * largest scale the clip is keyframed to - so a 4K export has 4K edges, not a
 * 1080p picture blown up. The picture covers only the text (with room for
 * outline and shadow), not the whole frame; `rect` says where it goes.
 *
 * The same picture feeds the viewer and the export: one raster, so the two
 * cannot differ.
 */

export interface TitleRaster {
  canvas: HTMLCanvasElement;
  /** Where the picture goes on the frame, in project pixels, top-left origin. */
  rect: Rect;
  /** Canvas pixels per project pixel. */
  scale: number;
  layout: TitleLayout;
}

/** Widest or tallest a title's picture may be: WebGL2 guarantees 4096; this GPU class does 16384. */
const MAX_SIDE = 8192;

let scratch: HTMLCanvasElement | null = null;
let measuring: CanvasRenderingContext2D | null = null;

function measuringContext(): CanvasRenderingContext2D {
  if (!measuring) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    measuring = canvas.getContext('2d');
    if (!measuring) throw new Error('Canvas2D is unavailable');
  }
  return measuring;
}

/**
 * Measurement by the same engine that draws. `scale` is the raster's: text
 * is measured at the size it is drawn, so the lines are placed for the
 * glyphs as they will actually come out.
 */
export function canvasMeasurer(title: TitleContent, scale: number): Measurer {
  const context = measuringContext();
  const { fontFamily, fontWeight } = title.style;
  const setFont = (size: number, spacing: number): void => {
    context.font = fontString(fontFamily, fontWeight, size * scale);
    context.letterSpacing = `${spacing * scale}px`;
    context.fontKerning = 'normal';
  };
  return {
    width(text, size, spacing) {
      if (text === '') return 0;
      setFont(size, spacing);
      // Letter spacing is added after every letter, the last one included;
      // that trailing space is not part of the line's width.
      return (context.measureText(text).width - spacing * scale) / scale;
    },
    metrics(size) {
      setFont(size, 0);
      const measured = context.measureText('Hg');
      return { ascent: measured.fontBoundingBoxAscent / scale, descent: measured.fontBoundingBoxDescent / scale };
    },
  };
}

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

/**
 * The raster scale for a title: at least one canvas pixel per project pixel,
 * more when the clip is scaled up, never a picture larger than MAX_SIDE.
 */
export function rasterScale(layout: TitleLayout, largestClipScale: number): number {
  const wanted = Math.min(4, Math.max(1, largestClipScale));
  const fit = MAX_SIDE / Math.max(layout.bounds.width, layout.bounds.height);
  return Math.max(0.25, Math.min(wanted, fit));
}

/** Draw a title. The canvas is shared and reused: upload it before the next call. */
export function rasterizeTitle(title: TitleContent, frame: FrameSize, largestClipScale = 1): TitleRaster {
  // Laid out once at 1:1 to learn the size, then at the scale it is drawn.
  const first = layoutTitle(title, frame, canvasMeasurer(title, 1));
  const scale = rasterScale(first, largestClipScale);
  const layout = scale === 1 ? first : layoutTitle(title, frame, canvasMeasurer(title, scale));
  const { bounds } = layout;

  scratch ??= document.createElement('canvas');
  const canvas = scratch;
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas2D is unavailable');

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  const toX = (x: number): number => (x - bounds.x) * scale;
  const toY = (y: number): number => (y - bounds.y) * scale;
  const { style } = title;
  const unit = layout.unit * scale;

  if (layout.box) {
    context.fillStyle = rgba(style.box.color, style.box.opacity);
    context.beginPath();
    context.roundRect(toX(layout.box.x), toY(layout.box.y), layout.box.width * scale, layout.box.height * scale, style.box.radius * unit);
    context.fill();
  }

  const eachLine = (draw: (text: string, x: number, y: number) => void): void => {
    for (const line of layout.lines) {
      if (line.text === '') continue;
      context.font = fontString(style.fontFamily, style.fontWeight, line.size * scale);
      context.letterSpacing = `${line.spacing * scale}px`;
      context.fontKerning = 'normal';
      draw(line.text, toX(line.x), toY(line.baseline));
    }
  };

  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.direction = 'ltr';

  // The shadow is cast by the lowest layer of the letters: the outline when
  // there is one, so the shadow is the outlined shape's; the fill otherwise.
  const castShadow = (): void => {
    if (!style.shadow.enabled || style.shadow.opacity <= 0) return;
    const radians = (style.shadow.angle * Math.PI) / 180;
    context.shadowColor = rgba(style.shadow.color, style.shadow.opacity);
    context.shadowBlur = style.shadow.blur * unit;
    context.shadowOffsetX = Math.cos(radians) * style.shadow.distance * unit;
    context.shadowOffsetY = Math.sin(radians) * style.shadow.distance * unit;
  };
  const noShadow = (): void => {
    context.shadowColor = 'rgba(0, 0, 0, 0)';
    context.shadowBlur = 0;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
  };

  const stroked = style.stroke.enabled && style.stroke.width > 0;
  if (stroked) {
    // Twice the width, centred on the outline, with the fill drawn over the
    // inner half: the outline grows outwards and never thins the letters.
    castShadow();
    context.strokeStyle = style.stroke.color;
    context.lineWidth = style.stroke.width * unit * 2;
    context.lineJoin = 'round';
    context.miterLimit = 2;
    eachLine((text, x, y) => context.strokeText(text, x, y));
    noShadow();
  } else {
    castShadow();
  }
  context.fillStyle = style.color;
  eachLine((text, x, y) => context.fillText(text, x, y));
  noShadow();

  return {
    canvas,
    rect: { x: bounds.x, y: bounds.y, width: width / scale, height: height / scale },
    scale,
    layout,
  };
}
