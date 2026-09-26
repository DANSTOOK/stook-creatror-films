import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';

/**
 * The page's side of the timeline's pictures and waveforms.
 *
 * The main process makes both files (main/media/clipContent.ts); this reads
 * them and keeps what the canvas draws. Nothing here decodes video or audio:
 * a waveform is a small array, and a filmstrip is a few hundred tiny JPEGs
 * decoded by the browser off the main thread (`createImageBitmap`), only the
 * ones a clip on screen needs, into a bounded cache.
 */

/** A waveform file from the main process, or null if it is not one. */
export function parsePeaksFile(buffer: ArrayBuffer): WaveformPeaks | null {
  if (buffer.byteLength < 16) return null;
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'SCFP') return null;
  const bucketCount = view.getUint32(8, true);
  const durationSeconds = view.getFloat32(12, true);
  if (bucketCount === 0 || buffer.byteLength < 16 + bucketCount * 8) return null;
  // Copied out so the pairs sit on a 4-byte boundary whatever the header did.
  const peaks = new Float32Array(buffer.slice(16, 16 + bucketCount * 8));
  return { peaks, bucketCount, durationSeconds, sampleRate: bucketCount / Math.max(1e-6, durationSeconds) };
}

export interface FilmstripIndex {
  width: number;
  height: number;
  /** Seconds into the source of each frame, ascending. */
  times: number[];
  /** Byte offset and length of each JPEG in `data`. */
  spans: Array<[number, number]>;
  data: ArrayBuffer;
}

/** A filmstrip file from the main process, or null if it is not one. */
export function parseThumbsFile(buffer: ArrayBuffer): FilmstripIndex | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'SCFT') return null;
  const length = view.getUint32(4, true);
  try {
    const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))) as {
      width: number;
      height: number;
      frames: Array<[number, number, number]>;
    };
    if (!Array.isArray(index.frames) || index.frames.length === 0) return null;
    return {
      width: index.width,
      height: index.height,
      times: index.frames.map((frame) => frame[0]),
      spans: index.frames.map((frame) => [frame[1], frame[2]]),
      data: buffer.slice(8 + length),
    };
  } catch {
    return null;
  }
}

/**
 * The frame to show for a moment of the source: the last one at or before
 * it, as a filmstrip tile shows the picture where it begins.
 */
export function frameAt(times: readonly number[], seconds: number): number {
  let low = 0;
  let high = times.length - 1;
  if (high < 0) return -1;
  if (seconds <= times[0]) return 0;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle] <= seconds) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Decoded frames kept at once, across every clip: about 30 MB of 128x72 bitmaps. */
const BITMAP_LIMIT = 800;

/**
 * One source's filmstrip: its index, and its frames decoded as they are asked
 * for. A frame not decoded yet is asked for and `null` comes back; `onReady`
 * fires once it is, so the timeline can paint it.
 */
export class Filmstrip {
  constructor(readonly index: FilmstripIndex, private readonly onReady: () => void) {}

  get aspect(): number {
    return this.index.height > 0 ? this.index.width / this.index.height : 16 / 9;
  }

  frameAt(seconds: number): number {
    return frameAt(this.index.times, seconds);
  }

  bitmap(frame: number): ImageBitmap | null {
    const key = this.key(frame);
    const held = bitmaps.get(key);
    if (held) {
      // Most recently used goes to the back: the front is evicted first.
      bitmaps.delete(key);
      bitmaps.set(key, held);
      return held;
    }
    if (!decoding.has(key)) this.decode(frame, key);
    return null;
  }

  /** The nearest frame already decoded, to hold a tile while its own is on its way. */
  nearestDecoded(frame: number): ImageBitmap | null {
    for (let distance = 1; distance < 8; distance += 1) {
      const before = bitmaps.get(this.key(frame - distance));
      if (before) return before;
      const after = bitmaps.get(this.key(frame + distance));
      if (after) return after;
    }
    return null;
  }

  private readonly id = (nextId += 1);

  private key(frame: number): string {
    return `${this.id}:${frame}`;
  }

  private decode(frame: number, key: string): void {
    const span = this.index.spans[frame];
    if (!span || typeof createImageBitmap !== 'function') return;
    decoding.add(key);
    const blob = new Blob([new Uint8Array(this.index.data, span[0], span[1])], { type: 'image/jpeg' });
    createImageBitmap(blob)
      .then((bitmap) => {
        bitmaps.set(key, bitmap);
        while (bitmaps.size > BITMAP_LIMIT) {
          const oldest = bitmaps.keys().next().value as string;
          bitmaps.get(oldest)?.close();
          bitmaps.delete(oldest);
        }
        this.onReady();
      })
      .catch(() => undefined)
      .finally(() => decoding.delete(key));
  }
}

let nextId = 0;
const bitmaps = new Map<string, ImageBitmap>();
const decoding = new Set<string>();

/** How a clip on the timeline shows what is in it, after Final Cut's clip appearance. */
export type ClipAppearance = 'waveform' | 'both' | 'filmstrip' | 'name';

export const CLIP_APPEARANCES: readonly ClipAppearance[] = ['waveform', 'both', 'filmstrip', 'name'];

export const CLIP_APPEARANCE_KEY = 'scf.clipAppearance';

/** Pictures on top and the sound under them: what most clips want to show. */
export const DEFAULT_CLIP_APPEARANCE: ClipAppearance = 'both';

export function loadClipAppearance(): ClipAppearance {
  try {
    const stored = window.localStorage.getItem(CLIP_APPEARANCE_KEY);
    return CLIP_APPEARANCES.includes(stored as ClipAppearance) ? (stored as ClipAppearance) : DEFAULT_CLIP_APPEARANCE;
  } catch {
    return DEFAULT_CLIP_APPEARANCE;
  }
}

export function saveClipAppearance(appearance: ClipAppearance): void {
  try {
    window.localStorage.setItem(CLIP_APPEARANCE_KEY, appearance);
  } catch {
    // Kept for this session only.
  }
}
