import type { TitleShape, TitleShapeKind, TitleStyle } from '@shared/types';
import type { Rect } from './layout';

/**
 * The shapes a title can carry - accent bars, rules, frames, a speech
 * bubble's point, and a few marks and icons - drawn with Canvas2D paths in
 * the same picture as the text, so they move, fade and scale with it and
 * come out at the export's resolution.
 *
 * Every shape here is drawn from scratch for this app: plain geometric
 * forms (a triangle in a circle, a bell, a heart, a map pin, a star), not
 * any product's logo or a commercial editor's artwork.
 *
 * Lengths are in project pixels; `unit` is project pixels per 1080-line
 * pixel, as in layout.ts.
 */

/** Marks drawn before the first line, in a square as tall as its letters. */
const MARKS: ReadonlySet<TitleShapeKind> = new Set<TitleShapeKind>(['arrow', 'dot', 'play', 'bell', 'heart', 'pin', 'star']);

export const isMark = (kind: TitleShapeKind): boolean => MARKS.has(kind);

/** Room a shape takes round the text, in project pixels: before it, and on each side of its background. */
export interface ShapeRoom {
  /** Between the background's left edge (or the text's, with none) and the text. */
  lead: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_ROOM: ShapeRoom = { lead: 0, top: 0, right: 0, bottom: 0, left: 0 };

/** The width of a mark, as a share of the first line's size. */
const MARK_EMS: Partial<Record<TitleShapeKind, number>> = { arrow: 1.1, dot: 0.45 };
const markWidth = (kind: TitleShapeKind, size: number): number => (MARK_EMS[kind] ?? 1) * size;
/** The space between a mark and the text, as a share of the first line's size. */
const MARK_GAP = 0.35;

/** How much room `shape` needs round a title whose first line is `firstSize` px. */
export function shapeRoom(style: TitleStyle, unit: number, firstSize: number): ShapeRoom {
  const shape = style.shape;
  if (!shape) return NO_ROOM;
  const thick = Math.max(0, shape.size) * unit;
  const boxed = style.box.enabled;
  switch (shape.kind) {
    case 'bar':
      // With a background, a stripe down its left edge; without, a bar with a gap before the text.
      return { ...NO_ROOM, lead: boxed ? thick : thick + Math.max(thick, firstSize * 0.3) };
    case 'underline':
      return { ...NO_ROOM, bottom: (boxed ? 0 : firstSize * 0.12) + thick };
    case 'rules': {
      const gap = firstSize * 0.25 + thick;
      return { ...NO_ROOM, top: gap, bottom: gap };
    }
    case 'brackets':
    case 'frame': {
      const gap = firstSize * 0.25 + thick;
      return { lead: 0, top: gap, right: gap, bottom: gap, left: gap };
    }
    case 'tail':
      return { ...NO_ROOM, bottom: firstSize * 0.45 };
    case 'band':
      return NO_ROOM;
    default:
      return { ...NO_ROOM, lead: markWidth(shape.kind, firstSize) + firstSize * MARK_GAP };
  }
}

/** What the shape is drawn against, in project pixels. */
export interface ShapeFrame {
  /** The background's rect, drawn or not: the text and its padding, with the lead. */
  content: Rect;
  /** The lines of text, without padding or lead. */
  block: Rect;
  /** The title-safe area, which a band spans. */
  safe: Rect;
  /** The first line's size and baseline: marks sit on it. */
  firstSize: number;
  firstBaseline: number;
  /** Where the lead begins: the mark is drawn from here. */
  leadX: number;
}

/** The rect a shape may ink, in project pixels: room for it in the picture (render.ts). */
export function shapeInk(shape: TitleShape | undefined, frame: ShapeFrame, unit: number): Rect | null {
  if (!shape) return null;
  const thick = shape.size * unit;
  const { content } = frame;
  if (shape.kind === 'band') {
    return { x: frame.safe.x - 2, y: content.y - 2, width: frame.safe.width + 4, height: content.height + 4 };
  }
  // Everything else lies inside the room layout gave it, plus the line's own half width.
  const reach = thick + frame.firstSize * 0.6 + 2;
  return { x: content.x - reach, y: content.y - reach, width: content.width + reach * 2, height: content.height + reach * 2 };
}

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

/**
 * Draw `style.shape` onto a canvas whose project-to-canvas mapping is `toX`,
 * `toY` and `scale`. `progress` (0..1) grows it on with an entrance that
 * redraws the letters: lines draw out from their middle or start, the rest
 * fade and grow. 1 draws it whole.
 */
export function drawShape(
  context: CanvasRenderingContext2D,
  style: TitleStyle,
  frame: ShapeFrame,
  unit: number,
  toX: (x: number) => number,
  toY: (y: number) => number,
  scale: number,
  progress = 1,
): void {
  const shape = style.shape;
  if (!shape || progress <= 0) return;
  const p = Math.min(1, progress);
  const thick = Math.max(0, shape.size) * unit;
  const { content, block, safe, firstSize } = frame;
  context.save();
  context.fillStyle = shape.color;
  context.strokeStyle = shape.color;
  context.lineJoin = 'round';
  context.lineCap = 'butt';
  const rect = (x: number, y: number, width: number, height: number): void => {
    if (width <= 0 || height <= 0) return;
    context.fillRect(toX(x), toY(y), width * scale, height * scale);
  };

  switch (shape.kind) {
    case 'bar': {
      // Grows from its middle, top and bottom at once.
      const height = (style.box.enabled ? content.height : block.height) * p;
      const top = (style.box.enabled ? content.y + content.height / 2 : block.y + block.height / 2) - height / 2;
      rect(content.x, top, thick, height);
      break;
    }
    case 'underline': {
      const y = style.box.enabled ? content.y + content.height : block.y + block.height + firstSize * 0.12;
      const from = style.box.enabled ? content : block;
      // Draws out from the text's own side.
      const width = from.width * p;
      const x = style.align === 'right' ? from.x + from.width - width : style.align === 'center' ? from.x + (from.width - width) / 2 : from.x;
      rect(x, y, width, thick);
      break;
    }
    case 'rules': {
      const gap = firstSize * 0.25;
      const width = content.width * p;
      const x = content.x + (content.width - width) / 2;
      rect(x, content.y - gap - thick, width, thick);
      rect(x, content.y + content.height + gap, width, thick);
      break;
    }
    case 'frame':
    case 'brackets': {
      const gap = firstSize * 0.25;
      const x = content.x - gap - thick / 2;
      const y = content.y - gap - thick / 2;
      const width = content.width + (gap + thick / 2) * 2;
      const height = content.height + (gap + thick / 2) * 2;
      context.globalAlpha *= p;
      context.lineWidth = Math.max(0.5, thick * scale);
      context.lineCap = 'square';
      context.beginPath();
      if (shape.kind === 'frame') {
        context.rect(toX(x), toY(y), width * scale, height * scale);
      } else {
        // Corners only, their arms a third of the shorter side, closing in as they come on.
        const arm = Math.min(width, height) * 0.3 * (0.6 + 0.4 * p);
        const corner = (cx: number, cy: number, sx: number, sy: number): void => {
          context.moveTo(toX(cx + sx * arm), toY(cy));
          context.lineTo(toX(cx), toY(cy));
          context.lineTo(toX(cx), toY(cy + sy * arm));
        };
        corner(x, y, 1, 1);
        corner(x + width, y, -1, 1);
        corner(x, y + height, 1, -1);
        corner(x + width, y + height, -1, -1);
      }
      context.stroke();
      break;
    }
    case 'band': {
      // Sweeps across the title-safe width from the left.
      const alpha = style.box.enabled ? 1 : 0.85;
      context.fillStyle = rgba(shape.color, alpha);
      rect(safe.x, content.y, safe.width * p, content.height);
      break;
    }
    case 'tail': {
      // A speech bubble's point under the background, a fifth of the way in.
      const alpha = style.box.enabled ? style.box.opacity : 1;
      context.fillStyle = rgba(shape.color, alpha * p);
      const base = content.y + content.height;
      const x0 = content.x + Math.min(content.width * 0.2, firstSize * 1.2);
      const width = firstSize * 0.55;
      context.beginPath();
      context.moveTo(toX(x0), toY(base - 1));
      context.lineTo(toX(x0 + width), toY(base - 1));
      context.lineTo(toX(x0 - width * 0.15), toY(base + firstSize * 0.45));
      context.closePath();
      context.fill();
      break;
    }
    default:
      drawMark(context, shape, frame, toX, toY, scale, p);
      break;
  }
  context.restore();
}

/** A mark before the first line, in a square as tall as its capitals, centred on them. */
function drawMark(
  context: CanvasRenderingContext2D,
  shape: TitleShape,
  frame: ShapeFrame,
  toX: (x: number) => number,
  toY: (y: number) => number,
  scale: number,
  progress: number,
): void {
  const size = frame.firstSize;
  const width = markWidth(shape.kind, size);
  const middleY = frame.firstBaseline - size * 0.36;
  const cx = frame.leadX + width / 2;
  // Grows from its own middle as it comes on.
  context.translate(toX(cx), toY(middleY));
  context.scale(scale * progress, scale * progress);
  context.globalAlpha *= progress;
  const s = size;
  context.beginPath();
  switch (shape.kind) {
    case 'arrow': {
      // Pointing back, away from the text: at what the label names.
      const half = width / 2;
      const head = s * 0.42;
      const shaft = s * 0.16;
      context.moveTo(-half, 0);
      context.lineTo(-half + head, -head * 0.9);
      context.lineTo(-half + head, -shaft / 2);
      context.lineTo(half, -shaft / 2);
      context.lineTo(half, shaft / 2);
      context.lineTo(-half + head, shaft / 2);
      context.lineTo(-half + head, head * 0.9);
      context.closePath();
      context.fill();
      break;
    }
    case 'dot':
      context.arc(0, 0, s * 0.2, 0, Math.PI * 2);
      context.fill();
      break;
    case 'play': {
      // A disc with a triangle cut out of it.
      const r = s * 0.48;
      context.arc(0, 0, r, 0, Math.PI * 2);
      context.moveTo(-r * 0.3, -r * 0.42);
      context.lineTo(r * 0.45, 0);
      context.lineTo(-r * 0.3, r * 0.42);
      context.closePath();
      context.fill('evenodd');
      break;
    }
    case 'bell': {
      const r = s * 0.42;
      context.moveTo(-r, r * 0.55);
      context.quadraticCurveTo(-r * 0.75, r * 0.3, -r * 0.72, -r * 0.1);
      context.bezierCurveTo(-r * 0.7, -r * 0.85, r * 0.7, -r * 0.85, r * 0.72, -r * 0.1);
      context.quadraticCurveTo(r * 0.75, r * 0.3, r, r * 0.55);
      context.closePath();
      context.fill();
      context.beginPath();
      context.arc(0, r * 0.72, r * 0.2, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.arc(0, -r * 0.82, r * 0.12, 0, Math.PI * 2);
      context.fill();
      break;
    }
    case 'heart': {
      const r = s * 0.46;
      context.moveTo(0, r * 0.85);
      context.bezierCurveTo(-r * 1.2, 0, -r * 0.9, -r * 0.95, 0, -r * 0.4);
      context.bezierCurveTo(r * 0.9, -r * 0.95, r * 1.2, 0, 0, r * 0.85);
      context.closePath();
      context.fill();
      break;
    }
    case 'pin': {
      // A drop with a hole: the map pin.
      const r = s * 0.32;
      const top = -s * 0.2;
      context.arc(0, top, r, Math.PI * 0.85, Math.PI * 0.15);
      context.lineTo(0, s * 0.5);
      context.closePath();
      context.moveTo(r * 0.4, top);
      context.arc(0, top, r * 0.4, 0, Math.PI * 2);
      context.fill('evenodd');
      break;
    }
    case 'star':
    default: {
      const outer = s * 0.5;
      const inner = outer * 0.45;
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius + s * 0.04;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fill();
      break;
    }
  }
}
