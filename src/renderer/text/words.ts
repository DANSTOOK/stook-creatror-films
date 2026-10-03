import type { TitleContent } from '@shared/types';
import { fontString, titleFontsReady } from './fonts';
import { layoutTitle, type FrameSize, type LaidLine, type Measurer, type Rect, type TitleLayout } from './layout';
import { canvasMeasurer, rasterScale } from './render';
import { EMPHASIS, ENTER_FROM, SPRING_PEAK, type WordAnimation, type WordFrame } from './wordAnimation';

/**
 * Text drawn word by word: the picture of one moment of a WordAnimation.
 *
 * The same engine and the same order of work as a title's picture
 * (render.ts) - Canvas2D, laid out by layout.ts, the outline under the
 * letters, the shadow cast by the lowest layer - but each word is drawn on
 * its own, so one can be another colour, larger, half filled, or not there
 * yet.
 *
 * What costs is done once: a text is laid out, and every word measured,
 * when it is first drawn, and kept for as long as the title object lives.
 * A frame only draws - a couple of lines of text - and only when its
 * WordFrame is not the one already in the texture (engine/TitleLayers).
 */

/** A word where layout put it, in project pixels. */
export interface LaidWord {
  /** Which word of the text it is. */
  index: number;
  text: string;
  /** Left edge and width of its letters. */
  x: number;
  width: number;
  baseline: number;
  size: number;
  spacing: number;
  /** Which line of the page it is on. */
  line: number;
}

/** One page of words, laid out. */
export interface WordPageLayout {
  layout: TitleLayout;
  words: LaidWord[];
  /** Everything a frame of this page may draw, in whole project pixels. */
  bounds: Rect;
}

/** The words of each line, with where they are across it. */
export function laidWords(lines: readonly LaidLine[], firstIndex: number, tokens: readonly string[], measure: Measurer): LaidWord[] {
  const words: LaidWord[] = [];
  let token = firstIndex;
  // A word wider than its line is broken across lines: its pieces are one word.
  let taken = 0;
  lines.forEach((line, lineIndex) => {
    const pieces = /\S+/g;
    for (let match = pieces.exec(line.text); match; match = pieces.exec(line.text)) {
      const before = line.text.slice(0, match.index);
      const x = line.x + (before === '' ? 0 : measure.width(before, line.size, line.spacing) + line.spacing);
      words.push({
        index: Math.min(token, firstIndex + tokens.length - 1),
        text: match[0],
        x,
        width: measure.width(match[0], line.size, line.spacing),
        baseline: line.baseline,
        size: line.size,
        spacing: line.spacing,
        line: lineIndex,
      });
      taken += match[0].length;
      if (taken >= (tokens[token - firstIndex]?.length ?? 0)) {
        token += 1;
        taken = 0;
      }
    }
  });
  return words;
}

/** Lay out every page of an animated text. */
export function layoutWordPages(title: TitleContent, animation: WordAnimation, frame: FrameSize, measure: Measurer): WordPageLayout[] {
  const tokens = title.text.split(/\s+/).filter((token) => token !== '');
  const single = animation.pages.length <= 1;
  return animation.pages.map((page) => {
    const pageTokens = tokens.slice(page.first, page.last + 1);
    // All of it keeps its own lines; a few words at a time are a line of their own.
    const pageTitle = single ? title : { ...title, text: pageTokens.join(' ') };
    const layout = layoutTitle(pageTitle, frame, measure);
    const words = laidWords(layout.lines, page.first, pageTokens, measure);
    const widest = Math.max(0, ...words.map((word) => word.width));
    const largest = Math.max(0, ...words.map((word) => word.size));
    // Room for a word at the top of its spring, and for the box behind it.
    const growth = (1 + EMPHASIS * SPRING_PEAK) * SPRING_PEAK - 1;
    const sideways = Math.ceil((widest * growth) / 2 + largest * BOX_PAD_X * SPRING_PEAK + 2);
    const upDown = Math.ceil(largest * (growth / 2 + BOX_PAD_Y) + 2);
    const { bounds } = layout;
    return {
      layout,
      words,
      bounds: { x: bounds.x - sideways, y: bounds.y - upDown, width: bounds.width + sideways * 2, height: bounds.height + upDown * 2 },
    };
  });
}

/** The box behind a word: how far it reaches past the letters, as a share of their size. */
const BOX_PAD_X = 0.22;
const BOX_PAD_Y = 0.06;
const BOX_RADIUS = 0.18;
/** A line's letters, roughly: how far above and below the baseline, as a share of the size. */
const ASCENT = 0.82;
const DESCENT = 0.24;
/** A word turns about the middle of its letters, which is this far above its baseline. */
const MIDDLE = (ASCENT - DESCENT) / 2;

function boxOf(word: LaidWord): Rect {
  return {
    x: word.x - word.size * BOX_PAD_X,
    y: word.baseline - word.size * (ASCENT + BOX_PAD_Y),
    width: word.width + word.size * BOX_PAD_X * 2,
    height: word.size * (ASCENT + DESCENT + BOX_PAD_Y * 2),
  };
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A title's pages, by frame size, raster scale and whether its fonts were there: a handful at most. */
const layouts = new WeakMap<TitleContent, Map<string, WordPageLayout[]>>();

/** The pages of an animated title at a raster scale: laid out once, and again when its fonts arrive. */
export function wordPagesFor(title: TitleContent, animation: WordAnimation, frame: FrameSize, scale: number): WordPageLayout[] {
  const key = `${frame.width}x${frame.height}@${scale}|${titleFontsReady(title) ? 1 : 0}|${animation.pages.map((page) => page.last).join(',')}`;
  let known = layouts.get(title);
  if (!known) {
    known = new Map();
    layouts.set(title, known);
  }
  const kept = known.get(key);
  if (kept) return kept;
  // What was laid out with a fallback face, or for another size, is not wanted again.
  if (known.size >= 4) known.clear();
  const pages = layoutWordPages(title, animation, frame, canvasMeasurer(title, scale));
  known.set(key, pages);
  return pages;
}

export interface WordRaster {
  canvas: HTMLCanvasElement;
  /** Where the picture goes on the frame, in project pixels. */
  rect: Rect;
  scale: number;
  /** The page drawn; null for a text with no words. */
  page: WordPageLayout | null;
}

let scratch: HTMLCanvasElement | null = null;

const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

/** The raster scale for an animated title: the one its largest page needs. */
export function wordRasterScale(title: TitleContent, animation: WordAnimation, frame: FrameSize, largestClipScale: number): number {
  const pages = wordPagesFor(title, animation, frame, 1);
  let scale = Math.min(4, Math.max(1, largestClipScale));
  for (const page of pages) scale = Math.min(scale, rasterScale({ ...page.layout, bounds: page.bounds }, largestClipScale));
  return scale;
}

/**
 * Draw one moment of an animated title. The canvas is shared and reused:
 * upload it before the next call.
 */
export function rasterizeWords(title: TitleContent, animation: WordAnimation, state: WordFrame, frame: FrameSize, largestClipScale = 1): WordRaster {
  const scale = wordRasterScale(title, animation, frame, largestClipScale);
  const pages = wordPagesFor(title, animation, frame, scale);
  scratch ??= document.createElement('canvas');
  const canvas = scratch;
  const page = pages[Math.min(state.page, pages.length - 1)];
  if (!page) {
    // No words: a picture of nothing.
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d')?.clearRect(0, 0, 1, 1);
    return { canvas, rect: { x: 0, y: 0, width: 1, height: 1 }, scale, page: null };
  }
  const { bounds, layout } = page;
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas2D is unavailable');

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.clearRect(0, 0, width, height);
  const toX = (x: number): number => (x - bounds.x) * scale;
  const toY = (y: number): number => (y - bounds.y) * scale;
  const { style } = title;
  const unit = layout.unit * scale;
  const raster: WordRaster = { canvas, rect: { x: bounds.x, y: bounds.y, width: width / scale, height: height / scale }, scale, page };

  // The band behind all of the text, as a title's.
  if (layout.box) {
    context.fillStyle = rgba(style.box.color, style.box.opacity);
    context.beginPath();
    context.roundRect(toX(layout.box.x), toY(layout.box.y), layout.box.width * scale, layout.box.height * scale, style.box.radius * unit);
    context.fill();
  }

  // The box behind the word being said.
  if (state.box) {
    const to = page.words.find((word) => word.index === state.box?.to);
    const from = state.box.from === null ? undefined : page.words.find((word) => word.index === state.box?.from);
    if (to) {
      const target = boxOf(to);
      let rect = target;
      let opacity = state.box.opacity;
      if (from && from.line === to.line) {
        // Along its line it glides from the word before.
        const start = boxOf(from);
        const t = state.box.progress;
        rect = { x: mix(start.x, target.x, t), y: target.y, width: Math.max(1, mix(start.width, target.width, t)), height: target.height };
        opacity = 1;
      } else if (state.box.from !== null || state.box.opacity < 1 || state.box.progress !== 1) {
        // On a new line, or on the first word, it comes on in place.
        const k = ENTER_FROM + (1 - ENTER_FROM) * state.box.progress;
        rect = { x: target.x + (target.width * (1 - k)) / 2, y: target.y + (target.height * (1 - k)) / 2, width: target.width * k, height: target.height * k };
        opacity = Math.min(1, Math.max(0, Math.min(1, state.box.progress * 2)));
      }
      context.globalAlpha = opacity;
      context.fillStyle = animation.color;
      context.beginPath();
      context.roundRect(toX(rect.x), toY(rect.y), rect.width * scale, rect.height * scale, to.size * BOX_RADIUS * scale);
      context.fill();
      context.globalAlpha = 1;
    }
  }

  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.direction = 'ltr';
  context.fontKerning = 'normal';

  /** Run `draw` for each word on screen, with the canvas turned to that word's size about its middle. */
  const eachWord = (draw: (word: LaidWord, fill: number) => void): void => {
    for (const word of page.words) {
      const standing = state.words[word.index];
      if (!standing || !standing.visible || standing.opacity <= 0) continue;
      context.font = fontString(style.fontFamily, style.fontWeight, word.size * scale);
      context.letterSpacing = `${word.spacing * scale}px`;
      context.save();
      context.globalAlpha = standing.opacity;
      const cx = toX(word.x + word.width / 2);
      const cy = toY(word.baseline - word.size * MIDDLE);
      context.translate(cx, cy);
      context.scale(standing.scale, standing.scale);
      context.translate(-cx, -cy);
      draw(word, standing.fill);
      context.restore();
    }
  };

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

  // Outlines first, all of them, so no word's outline covers its neighbour's letters.
  const stroked = style.stroke.enabled && style.stroke.width > 0;
  if (stroked) {
    castShadow();
    context.strokeStyle = style.stroke.color;
    context.lineWidth = style.stroke.width * unit * 2;
    context.lineJoin = 'round';
    context.miterLimit = 2;
    eachWord((word) => context.strokeText(word.text, toX(word.x), toY(word.baseline)));
    noShadow();
  } else {
    castShadow();
  }

  eachWord((word, fill) => {
    const x = toX(word.x);
    const y = toY(word.baseline);
    if (fill < 1) {
      context.fillStyle = style.color;
      context.fillText(word.text, x, y);
    }
    if (fill <= 0) return;
    // The colour, over the letters - all of them, or as far from the left as it has got.
    if (fill < 1) {
      noShadow();
      context.beginPath();
      context.rect(x - word.size * scale, y - word.size * scale * 2, word.size * scale + word.width * scale * fill, word.size * scale * 4);
      context.clip();
    }
    context.fillStyle = animation.color;
    context.fillText(word.text, x, y);
  });
  noShadow();

  return raster;
}
