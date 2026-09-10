import { describe, expect, it } from 'vitest';
import { parseCubeLUT, sampleLUTNearest } from '@renderer/engine/LUTLoader';

/** Identity LUT of edge length `size`, in the red-fastest order `.cube` uses. */
function identityCube(size: number, header = ''): string {
  const lines: string[] = [`LUT_3D_SIZE ${size}`];
  if (header) lines.unshift(header);

  const last = size - 1;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(`${r / last} ${g / last} ${b / last}`);
      }
    }
  }
  return lines.join('\n');
}

describe('parseCubeLUT', () => {
  it('parses size, title and data for a minimal LUT', () => {
    const lut = parseCubeLUT(identityCube(2, 'TITLE "Neutral"'));

    expect(lut.title).toBe('Neutral');
    expect(lut.size).toBe(2);
    expect(lut.data).toBeInstanceOf(Float32Array);
    expect(lut.data.length).toBe(2 ** 3 * 3);
  });

  it('defaults the domain to 0..1 when not declared', () => {
    const lut = parseCubeLUT(identityCube(2));
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
  });

  it('reads explicit DOMAIN_MIN and DOMAIN_MAX', () => {
    const source = ['DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 4.0 4.0 4.0', identityCube(2)].join('\n');
    const lut = parseCubeLUT(source);

    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([4, 4, 4]);
  });

  it('keeps the red channel varying fastest', () => {
    const lut = parseCubeLUT(identityCube(2));

    // Entry 1 is (r=1, g=0, b=0) if the ordering is right.
    expect(Array.from(lut.data.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(lut.data.slice(3, 6))).toEqual([1, 0, 0]);
    // Entry 2 steps green, entry 4 steps blue.
    expect(Array.from(lut.data.slice(6, 9))).toEqual([0, 1, 0]);
    expect(Array.from(lut.data.slice(12, 15))).toEqual([0, 0, 1]);
  });

  it('ignores comments, blank lines and trailing whitespace', () => {
    const source = [
      '# Exported by a grading app',
      '',
      'TITLE "Commented"',
      '   ',
      'LUT_3D_SIZE 2',
      '0 0 0  # first entry',
      '1 0 0',
      '0 1 0',
      '1 1 0',
      '0 0 1',
      '1 0 1',
      '0 1 1',
      '1 1 1   ',
    ].join('\n');

    const lut = parseCubeLUT(source);
    expect(lut.title).toBe('Commented');
    expect(lut.data.length).toBe(24);
    expect(Array.from(lut.data.slice(21, 24))).toEqual([1, 1, 1]);
  });

  it('handles CRLF line endings', () => {
    const lut = parseCubeLUT(identityCube(2).split('\n').join('\r\n'));
    expect(lut.size).toBe(2);
    expect(lut.data.length).toBe(24);
  });

  it('parses a realistically sized LUT', () => {
    const lut = parseCubeLUT(identityCube(17));
    expect(lut.size).toBe(17);
    expect(lut.data.length).toBe(17 ** 3 * 3);
  });

  it('round-trips an identity LUT through nearest sampling', () => {
    const lut = parseCubeLUT(identityCube(8));

    expect(sampleLUTNearest(lut, 0, 0, 0)).toEqual([0, 0, 0]);
    expect(sampleLUTNearest(lut, 1, 1, 1)).toEqual([1, 1, 1]);

    const [r, g, b] = sampleLUTNearest(lut, 1, 0, 0);
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(0, 5);
  });

  it('rejects a file with no LUT_3D_SIZE', () => {
    expect(() => parseCubeLUT('TITLE "Broken"\n0 0 0\n')).toThrow(
      /LUT data before LUT_3D_SIZE/i,
    );
  });

  it('rejects a truncated LUT', () => {
    const truncated = identityCube(2).split('\n').slice(0, -2).join('\n');
    expect(() => parseCubeLUT(truncated)).toThrow(/declares size 2/i);
  });

  it('rejects extra entries beyond the declared size', () => {
    expect(() => parseCubeLUT(`${identityCube(2)}\n0.5 0.5 0.5`)).toThrow(/extra entries/i);
  });

  it('rejects an out-of-range LUT_3D_SIZE', () => {
    expect(() => parseCubeLUT('LUT_3D_SIZE 1\n0 0 0')).toThrow(/LUT_3D_SIZE/);
    expect(() => parseCubeLUT('LUT_3D_SIZE 999\n0 0 0')).toThrow(/LUT_3D_SIZE/);
  });

  it('rejects 1D LUTs with an explanatory message', () => {
    expect(() => parseCubeLUT('LUT_1D_SIZE 32\n0 0 0')).toThrow(/1D .cube LUTs are not supported/);
  });

  it('rejects an entry with a missing component', () => {
    expect(() => parseCubeLUT('LUT_3D_SIZE 2\n0 0\n')).toThrow(/three components/i);
  });

  it('rejects a non-numeric entry', () => {
    expect(() => parseCubeLUT('LUT_3D_SIZE 2\n0 0 0\nnope nope nope\n')).toThrow(
      /Unrecognized line/i,
    );
  });

  it('rejects an inverted domain', () => {
    const source = ['DOMAIN_MIN 1.0 0.0 0.0', 'DOMAIN_MAX 0.0 1.0 1.0', identityCube(2)].join('\n');
    expect(() => parseCubeLUT(source)).toThrow(/DOMAIN_MAX must exceed DOMAIN_MIN/);
  });
});
