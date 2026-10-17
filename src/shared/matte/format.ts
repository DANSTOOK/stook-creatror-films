/**
 * The matte cache file: one grey picture per frame of a source, saying how
 * much of each pixel is the subject (255) and how much is background (0).
 *
 * Written by the matting worker in the main process (main/matting/worker.ts)
 * and read by the renderer (renderer/engine/MatteTextures.ts), a range of
 * bytes at a time over `media://`, so a 20-minute clip never has to be in
 * memory at once. Nothing in here needs Node or the DOM.
 *
 * Layout, little-endian:
 *
 *   0   "SCFMATTE"            8 bytes
 *   8   format version        u32
 *   12  width, height         u32, u32
 *   20  frame count           u32
 *   24  frames per second     f64   (the file's average rate; informative)
 *   32  offset of the index   f64
 *   40  offset of the times   f64   (0: none - a still)
 *   48  reserved              16 bytes, zero
 *   64  frames, one after another, each run-length coded (below)
 *   ... the index: frame count + 1 offsets as f64, the last one the end of
 *       the last frame, so frame i is the bytes [index[i], index[i + 1]).
 *   ... the times: frame count f64, each frame's presentation time in
 *       seconds, never decreasing.
 *
 * One matte per frame of the file, each with the time it is shown at: a file
 * with a variable frame rate has no rate to count frames by, so a matte is
 * found by time, the way the decoders find the picture (matteFrameAt).
 *
 * The index and the times go last because frames are written as they are
 * made, and the count is only known at the end. A file whose header still
 * says zero frames was never finished, and is never renamed to its real name
 * (see the worker).
 */

export const MATTE_MAGIC = 'SCFMATTE';
export const MATTE_FORMAT_VERSION = 1;
export const MATTE_HEADER_BYTES = 64;

export interface MatteHeader {
  width: number;
  height: number;
  frames: number;
  fps: number;
  indexOffset: number;
  /** Where the frame times are; 0 when the file has none (a still). */
  timesOffset: number;
}

export function writeMatteHeader(header: MatteHeader): Uint8Array {
  const bytes = new Uint8Array(MATTE_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MATTE_MAGIC.length; index += 1) bytes[index] = MATTE_MAGIC.charCodeAt(index);
  view.setUint32(8, MATTE_FORMAT_VERSION, true);
  view.setUint32(12, header.width, true);
  view.setUint32(16, header.height, true);
  view.setUint32(20, header.frames, true);
  view.setFloat64(24, header.fps, true);
  view.setFloat64(32, header.indexOffset, true);
  view.setFloat64(40, header.timesOffset, true);
  return bytes;
}

/** The header, or null for anything that is not a finished matte file of this version. */
export function readMatteHeader(bytes: Uint8Array): MatteHeader | null {
  if (bytes.byteLength < MATTE_HEADER_BYTES) return null;
  for (let index = 0; index < MATTE_MAGIC.length; index += 1) {
    if (bytes[index] !== MATTE_MAGIC.charCodeAt(index)) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== MATTE_FORMAT_VERSION) return null;
  const header = {
    width: view.getUint32(12, true),
    height: view.getUint32(16, true),
    frames: view.getUint32(20, true),
    fps: view.getFloat64(24, true),
    indexOffset: view.getFloat64(32, true),
    timesOffset: view.getFloat64(40, true),
  };
  const sane =
    header.width > 0 &&
    header.height > 0 &&
    header.frames > 0 &&
    Number.isFinite(header.fps) &&
    header.fps > 0 &&
    header.indexOffset >= MATTE_HEADER_BYTES &&
    (header.timesOffset === 0 || header.timesOffset >= MATTE_HEADER_BYTES);
  return sane ? header : null;
}

export function writeMatteIndex(offsets: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(offsets.length * 8);
  const view = new DataView(bytes.buffer);
  offsets.forEach((offset, index) => view.setFloat64(index * 8, offset, true));
  return bytes;
}

export function readMatteIndex(bytes: Uint8Array, frames: number): number[] | null {
  if (bytes.byteLength < (frames + 1) * 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  for (let index = 0; index <= frames; index += 1) {
    const offset = view.getFloat64(index * 8, true);
    // Offsets only ever grow: anything else is a damaged file.
    if (!Number.isFinite(offset) || (index > 0 && offset < offsets[index - 1])) return null;
    offsets.push(offset);
  }
  return offsets;
}

export function writeMatteTimes(times: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(times.length * 8);
  const view = new DataView(bytes.buffer);
  times.forEach((time, index) => view.setFloat64(index * 8, time, true));
  return bytes;
}

export function readMatteTimes(bytes: Uint8Array, frames: number): number[] | null {
  if (bytes.byteLength < frames * 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const times: number[] = [];
  for (let index = 0; index < frames; index += 1) {
    const time = view.getFloat64(index * 8, true);
    // Times never go back: anything else is a damaged file.
    if (!Number.isFinite(time) || (index > 0 && time < times[index - 1])) return null;
    times.push(time);
  }
  return times;
}

/* Run-length coding --------------------------------------------------------- */

/*
  A matte is mostly long runs of 0 and 255 with a soft edge between them, so
  a PackBits-style code shrinks it ten- to thirty-fold and - unlike deflate -
  decodes synchronously, in a millisecond, inside the frame the compositor is
  drawing. A control byte c below 128 is followed by c + 1 bytes copied as
  they are; c of 128 or more says the next byte repeats c - 125 times (3 to
  130). Runs of two are cheaper written as they are.
*/

const MAX_LITERAL = 128;
const MAX_RUN = 130;
const MIN_RUN = 3;

export function encodeMatteFrame(pixels: Uint8Array): Uint8Array {
  // Worst case: a literal control byte for every 128 bytes.
  const out = new Uint8Array(pixels.length + Math.ceil(pixels.length / MAX_LITERAL) + 1);
  let written = 0;
  let index = 0;
  let literalStart = 0;

  const flushLiterals = (end: number): void => {
    let start = literalStart;
    while (start < end) {
      const length = Math.min(MAX_LITERAL, end - start);
      out[written] = length - 1;
      out.set(pixels.subarray(start, start + length), written + 1);
      written += length + 1;
      start += length;
    }
  };

  while (index < pixels.length) {
    const value = pixels[index];
    let run = 1;
    while (index + run < pixels.length && run < MAX_RUN && pixels[index + run] === value) run += 1;
    if (run >= MIN_RUN) {
      flushLiterals(index);
      out[written] = run + 125;
      out[written + 1] = value;
      written += 2;
      index += run;
      literalStart = index;
    } else {
      index += run;
    }
  }
  flushLiterals(pixels.length);
  return out.slice(0, written);
}

/**
 * Decode one frame into `into` (width x height bytes). Returns false for a
 * frame that does not decode to exactly that many pixels: the caller then
 * draws without a matte rather than with a wrong one.
 */
export function decodeMatteFrame(coded: Uint8Array, into: Uint8Array): boolean {
  let read = 0;
  let written = 0;
  while (read < coded.length) {
    const control = coded[read];
    if (control < MAX_LITERAL) {
      const length = control + 1;
      if (read + 1 + length > coded.length || written + length > into.length) return false;
      into.set(coded.subarray(read + 1, read + 1 + length), written);
      read += length + 1;
      written += length;
    } else {
      const length = control - 125;
      if (read + 1 >= coded.length || written + length > into.length) return false;
      into.fill(coded[read + 1], written, written + length);
      read += 2;
      written += length;
    }
  }
  return written === into.length;
}

/* Sizes and timing --------------------------------------------------------- */

/** The long edge mattes are kept at: enough for a soft edge on 4K, not a 4K file per second. */
export const MATTE_LONG_EDGE = 1024;

/**
 * The size a source's mattes are kept at: its own shape, the long edge
 * brought down to 1024 - never up - and both sides even.
 */
export function matteSize(width: number, height: number, longEdge = MATTE_LONG_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 2, height: 2 };
  const scale = Math.min(1, longEdge / Math.max(width, height));
  const even = (value: number): number => Math.max(2, 2 * Math.round(value / 2));
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * Which matte goes with a frame of footage, for a file without frame times
 * (a still, whose one matte is every frame's).
 *
 * The compositor asks for `sourceFrame` on the timeline's clock, and the
 * video it shows is the picture on screen at (sourceFrame + 0.5) / fps - the
 * middle of the frame, as the export's own decoders seek
 * (MediaSourceRegistry.seekExact, SequentialVideoReader.frameAt). The mattes
 * were taken one per frame at the file's own rate, so the one showing then is
 * the one to use, whatever rate the timeline runs at.
 */
export function matteFrameFor(sourceFrame: number, timelineFps: number, matteFps: number, frames: number): number {
  if (frames <= 1 || !(timelineFps > 0) || !(matteFps > 0)) return 0;
  const seconds = (Math.max(0, sourceFrame) + 0.5) / timelineFps;
  return Math.min(frames - 1, Math.max(0, Math.floor(seconds * matteFps + 1e-6)));
}

/**
 * Which matte goes with a frame of footage, by the frames' own times.
 *
 * The picture on screen for `sourceFrame` of a `timelineFps` timeline is the
 * last frame whose presentation time is at or before the middle of that
 * timeline frame, (sourceFrame + 0.5) / timelineFps - the rule both of the
 * renderer's decoders follow (SequentialVideoReader.sampleAt, and the
 * <video> element seeking there). Its matte is the one taken from that very
 * frame: the last of `times` at or before the same moment, of the first
 * `frames`. Before the first frame, the first. Unlike counting frames at an
 * average rate, this holds for a file whose frames come at any intervals.
 */
export function matteFrameAt(sourceFrame: number, timelineFps: number, times: readonly number[], frames = times.length): number {
  const count = Math.min(frames, times.length);
  if (count <= 1 || !(timelineFps > 0)) return 0;
  const seconds = (Math.max(0, sourceFrame) + 0.5) / timelineFps;
  let low = 0;
  let high = count - 1;
  if (seconds < times[0]) return 0;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle] <= seconds) low = middle;
    else high = middle - 1;
  }
  return low;
}
