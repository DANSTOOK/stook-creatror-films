/**
 * What the video scopes measure, as plain arithmetic on a frame.
 *
 * No DOM and no GPU here, so every number a scope draws can be checked in a
 * unit test against a pattern whose answer is known (tests/Scopes.test.ts).
 *
 * The frame is the finished picture as it will be exported: 8-bit R'G'B',
 * gamma-encoded, full range 0-255. Everything is measured on those encoded
 * values, as broadcast scopes and Resolve's, Premiere's and Final Cut's do:
 *
 *   - luma is Y' = 0.2126 R' + 0.7152 G' + 0.0722 B' (ITU-R BT.709);
 *   - chroma is Cb = (B' - Y') / 1.8556 and Cr = (R' - Y') / 1.5748, each
 *     -0.5..0.5, the BT.709 colour-difference signals a vectorscope plots.
 *
 * 0-255 in the frame is 0-100% on the scales. The export turns that range
 * into TV-range YUV (16-235), so 0% and 100% are exactly the legal limits.
 */

export type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

export const SCOPE_KINDS: readonly ScopeKind[] = ['waveform', 'parade', 'vectorscope', 'histogram'];

/** ITU-R BT.709 luma weights. */
export const LUMA_709 = [0.2126, 0.7152, 0.0722] as const;

/** Levels on the vertical axis of a waveform and bins of a histogram. */
export const LEVELS = 256;

/** The vectorscope's grid is VECTOR_SIZE x VECTOR_SIZE cells. */
export const VECTOR_SIZE = 256;

/** A frame to measure: RGBA bytes, row order irrelevant to every scope. */
export interface ScopeFrame {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/** Y' of an 8-bit R'G'B' triple, 0-255. */
export const luma709 = (r: number, g: number, b: number): number =>
  LUMA_709[0] * r + LUMA_709[1] * g + LUMA_709[2] * b;

/** Cb and Cr, -0.5..0.5, of an 8-bit R'G'B' triple. */
export function chroma709(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = luma709(r, g, b);
  return { cb: (b - y) / 255 / 1.8556, cr: (r - y) / 255 / 1.5748 };
}

/**
 * Where a chroma pair sits on the vectorscope, 0..1 across and down: Cb to
 * the right, Cr up, the centre neutral. The circle's edge is +-0.5.
 */
export const vectorPosition = (cb: number, cr: number): { x: number; y: number } => ({
  x: cb + 0.5,
  y: 0.5 - cr,
});

/*
  The vectorscope cell of a pixel, from Y' and its R' and B': the column is
  (Cb + 0.5) and the row (0.5 - Cr), each scaled to the grid and rounded.
  Written out so the hot loop does two multiplies and no divisions.
*/
const LAST_CELL = VECTOR_SIZE - 1;
const CELL_MIDDLE = LAST_CELL / 2;
const CB_TO_CELL = LAST_CELL / (255 * 1.8556);
const CR_TO_CELL = LAST_CELL / (255 * 1.5748);
const clampCell = (value: number): number => (value < 0 ? 0 : value > LAST_CELL ? LAST_CELL : value);
const cellColumn = (b: number, y: number): number => clampCell(((b - y) * CB_TO_CELL + CELL_MIDDLE + 0.5) | 0);
const cellRow = (r: number, y: number): number => clampCell((CELL_MIDDLE - (r - y) * CR_TO_CELL + 0.5) | 0);

/* Each channel's share of luma, per 8-bit value: a lookup beats three multiplies. */
const LUMA_R = Float64Array.from({ length: 256 }, (_, v) => LUMA_709[0] * v);
const LUMA_G = Float64Array.from({ length: 256 }, (_, v) => LUMA_709[1] * v);
const LUMA_B = Float64Array.from({ length: 256 }, (_, v) => LUMA_709[2] * v);

/**
 * The six 75% colour-bar targets a vectorscope's boxes are drawn for, in
 * the order scopes label them. 75% bars are what the SMPTE and EBU test
 * signals carry, so a correctly reproduced bar lands in its box.
 */
export const VECTOR_TARGETS: ReadonlyArray<{ label: string; rgb: readonly [number, number, number] }> = [
  { label: 'R', rgb: [191, 0, 0] },
  { label: 'Mg', rgb: [191, 0, 191] },
  { label: 'B', rgb: [0, 0, 191] },
  { label: 'Cy', rgb: [0, 191, 191] },
  { label: 'G', rgb: [0, 191, 0] },
  { label: 'Yl', rgb: [191, 191, 0] },
];

/**
 * The skin-tone line: the hue every human complexion falls near, whatever
 * its depth, drawn from the centre at 123 degrees counter-clockwise from the
 * +Cb axis (the "I-line" of the NTSC vectorscope, which Resolve, Premiere
 * and Final Cut all keep).
 */
export const SKIN_LINE_DEGREES = 123;

export interface ScopeData {
  /** Pixels in each column at each luma level: index = level * width + x. */
  waveform?: Uint32Array;
  /** The same for R', G' and B' in turn. */
  parade?: [Uint32Array, Uint32Array, Uint32Array];
  /** Pixels in each chroma cell: index = row * VECTOR_SIZE + column, row 0 the top (Cr +0.5). */
  vectorscope?: Uint32Array;
  /** Pixels at each level, per channel and for luma. */
  histogram?: { r: Uint32Array; g: Uint32Array; b: Uint32Array; y: Uint32Array };
  /** Width of the measured frame, the number of waveform columns. */
  width: number;
  height: number;
}

/**
 * Measure a frame for the scopes asked for, in one pass over its pixels.
 *
 * The frame is the small copy the compositor reads back (at most 512 pixels
 * across), some 150 thousand pixels. It runs in the scopes' worker, off the
 * thread that draws the picture.
 */
export function computeScopes(frame: ScopeFrame, kinds: ReadonlySet<ScopeKind>): ScopeData {
  const { rgba, width, height } = frame;
  const pixels = width * height;
  const wantWaveform = kinds.has('waveform');
  const wantParade = kinds.has('parade');
  const wantVector = kinds.has('vectorscope');
  const wantHistogram = kinds.has('histogram');

  const waveform = wantWaveform ? new Uint32Array(width * LEVELS) : undefined;
  const parade: [Uint32Array, Uint32Array, Uint32Array] | undefined = wantParade
    ? [new Uint32Array(width * LEVELS), new Uint32Array(width * LEVELS), new Uint32Array(width * LEVELS)]
    : undefined;
  const vectorscope = wantVector ? new Uint32Array(VECTOR_SIZE * VECTOR_SIZE) : undefined;
  const histogram = wantHistogram
    ? { r: new Uint32Array(LEVELS), g: new Uint32Array(LEVELS), b: new Uint32Array(LEVELS), y: new Uint32Array(LEVELS) }
    : undefined;

  const end = pixels * 4;
  let x = 0;
  for (let offset = 0; offset < end; offset += 4) {
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const y = LUMA_R[r] + LUMA_G[g] + LUMA_B[b];
    const level = (y + 0.5) | 0;

    if (waveform) waveform[level * width + x] += 1;
    if (parade) {
      parade[0][r * width + x] += 1;
      parade[1][g * width + x] += 1;
      parade[2][b * width + x] += 1;
    }
    if (histogram) {
      histogram.r[r] += 1;
      histogram.g[g] += 1;
      histogram.b[b] += 1;
      histogram.y[level] += 1;
    }
    if (vectorscope) vectorscope[cellRow(r, y) * VECTOR_SIZE + cellColumn(b, y)] += 1;

    x += 1;
    if (x === width) x = 0;
  }

  return { waveform, parade, vectorscope, histogram, width, height };
}

/** The vectorscope cell a colour lands in, for tests and for drawing targets. */
export function vectorCellOf(r: number, g: number, b: number): { column: number; row: number } {
  const y = LUMA_R[r] + LUMA_G[g] + LUMA_B[b];
  return { column: cellColumn(b, y), row: cellRow(r, y) };
}
