import { describe, expect, it } from 'vitest';
import { placedWords, type LaidWord } from '@renderer/text/words';

const word = (index: number, x: number, width: number, line = 0): LaidWord => ({ index, text: `w${index}`, x, width, baseline: 100, size: 96, spacing: 0, line });
const standing = (scale: number) => ({ visible: true, fill: 0, scale, opacity: 1 });

describe('the words of a line step aside for the one said larger', () => {
  const line = [word(0, 0, 200), word(1, 230, 400), word(2, 660, 100)];

  it('moves nothing while every word is its size', () => {
    expect(placedWords(line, { words: [standing(1), standing(1), standing(1)] }).size).toBe(0);
  });

  it('keeps the spaces as wide as laid out: those before go left, those after go right, by what it grows', () => {
    const shifts = placedWords(line, { words: [standing(1), standing(1.12), standing(1)] });
    const grows = (0.12 * 400) / 2;
    expect(shifts.get(line[0])).toBeCloseTo(-grows);
    expect(shifts.get(line[1])).toBeCloseTo(0);
    expect(shifts.get(line[2])).toBeCloseTo(grows);
    // The gap from the grown word's right edge to the next word's left edge is the one layout made.
    const rightEdge = line[1].x + line[1].width / 2 + (1.12 * line[1].width) / 2;
    expect(line[2].x + (shifts.get(line[2]) ?? 0) - rightEdge).toBeCloseTo(line[2].x - (line[1].x + line[1].width));
  });

  it('opens room for two grown at once, as one hands over to the next', () => {
    const shifts = placedWords(line, { words: [standing(1.06), standing(1.1), standing(1)] });
    const a = (0.06 * 200) / 2;
    const b = (0.1 * 400) / 2;
    expect(shifts.get(line[0])).toBeCloseTo(-a - b + a);
    expect(shifts.get(line[1])).toBeCloseTo(-a - b + 2 * a + b);
    expect(shifts.get(line[2])).toBeCloseTo(a + b);
  });

  it('moves no word for one coming on smaller, nor for one not yet there', () => {
    const shifts = placedWords(line, { words: [standing(1), standing(1), { visible: false, fill: 0, scale: 1.12, opacity: 0 }] });
    expect(shifts.size).toBe(0);
    expect(placedWords(line, { words: [standing(0.8), standing(1), standing(1)] }).size).toBe(0);
  });

  it('keeps each line to itself', () => {
    const two = [word(0, 0, 200, 0), word(1, 230, 200, 0), word(2, 0, 200, 1), word(3, 230, 200, 1)];
    const shifts = placedWords(two, { words: [standing(1.12), standing(1), standing(1), standing(1)] });
    expect(shifts.has(two[2])).toBe(false);
    expect(shifts.has(two[3])).toBe(false);
    expect(shifts.get(two[1])).toBeCloseTo((0.12 * 200) / 2);
  });
});
