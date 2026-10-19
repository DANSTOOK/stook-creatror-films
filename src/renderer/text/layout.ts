import type { TitleContent, TitleStyle } from '@shared/types';
import { REFERENCE_HEIGHT, TITLE_SAFE } from './titleStyle';
import { shapeInk, shapeRoom } from './shapes';

/**
 * Where every line of a title goes, in project pixels.
 *
 * Pure: the measuring is handed in, so the same code places text for the
 * compositor (measured by Canvas2D, which shapes, kerns and falls back to
 * system fonts for scripts and emoji the chosen family lacks) and for the
 * unit tests (measured by arithmetic). Subtitles will lay out through here
 * too.
 *
 * Canvas2D has no line breaking, so wrapping is done here: at the break
 * opportunities Intl.Segmenter finds between words - which also knows where
 * words end in scripts written without spaces - and inside a word only when
 * the word alone is wider than the line.
 */

export interface FrameSize {
  width: number;
  height: number;
}

/** Width of `text` at `size` px with `spacing` px between letters. */
export type MeasureWidth = (text: string, size: number, spacing: number) => number;
/** Height above and below the baseline that a line at `size` px reserves. */
export type MeasureMetrics = (size: number) => { ascent: number; descent: number };

export interface Measurer {
  width: MeasureWidth;
  metrics: MeasureMetrics;
}

export interface LaidLine {
  text: string;
  /** Font size of this line, project px. */
  size: number;
  /** Letter spacing of this line, project px. */
  spacing: number;
  /** Left edge of the line's text, project px. */
  x: number;
  /** Baseline, project px from the top of the frame. */
  baseline: number;
  width: number;
  /** Which paragraph of the text it comes from: 0 is the first line as typed. */
  paragraph: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TitleLayout {
  lines: LaidLine[];
  /** The text block (lines only), project px. */
  block: Rect;
  /** The background box, when there is one. */
  box: Rect | null;
  /** Everything that may be drawn - box, stroke, shadow, overhanging ink - in whole pixels. */
  bounds: Rect;
  /**
   * Project px per 1080-line px - times the factor a fitted title was shrunk
   * by, so whatever is drawn by the unit shrinks with it.
   */
  unit: number;
  /** The background's rect whether it is drawn or not: the lines, their padding and a mark's lead. */
  content: Rect;
  /** The content with room for its shape round it: what is pinned to the title-safe area. */
  outer: Rect;
  safe: Rect;
  /** The first line's size, project px. */
  firstSize: number;
  /** What a fitted title was shrunk by: 1 when it was not. */
  fit: number;
  /** The widest word as a share of the line it must fit: over 1 is a word broken in two. */
  overflow: { word: number };
}

let wordSegmenter: Intl.Segmenter | null = null;
let graphemeSegmenter: Intl.Segmenter | null = null;

const words = (text: string): string[] => {
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  const pieces: string[] = [];
  for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
    const space = /^\s+$/.test(segment);
    const last = pieces[pieces.length - 1];
    // Punctuation stays with the word before it, so a line never starts with a comma.
    if (!isWordLike && !space && last !== undefined && !/^\s+$/.test(last)) pieces[pieces.length - 1] = last + segment;
    else pieces.push(segment);
  }
  return pieces;
};

const graphemes = (text: string): string[] => {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...graphemeSegmenter.segment(text)].map((piece) => piece.segment);
};

const isSpace = (text: string): boolean => /^\s+$/.test(text);

/**
 * One paragraph into lines no wider than `maxWidth`, greedily - which is what
 * a title wants: the lines read as they were typed, only broken where they
 * must be.
 */
export function wrapParagraph(paragraph: string, maxWidth: number, width: (text: string) => number): string[] {
  if (paragraph.trim() === '') return [''];
  if (width(paragraph.trimEnd()) <= maxWidth) return [paragraph.trimEnd()];

  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') lines.push(current.trimEnd());
    current = '';
  };

  for (const piece of words(paragraph)) {
    if (current === '' && isSpace(piece)) continue;
    const candidate = current + piece;
    if (width(candidate.trimEnd()) <= maxWidth) {
      current = candidate;
      continue;
    }
    flush();
    if (isSpace(piece)) continue;
    if (width(piece) <= maxWidth) {
      current = piece;
      continue;
    }
    // A word wider than the line on its own: break it between characters.
    for (const grapheme of graphemes(piece)) {
      if (current !== '' && width(current + grapheme) > maxWidth) flush();
      current += grapheme;
    }
  }
  flush();
  return lines.length > 0 ? lines : [''];
}

/** The font size of a paragraph: the first at full size, the rest scaled. */
const paragraphSize = (style: TitleStyle, unit: number, index: number): number =>
  style.fontSize * unit * (index === 0 ? 1 : style.secondaryScale);

/** The text as it is drawn: in capitals when the style asks, however it was typed. */
export const displayText = (title: TitleContent): string => (title.style.uppercase ? title.text.toUpperCase() : title.text);

/** The title-safe area of a frame. */
export function safeArea(frame: FrameSize): Rect {
  return {
    x: (frame.width * (1 - TITLE_SAFE)) / 2,
    y: (frame.height * (1 - TITLE_SAFE)) / 2,
    width: frame.width * TITLE_SAFE,
    height: frame.height * TITLE_SAFE,
  };
}

/** How many times a fitted title is laid out again, smaller, at most. */
const FIT_PASSES = 8;
/** The smallest a fitted title is made: a fifth of its size. */
const FIT_FLOOR = 0.2;

/**
 * Lay a title out on a frame of this size.
 *
 * A title whose style asks to fit is laid out again, smaller, while a word
 * of it is wider than a line or the whole is larger than the title-safe
 * area - so a long Spanish word typed into a template is never broken in
 * two, and nothing leaves the safe area. Everything shrinks together: the
 * layout's unit carries the factor, and every length is drawn by the unit.
 */
export function layoutTitle(title: TitleContent, frame: FrameSize, measure: Measurer): TitleLayout {
  let layout = layoutOnce(title, frame, measure, 1);
  if (!title.style.fit) return layout;
  let factor = 1;
  for (let pass = 0; pass < FIT_PASSES; pass += 1) {
    const over = Math.max(
      layout.overflow.word,
      layout.outer.width / layout.safe.width,
      layout.outer.height / layout.safe.height,
    );
    if (over <= 1 + 1e-6 || factor <= FIT_FLOOR) break;
    // A little under the ratio: wrapping is not linear in the size.
    factor = Math.max(FIT_FLOOR, (factor / over) * 0.985);
    layout = layoutOnce(title, frame, measure, factor);
  }
  return layout;
}

function layoutOnce(title: TitleContent, frame: FrameSize, measure: Measurer, factor: number): TitleLayout {
  const { style } = title;
  const unit = (frame.height / REFERENCE_HEIGHT) * factor;
  const safe = safeArea(frame);
  const padding = style.box.enabled ? style.box.padding * unit : 0;
  const firstSize = paragraphSize(style, unit, 0);
  const room = shapeRoom(style, unit, firstSize);
  const wrapWidth = Math.max(1, safe.width * style.maxWidth - padding * 2 - room.lead - room.left - room.right);

  // Lines, relative to the top-left of the block for now.
  const lines: LaidLine[] = [];
  let top = 0;
  let widestWord = 0;
  displayText(title)
    .split(/\r?\n/)
    .forEach((paragraph, index) => {
      const size = paragraphSize(style, unit, index);
      const spacing = (style.letterSpacing / 100) * size;
      const { ascent, descent } = measure.metrics(size);
      const advance = size * style.lineHeight;
      const width = (candidate: string): number => measure.width(candidate, size, spacing);
      if (style.fit) for (const word of paragraph.split(/\s+/)) if (word !== '') widestWord = Math.max(widestWord, width(word) / wrapWidth);
      for (const text of wrapParagraph(paragraph, wrapWidth, width)) {
        // The glyphs sit in the middle of the line's height, however tall the
        // line spacing makes it, so the block's padding looks even top and bottom.
        const baseline = top + (advance - (ascent + descent)) / 2 + ascent;
        lines.push({ text, size, spacing, x: 0, baseline, width: text === '' ? 0 : width(text), paragraph: index });
        top += advance;
      }
    });

  const blockWidth = Math.max(0, ...lines.map((line) => line.width));
  const blockHeight = top;

  // The background's rect (drawn or not), and round it the shape's room:
  // that whole is what is pinned to a point of the safe area.
  const contentWidth = room.lead + blockWidth + padding * 2;
  const contentHeight = blockHeight + padding * 2;
  const outerWidth = room.left + contentWidth + room.right;
  const outerHeight = room.top + contentHeight + room.bottom;
  const horizontal = style.anchor.endsWith('Left') || style.anchor === 'left'
    ? 'start'
    : style.anchor.endsWith('Right') || style.anchor === 'right'
      ? 'end'
      : 'middle';
  const vertical = style.anchor.startsWith('top') ? 'start' : style.anchor.startsWith('bottom') ? 'end' : 'middle';
  const place = (edge: 'start' | 'middle' | 'end', origin: number, space: number, size: number): number =>
    edge === 'start' ? origin : edge === 'end' ? origin + space - size : origin + (space - size) / 2;
  const outer: Rect = {
    x: place(horizontal, safe.x, safe.width, outerWidth),
    y: place(vertical, safe.y, safe.height, outerHeight),
    width: outerWidth,
    height: outerHeight,
  };
  const content: Rect = { x: outer.x + room.left, y: outer.y + room.top, width: contentWidth, height: contentHeight };
  const block: Rect = { x: content.x + padding + room.lead, y: content.y + padding, width: blockWidth, height: blockHeight };

  for (const line of lines) {
    const slack = blockWidth - line.width;
    line.x = block.x + (style.align === 'left' ? 0 : style.align === 'right' ? slack : slack / 2);
    line.baseline += block.y;
  }

  const box = style.box.enabled ? { ...content } : null;

  // Room for what is drawn outside the letters' boxes: the outline, the
  // shadow, and ink that overhangs its advance (italics, accents, swashes).
  const largest = Math.max(firstSize, ...lines.map((line) => line.size));
  const stroke = style.stroke.enabled ? style.stroke.width * unit : 0;
  const shadow = style.shadow.enabled ? (style.shadow.distance + style.shadow.blur * 2) * unit : 0;
  const margin = largest * 0.3 + stroke + shadow + 2;
  const inked = { x: block.x - margin, y: block.y - margin, right: block.x + blockWidth + margin, bottom: block.y + blockHeight + margin };
  const firstBaseline = lines[0]?.baseline ?? block.y + firstSize;
  const shape = shapeInk(style.shape, { content, block, safe, firstSize, firstBaseline, leadX: content.x + padding }, unit);
  const extras = [box, shape].filter((rect): rect is Rect => rect !== null);
  const left = Math.floor(Math.min(inked.x, ...extras.map((rect) => rect.x)));
  const topEdge = Math.floor(Math.min(inked.y, ...extras.map((rect) => rect.y)));
  const right = Math.ceil(Math.max(inked.right, ...extras.map((rect) => rect.x + rect.width)));
  const bottom = Math.ceil(Math.max(inked.bottom, ...extras.map((rect) => rect.y + rect.height)));

  return {
    lines,
    block,
    box,
    content,
    outer,
    safe,
    firstSize,
    fit: factor,
    overflow: { word: widestWord },
    bounds: { x: left, y: topEdge, width: Math.max(1, right - left), height: Math.max(1, bottom - topEdge) },
    unit,
  };
}
