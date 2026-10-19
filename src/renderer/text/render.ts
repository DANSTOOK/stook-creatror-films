import type { TitleContent } from '@shared/types';
import { fontString, titleFontsReady } from './fonts';
import { layoutTitle, type FrameSize, type LaidLine, type Measurer, type Rect, type TitleLayout } from './layout';
import { drawShape, type ShapeFrame } from './shapes';
import { MOTION_MARGIN_EMS, SPREAD, typedCount, unitOf, unitStateAt, wholeStateAt, type MotionUnit, type TextMotion } from './textMotion';

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
 *
 * During an entrance or exit that brings the letters on one at a time
 * (text/textMotion.ts) the title is drawn piece by piece - each letter, word
 * or line where layout put it, measured from the start of its line so the
 * kerning holds - with that frame's opacity, offset and size for each.
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

/**
 * What a frame of a moving entrance may draw beyond the title at rest:
 * letters rising or dropping, a blur's spread, letters drawn apart.
 */
export function motionBounds(layout: TitleLayout): Rect {
  const { bounds, block } = layout;
  const largest = Math.max(layout.firstSize, ...layout.lines.map((line) => line.size));
  const y = Math.ceil(largest * MOTION_MARGIN_EMS);
  const x = Math.ceil(y + (block.width / 2) * SPREAD);
  return { x: bounds.x - x, y: bounds.y - y, width: bounds.width + x * 2, height: bounds.height + y * 2 };
}

/* The pieces a moving title is drawn in -------------------------------------------- */

/** A letter, word or line where layout put it, in project pixels. */
interface Piece {
  text: string;
  x: number;
  width: number;
  line: LaidLine;
  /** Its place among all the pieces, in reading order. */
  index: number;
}

let graphemeSegmenter: Intl.Segmenter | null = null;

function piecesOf(layout: TitleLayout, unit: MotionUnit, measure: Measurer): Piece[] {
  const pieces: Piece[] = [];
  for (const line of layout.lines) {
    if (line.text === '') continue;
    if (unit === 'line' || unit === 'whole') {
      pieces.push({ text: line.text, x: line.x, width: line.width, line, index: pieces.length });
      continue;
    }
    const parts: Array<{ text: string; at: number }> = [];
    if (unit === 'word') {
      for (const match of line.text.matchAll(/\S+/g)) parts.push({ text: match[0], at: match.index ?? 0 });
    } else {
      graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      for (const { segment, index } of graphemeSegmenter.segment(line.text)) if (!/^\s+$/.test(segment)) parts.push({ text: segment, at: index });
    }
    for (const part of parts) {
      // From the start of the line, so each piece lands where the whole line would put it.
      const before = line.text.slice(0, part.at);
      const x = line.x + (before === '' ? 0 : measure.width(before, line.size, line.spacing) + line.spacing);
      pieces.push({ text: part.text, x, width: measure.width(part.text, line.size, line.spacing), line, index: pieces.length });
    }
  }
  return pieces;
}

/** A title's moving layout and pieces, kept per title object for the frames of one entrance. */
const moving = new WeakMap<TitleContent, { key: string; layout: TitleLayout; scale: number; pieces: Piece[] }>();

/* Drawing --------------------------------------------------------------------------- */

/**
 * Draw a title - at rest, or as it stands in one frame of `motion`. The
 * canvas is shared and reused: upload it before the next call.
 */
export function rasterizeTitle(title: TitleContent, frame: FrameSize, largestClipScale = 1, motion: TextMotion | null = null): TitleRaster {
  let layout: TitleLayout;
  let scale: number;
  let pieces: Piece[] = [];
  let bounds: Rect;
  if (motion) {
    const unit = unitOf(motion.kind);
    const key = `${frame.width}x${frame.height}@${largestClipScale}|${unit}|${titleFontsReady(title) ? 1 : 0}`;
    let known = moving.get(title);
    if (known?.key !== key) {
      const first = layoutTitle(title, frame, canvasMeasurer(title, 1));
      const chosen = rasterScale({ ...first, bounds: motionBounds(first) }, largestClipScale);
      const measure = canvasMeasurer(title, chosen);
      const laid = chosen === 1 ? first : layoutTitle(title, frame, measure);
      known = { key, layout: laid, scale: chosen, pieces: piecesOf(laid, unit, measure) };
      moving.set(title, known);
    }
    ({ layout, scale, pieces } = known);
    bounds = motionBounds(layout);
  } else {
    // Laid out once at 1:1 to learn the size, then at the scale it is drawn.
    const first = layoutTitle(title, frame, canvasMeasurer(title, 1));
    scale = rasterScale(first, largestClipScale);
    layout = scale === 1 ? first : layoutTitle(title, frame, canvasMeasurer(title, scale));
    bounds = layout.bounds;
  }

  scratch ??= document.createElement('canvas');
  const canvas = scratch;
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas2D is unavailable');

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.filter = 'none';
  context.clearRect(0, 0, width, height);
  paintTitle(context, title, layout, (x) => (x - bounds.x) * scale, (y) => (y - bounds.y) * scale, scale, motion, pieces);

  return {
    canvas,
    rect: { x: bounds.x, y: bounds.y, width: width / scale, height: height / scale },
    scale,
    layout,
  };
}

/** The shape's frame of reference in a layout. */
export const shapeFrameOf = (layout: TitleLayout, title: TitleContent): ShapeFrame => ({
  content: layout.content,
  block: layout.block,
  safe: layout.safe,
  firstSize: layout.firstSize,
  firstBaseline: layout.lines[0]?.baseline ?? layout.block.y + layout.firstSize,
  leadX: layout.content.x + (title.style.box.enabled ? title.style.box.padding * layout.unit : 0),
});

/**
 * Everything a title draws, in order: a band behind it all, the background,
 * the shape, then the letters - outline under fill, the shadow cast by the
 * lowest layer. A title without the library's extras draws exactly the
 * calls it always did.
 */
function paintTitle(
  context: CanvasRenderingContext2D,
  title: TitleContent,
  layout: TitleLayout,
  toX: (x: number) => number,
  toY: (y: number) => number,
  scale: number,
  motion: TextMotion | null,
  pieces: readonly Piece[],
): void {
  const { style } = title;
  const unit = layout.unit * scale;
  const whole = motion ? wholeStateAt(motion) : null;
  const shapes = whole ? whole.shapes : 1;
  const shapeFrame = style.shape ? shapeFrameOf(layout, title) : null;

  if (shapeFrame && style.shape?.kind === 'band') drawShape(context, style, shapeFrame, layout.unit, toX, toY, scale, shapes);

  if (layout.box && shapes > 0) {
    context.globalAlpha = shapes;
    context.fillStyle = rgba(style.box.color, style.box.opacity);
    context.beginPath();
    context.roundRect(toX(layout.box.x), toY(layout.box.y), layout.box.width * scale, layout.box.height * scale, style.box.radius * unit);
    context.fill();
    context.globalAlpha = 1;
  }

  if (shapeFrame && style.shape?.kind !== 'band') drawShape(context, style, shapeFrame, layout.unit, toX, toY, scale, shapes);

  /** The colour of a line: the accent for the lines after the first, a shade down the first. */
  const fillFor = (line: LaidLine): string | CanvasGradient => {
    if (line.paragraph > 0 && style.secondaryColor) return style.secondaryColor;
    if (line.paragraph === 0 && style.gradientColor) {
      const gradient = context.createLinearGradient(0, toY(line.baseline - line.size * 0.8), 0, toY(line.baseline + line.size * 0.15));
      gradient.addColorStop(0, style.color);
      gradient.addColorStop(1, style.gradientColor);
      return gradient;
    }
    return style.color;
  };

  const setFont = (line: LaidLine): void => {
    context.font = fontString(style.fontFamily, style.fontWeight, line.size * scale);
    context.letterSpacing = `${line.spacing * scale}px`;
    context.fontKerning = 'normal';
  };

  const unitKind: MotionUnit = motion ? unitOf(motion.kind) : 'whole';
  const count = pieces.length;
  const spread = whole?.spread ?? 1;

  /** Run `draw` for every line, or - while the letters move - for every piece as it stands. */
  const eachText = (draw: (text: string, x: number, y: number, line: LaidLine) => void): void => {
    if (!motion || unitKind === 'whole') {
      for (const line of layout.lines) {
        if (line.text === '') continue;
        setFont(line);
        draw(line.text, toX(line.x), toY(line.baseline), line);
      }
      return;
    }
    for (const piece of pieces) {
      const state = unitStateAt(motion, piece.index, count);
      if (state.opacity <= 0) continue;
      const { line } = piece;
      setFont(line);
      context.save();
      context.globalAlpha = state.opacity;
      let x = piece.x;
      if (spread !== 1) x += (piece.x + piece.width / 2 - (line.x + line.width / 2)) * (spread - 1);
      let y = line.baseline;
      if (unitKind === 'line') {
        // Up from behind the line's own edge: what is outside its band is not drawn.
        context.beginPath();
        context.rect(0, toY(line.baseline - line.size * 1.05), context.canvas.width, line.size * 1.45 * scale);
        context.clip();
        y += state.dy * line.size * style.lineHeight;
      } else {
        x += state.dx * line.size;
        y += state.dy * line.size;
      }
      if (state.scale !== 1) {
        const cx = toX(x + piece.width / 2);
        const cy = toY(y - line.size * 0.36);
        context.translate(cx, cy);
        context.scale(state.scale, state.scale);
        context.translate(-cx, -cy);
      }
      draw(piece.text, toX(x), toY(y), line);
      context.restore();
    }
  };

  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.direction = 'ltr';
  if (whole && motion) {
    // The whole text softens, fades or draws apart: one state for every letter.
    if (whole.blur > 0) context.filter = `blur(${whole.blur * layout.firstSize * scale}px)`;
    if (motion.kind === 'blur' || motion.kind === 'tracking') context.globalAlpha = unitStateAt(motion, 0, 1).opacity;
  }

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
    eachText((text, x, y) => context.strokeText(text, x, y));
    noShadow();
  } else {
    castShadow();
  }
  eachText((text, x, y, line) => {
    context.fillStyle = fillFor(line);
    context.fillText(text, x, y);
  });
  noShadow();
  context.filter = 'none';
  context.globalAlpha = 1;

  // Typewriter's caret, just after the last letter typed.
  if (whole?.caret && motion && count > 0) {
    const typed = typedCount(motion, count);
    const after = typed > 0 ? pieces[typed - 1] : null;
    const line = (after ?? pieces[0]).line;
    const x = after ? after.x + after.width + line.spacing + line.size * 0.04 : pieces[0].x;
    context.fillStyle = style.color;
    context.fillRect(toX(x), toY(line.baseline - line.size * 0.78), Math.max(1, line.size * 0.07 * scale), line.size * 0.92 * scale);
  }
}
