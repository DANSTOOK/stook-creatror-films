import { parseMoov, readLayout, restartIndexBefore, type ByteReader, type Mp4Sample, type Mp4VideoTrack } from './mp4';

/**
 * Frame-exact, in-order video decoding for export.
 *
 * Export used to seek an HTMLVideoElement to every frame. Each seek restarts
 * the decoder at the previous keyframe, so a 30 fps export spent ~50-80 ms per
 * frame waiting on decoding it had already done - 10-17 fps with the GPU idle.
 * An export walks the timeline forwards, so this decodes the file forwards
 * with WebCodecs, once, and hands out each frame as the render reaches it.
 *
 * One reader per clip being rendered: two clips cut from the same file are two
 * independent positions in it. Files it cannot handle (not MP4/MOV, a codec
 * other than H.264/HEVC, a decoder the machine lacks) make `open` return null,
 * and the renderer falls back to seeking for that clip.
 */

/** Bytes fetched per read. Samples are consecutive, so one read covers many. */
const READ_WINDOW = 8 * 1024 * 1024;

/** Chunks allowed to wait in the decoder at once. */
const MAX_DECODE_QUEUE = 6;

/** No output for this long means the decoder is stuck; the caller falls back. */
const STALL_MS = 8000;

/** Fresh decoders tried for one frame after a failure, before giving up on it. */
const MAX_REOPENS_PER_FRAME = 2;

/** Fresh decoders one reader may open after failures, over its whole life. */
const MAX_REOPENS = 6;

const microseconds =(seconds: number): number => Math.round(seconds * 1e6);

/** Parsed tracks are shared by every reader of the same file. */
const trackCache = new Map<string, Promise<{ track: Mp4VideoTrack; size: number } | null>>();

function rangeReader(url: string): ByteReader {
  return async (offset, length) => {
    const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    // A server that ignores Range would send the whole file for every read.
    if (response.status !== 206) throw new Error(`no range support (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

async function fileSize(url: string): Promise<number> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  await response.arrayBuffer();
  const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
  if (response.status !== 206 || !total) throw new Error('no range support');
  return Number(total[1]);
}

function loadTrack(url: string): Promise<{ track: Mp4VideoTrack; size: number } | null> {
  let pending = trackCache.get(url);
  if (!pending) {
    pending = (async () => {
      if (!url.startsWith('media:')) return null;
      const size = await fileSize(url);
      // Fragments too: a fragmented file's moov alone lists no samples.
      const layout = await readLayout(rangeReader(url), size);
      const track = layout ? parseMoov(layout.moov, layout.fragments) : null;
      return track && track.samples.length > 0 ? { track, size } : null;
    })().catch(() => null);
    trackCache.set(url, pending);
  }
  return pending;
}

/**
 * Test hook: make a reader's decoder fail part-way through a file, the way a
 * real decode error does - the decoder closes and reports an error, and the
 * frames it had not yet put out are lost.
 *
 * `window.__scfDecodeFault = { match, atSeconds, times }`: the first `times`
 * decoders of a file whose URL contains `match` fail as they are fed the
 * first sample at or after `atSeconds`. `fired` counts the failures caused,
 * so a test can tell that the fault it asked for really happened. A list of
 * such faults gives each file its own.
 */
interface DecodeFault {
  match: string;
  atSeconds: number;
  times: number;
  fired?: number;
}

function injectedFault(url: string, sample: Mp4Sample): boolean {
  const set = (globalThis as { __scfDecodeFault?: DecodeFault | DecodeFault[] | null }).__scfDecodeFault;
  if (!set) return false;
  for (const fault of Array.isArray(set) ? set : [set]) {
    if (fault.times <= 0 || sample.time < fault.atSeconds) continue;
    if (!decodeURIComponent(url).includes(fault.match)) continue;
    fault.times -= 1;
    fault.fired = (fault.fired ?? 0) + 1;
    return true;
  }
  return false;
}

/**
 * Presentation times, in seconds and ascending, of every frame of an MP4 or
 * MOV whose tables this module can read, whatever its codec; null for any
 * other file. The same times the readers pick frames by, so a clip that
 * falls back to seeking is checked against the rule it was decoded by.
 */
export async function presentationTimes(url: string): Promise<number[] | null> {
  const loaded = await loadTrack(url);
  return loaded ? loaded.track.samples.map((sample) => sample.time).sort((a, b) => a - b) : null;
}

/** Forget one URL's parsed track: it now shows another file (stabilized, or relinked under the same URL). */
export function forgetTrack(url: string): void {
  trackCache.delete(url);
}

/** Forget parsed tracks, e.g. when an asset is removed. */
export function clearTrackCache(): void {
  trackCache.clear();
}

export class SequentialVideoReader {
  private decoder: VideoDecoder | null = null;
  /** Decoded frames not yet asked for, in presentation order. */
  private readonly decoded: VideoFrame[] = [];
  /** The frame last handed out; kept until the render moves past it. */
  private current: VideoFrame | null = null;
  /** Next sample to feed, in decode order. */
  private nextFeed = 0;
  private flushed = false;
  private flushDone = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  /** Bumped by `close`, so a call waiting on the decoder knows not to revive it. */
  private generation = 0;
  /** Fresh decoders opened after a failure, over the reader's life. */
  private reopens = 0;

  /** Failed decoders replaced by every reader of the session, for tests and diagnostics. */
  static reopenedTotal = 0;

  /** Samples sorted by presentation time, with their decode-order index. */
  private readonly byTime: { sample: Mp4Sample; decodeIndex: number }[];

  private buffer: Uint8Array | null = null;
  private bufferStart = 0;

  private constructor(
    private readonly url: string,
    private readonly track: Mp4VideoTrack,
    private readonly config: VideoDecoderConfig,
  ) {
    this.byTime = track.samples
      .map((sample, decodeIndex) => ({ sample, decodeIndex }))
      .sort((a, b) => a.sample.time - b.sample.time);
  }

  /** A reader for `url`, or null when this file must use the seek path. */
  static async open(url: string): Promise<SequentialVideoReader | null> {
    if (typeof VideoDecoder === 'undefined') return null;
    const loaded = await loadTrack(url);
    if (!loaded) return null;

    const { track } = loaded;
    const config: VideoDecoderConfig = {
      codec: track.codec,
      description: track.description,
      codedWidth: track.width,
      codedHeight: track.height,
      optimizeForLatency: false,
    };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
    if (!support?.supported) return null;

    return new SequentialVideoReader(url, track, config);
  }

  /** The presentation sample shown at `seconds`. */
  private sampleAt(seconds: number): { sample: Mp4Sample; decodeIndex: number } {
    const list = this.byTime;
    let low = 0;
    let high = list.length - 1;
    // Last sample starting at or before `seconds`; the first one before that.
    if (seconds < list[0].sample.time) return list[0];
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (list[mid].sample.time <= seconds) low = mid;
      else high = mid - 1;
    }
    return list[low];
  }

  private startDecoder(fromIndex: number): void {
    this.closeDecoder();
    this.failure = null;
    this.flushed = false;
    this.flushDone = false;
    this.nextFeed = fromIndex;

    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.decoded.push(frame);
        this.notify();
      },
      error: (error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.notify();
      },
    });
    this.decoder.addEventListener('dequeue', () => this.notify());
    this.decoder.configure(this.config);
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private waitForDecoder(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        reject(new Error('video decoder stalled'));
      }, STALL_MS);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async bytes(sample: Mp4Sample): Promise<Uint8Array> {
    const end = sample.offset + sample.size;
    if (!this.buffer || sample.offset < this.bufferStart || end > this.bufferStart + this.buffer.byteLength) {
      this.bufferStart = sample.offset;
      this.buffer = await rangeReader(this.url)(sample.offset, Math.max(READ_WINDOW, sample.size));
    }
    const at = sample.offset - this.bufferStart;
    return this.buffer.subarray(at, at + sample.size);
  }

  private async feed(): Promise<void> {
    const decoder = this.decoder;
    if (!decoder) return;
    const sample = this.track.samples[this.nextFeed];
    const data = await this.bytes(sample);
    if (decoder.state !== 'configured') return;
    if (injectedFault(this.url, sample)) {
      decoder.close();
      this.failure = new Error(`injected decode error at ${sample.time.toFixed(3)} s (test)`);
      this.notify();
      return;
    }
    decoder.decode(
      new EncodedVideoChunk({
        type: sample.isSync ? 'key' : 'delta',
        timestamp: microseconds(sample.time),
        duration: microseconds(sample.duration),
        data,
      }),
    );
    this.nextFeed += 1;
  }

  /**
   * The timestamp, in microseconds, of the frame `frameAt` answers for
   * `sourceFrame` - so a cache keyed by it gives exactly what a decode would.
   */
  timestampFor(sourceFrame: number, fps: number): number {
    return microseconds(this.sampleAt((sourceFrame + 0.5) / fps).sample.time);
  }

  /**
   * The decoded frame for `sourceFrame` of a `fps` timeline.
   *
   * The returned frame belongs to the reader and stays valid until the next
   * call or `close` - upload it, do not keep it.
   *
   * `onPassed` sees every frame decoded on the way to the target and skipped
   * over. It may copy the frame, but not keep it: the frame is closed as soon
   * as the callback returns. Export passes nothing and skips them as before.
   */
  async frameAt(sourceFrame: number, fps: number, onPassed?: (frame: VideoFrame) => void): Promise<VideoFrame> {
    // The middle of the frame, for the same reason `seekExact` aims there:
    // container timestamps are rounded, frame starts are not safe targets.
    const target = this.sampleAt((sourceFrame + 0.5) / fps);
    const timestamp = microseconds(target.sample.time);

    if (this.current?.timestamp === timestamp) return this.current;

    // Restart from a keyframe when going backwards, or when the target is far
    // enough ahead that decoding everything in between would be slower.
    const lastShown = this.current?.timestamp ?? -Infinity;
    // A sample the decoder accepts as a start: an IDR, not merely a sample
    // the container calls sync (see restartIndexBefore).
    const restartFrom = await restartIndexBefore(this.track, target.decodeIndex, (sample) => this.bytes(sample));
    if (!this.decoder || timestamp < lastShown || restartFrom > this.nextFeed) {
      this.dropFrames();
      this.startDecoder(restartFrom);
    }

    const generation = this.generation;
    let reopened = 0;
    for (;;) {
      // Frames before the target are ones this render skips over.
      while (this.decoded.length > 0 && this.decoded[0].timestamp < timestamp) {
        const passed = this.decoded.shift() as VideoFrame;
        onPassed?.(passed);
        passed.close();
      }
      // Frames put out before a failure are still good, but only the target
      // itself: past a failure, a later frame means the target was lost.
      if (this.decoded.length > 0 && (!this.failure || this.decoded[0].timestamp === timestamp)) {
        // Normally the exact frame. Should the file's tables disagree with the
        // stream, the next frame is the closest honest answer.
        const frame = this.decoded.shift() as VideoFrame;
        this.current?.close();
        this.current = frame;
        return frame;
      }

      if (this.failure) {
        // Closed by its owner while this call waited: nothing to recover.
        if (this.generation !== generation) throw new Error('reader closed');
        // A decode error closes the decoder, but it is often a passing
        // trouble of the hardware rather than of the file, and a fresh
        // decoder started again at the keyframe before the target usually
        // gets through. That beats the caller's fallback, seeking a <video>,
        // which is slow and not frame-exact. Twice at most for one frame,
        // and a few times a file, so a file that really is broken - or a
        // decoder that keeps stalling - gives up rather than retry forever.
        if (reopened >= MAX_REOPENS_PER_FRAME || this.reopens >= MAX_REOPENS) throw this.failure;
        reopened += 1;
        this.reopens += 1;
        SequentialVideoReader.reopenedTotal += 1;
        console.info(`[decode] ${this.failure.message}: reopening the decoder at the keyframe before ${target.sample.time.toFixed(3)} s`);
        this.dropFrames();
        const from = await restartIndexBefore(this.track, target.decodeIndex, (sample) => this.bytes(sample));
        if (this.generation !== generation) throw new Error('reader closed');
        this.startDecoder(from);
        continue;
      }

      // Closed while this call waited - a scrub decoder is closed whenever
      // playback starts. Say so plainly rather than failing on a null.
      const decoder = this.decoder;
      if (!decoder) throw new Error('reader closed');
      if (this.nextFeed < this.track.samples.length) {
        if (decoder.decodeQueueSize < MAX_DECODE_QUEUE) {
          await this.feed();
          continue;
        }
      } else if (!this.flushed) {
        // End of stream: the decoder holds back its last frames until flushed.
        // Not awaited: flush resolves only once every frame is out, and a
        // hardware decoder cannot put them out while its few output buffers
        // are sitting in `decoded` waiting for this loop. Awaiting it here
        // deadlocked on the last GOP of every file.
        this.flushed = true;
        decoder.flush().then(
          () => {
            this.flushDone = true;
            this.notify();
          },
          () => {
            this.flushDone = true;
            this.notify();
          },
        );
        continue;
      } else if (this.flushDone) {
        // Asked for a frame past the end of the stream: show the last one.
        if (this.current) return this.current;
        throw new Error('no frame decoded');
      }

      // A decoder that stops answering is treated like one that failed.
      await this.waitForDecoder().catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
      });
    }
  }

  private dropFrames(): void {
    for (const frame of this.decoded) frame.close();
    this.decoded.length = 0;
    this.current?.close();
    this.current = null;
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }

  close(): void {
    this.generation += 1;
    this.closeDecoder();
    this.dropFrames();
    this.buffer = null;
    this.notify();
  }
}
