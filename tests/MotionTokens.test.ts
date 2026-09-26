import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUNCE, EXIT_FAST_MS, EXIT_MS, REDUCED_MS, SPRINGS } from '../src/renderer/motion/tokens.generated';

/**
 * The motion tokens are generated (scripts/motion-tokens.cjs). These pin the
 * generated files to the script - change the bounce without running it and
 * this fails - and pin the rules the motion system promises.
 */

const require = createRequire(import.meta.url);
const generator = require('../scripts/motion-tokens.cjs') as {
  build(): { css: string; ts: string };
  springAt(duration: number, bounce: number, t: number): number;
};
const root = join(__dirname, '..');
/** As checked out: Git may have given the files Windows line endings. */
const read = (path: string): string => readFileSync(join(root, path), 'utf8').split('\r\n').join('\n');

describe('motion tokens', () => {
  it('are what the script generates, for both CSS and code', () => {
    const { css, ts } = generator.build();
    expect(read('src/renderer/motion/tokens.css')).toBe(css);
    expect(read('src/renderer/motion/tokens.generated.ts')).toBe(ts);
  });

  it('keeps one bounce for everything that moves in space, and it is playful', () => {
    expect(BOUNCE).toBeGreaterThan(0);
    expect(BOUNCE).toBeLessThanOrEqual(0.3);
    for (const name of ['quick', 'standard', 'emphasis'] as const) {
      const bouncy = SPRINGS[`${name}Bounce`];
      const peak = Math.max(...bouncy.points);
      // Visible, never cartoonish: a few percent past the target.
      expect(peak).toBeGreaterThan(1.01);
      expect(peak).toBeLessThan(1.05);
    }
  });

  it('never overshoots on the flat springs, which carry opacity and colour', () => {
    for (const name of ['quick', 'standard', 'emphasis'] as const) {
      expect(Math.max(...SPRINGS[name].points)).toBeLessThanOrEqual(1);
    }
  });

  it('starts at rest and lands exactly on the target', () => {
    for (const spring of Object.values(SPRINGS)) {
      expect(spring.points[0]).toBe(0);
      expect(spring.points[spring.points.length - 1]).toBe(1);
      expect(spring.easing.startsWith('linear(0, ')).toBe(true);
    }
  });

  it('is fast: nothing settles in more than half a second, and exits are shorter than entrances', () => {
    for (const spring of Object.values(SPRINGS)) expect(spring.settleMs).toBeLessThanOrEqual(500);
    expect(EXIT_MS).toBeLessThanOrEqual(150);
    expect(EXIT_FAST_MS).toBeLessThan(EXIT_MS);
    expect(EXIT_MS).toBeLessThan(SPRINGS.quick.settleMs);
    expect(REDUCED_MS).toBe(100);
  });

  it('samples a real spring: bounce 0 is critically damped, and a shorter duration is faster', () => {
    const at = (duration: number, bounce: number, t: number): number => generator.springAt(duration, bounce, t);
    expect(at(0.25, 0, 0)).toBeCloseTo(0, 6);
    expect(at(0.25, 0, 1)).toBeCloseTo(1, 3);
    expect(at(0.15, 0, 0.1)).toBeGreaterThan(at(0.35, 0, 0.1));
    // With bounce it passes the target and comes back.
    let crossed = false;
    for (let t = 0; t < 0.6; t += 0.005) if (at(0.25, 0.25, t) > 1) crossed = true;
    expect(crossed).toBe(true);
  });
});
