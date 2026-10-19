import { describe, expect, it } from 'vitest';
import type { TitleContent, TitleStyle } from '@shared/types';
import { layoutTitle, type Measurer } from '@renderer/text/layout';
import { presetStyle, normalizeShape, normalizeTitleStyle, TITLE_SAFE } from '@renderer/text/titleStyle';

/**
 * The layout work the library needs: capitals, the fit that shrinks a title
 * until it is inside the safe area, and the room a shape takes - all measured
 * by arithmetic, no GPU.
 */

const hd = { width: 1920, height: 1080 };

// A monospace measurer: every glyph half the size wide, the line's height its size.
const mono: Measurer = {
  width: (text, size, spacing) => text.length * (size * 0.5 + spacing) - (text.length > 0 ? spacing : 0),
  metrics: (size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
};

const title = (text: string, patch: Partial<TitleStyle> = {}): TitleContent => ({
  preset: 'title',
  text,
  style: { ...presetStyle('title'), ...patch },
  origin: 'text',
});

describe('capitals', () => {
  it('lays out the text in capitals when the style asks, without changing the text', () => {
    const upper = layoutTitle(title('hola ñandú', { uppercase: true }), hd, mono);
    expect(upper.lines[0].text).toBe('HOLA ÑANDÚ');
  });
});

describe('fit', () => {
  it('shrinks a long title until the whole block is inside the safe area', () => {
    const long = 'palabra '.repeat(40).trim();
    const safeWidth = hd.width * TITLE_SAFE;
    const safeHeight = hd.height * TITLE_SAFE;
    const fitted = layoutTitle(title(long, { fit: true, maxWidth: 1, fontSize: 140 }), hd, mono);
    expect(fitted.outer.width).toBeLessThanOrEqual(safeWidth + 1);
    expect(fitted.outer.height).toBeLessThanOrEqual(safeHeight + 1);
    expect(fitted.fit).toBeLessThan(1);
  });

  it('leaves a title that already fits at full size', () => {
    const fitted = layoutTitle(title('Short', { fit: true }), hd, mono);
    expect(fitted.fit).toBeCloseTo(1, 6);
  });

  it('shrinks until a word too wide for its line no longer has to break', () => {
    // One very long word, with a narrow wrap width.
    const fitted = layoutTitle(title('Supercalifragilisticoexpialidoso', { fit: true, maxWidth: 0.3 }), hd, mono);
    expect(fitted.overflow.word).toBeLessThanOrEqual(1 + 1e-6);
    // It stayed on one line.
    expect(fitted.lines).toHaveLength(1);
  });
});

describe('a shape makes room', () => {
  it('an accent bar pushes the text right of the background edge', () => {
    const plain = layoutTitle(title('Name', { anchor: 'bottomLeft', align: 'left' }), hd, mono);
    const barred = layoutTitle(title('Name', { anchor: 'bottomLeft', align: 'left', shape: { kind: 'bar', color: '#ff8800', size: 8 } }), hd, mono);
    expect(barred.block.x).toBeGreaterThan(plain.block.x);
  });

  it('a frame reserves room all around, inside the bounds that are drawn', () => {
    const framed = layoutTitle(title('Label', { shape: { kind: 'frame', color: '#ffffff', size: 4 } }), hd, mono);
    expect(framed.outer.width).toBeGreaterThan(framed.block.width);
    expect(framed.bounds.x).toBeLessThanOrEqual(framed.outer.x);
  });
});

describe('normalizeShape', () => {
  it('reads a valid shape and drops a bad one', () => {
    expect(normalizeShape({ kind: 'bar', color: '#AABBCC', size: 7 })).toEqual({ kind: 'bar', color: '#aabbcc', size: 7 });
    expect(normalizeShape({ kind: 'not-a-shape', color: '#000000', size: 2 })).toBeNull();
    expect(normalizeShape({ kind: 'bar', color: 'red', size: 2 })).toBeNull();
    expect(normalizeShape(null)).toBeNull();
  });

  it('clamps the size', () => {
    expect(normalizeShape({ kind: 'bar', color: '#000000', size: 999 })?.size).toBe(60);
    expect(normalizeShape({ kind: 'bar', color: '#000000', size: -5 })?.size).toBe(0);
  });
});

describe('normalizeTitleStyle keeps the library fields only when valid', () => {
  it('keeps an accent colour, a gradient, capitals, fit and a shape', () => {
    const read = normalizeTitleStyle(
      {
        ...presetStyle('title'),
        secondaryColor: '#123ABC',
        gradientColor: '#FFEE00',
        uppercase: true,
        fit: true,
        shape: { kind: 'underline', color: '#00FF00', size: 3 },
      },
      'title',
    );
    expect(read.secondaryColor).toBe('#123abc');
    expect(read.gradientColor).toBe('#ffee00');
    expect(read.uppercase).toBe(true);
    expect(read.fit).toBe(true);
    expect(read.shape).toEqual({ kind: 'underline', color: '#00ff00', size: 3 });
  });

  it('leaves them absent on a title that has none, so an old title is unchanged', () => {
    const read = normalizeTitleStyle(presetStyle('title'), 'title');
    expect(read.secondaryColor).toBeUndefined();
    expect(read.gradientColor).toBeUndefined();
    expect(read.uppercase).toBeUndefined();
    expect(read.fit).toBeUndefined();
    expect(read.shape).toBeUndefined();
  });

  it('drops a damaged library field rather than guessing', () => {
    const read = normalizeTitleStyle({ ...presetStyle('title'), secondaryColor: 'blue', gradientColor: 42, shape: { kind: 'bogus' } }, 'title');
    expect(read.secondaryColor).toBeUndefined();
    expect(read.gradientColor).toBeUndefined();
    expect(read.shape).toBeUndefined();
  });
});
