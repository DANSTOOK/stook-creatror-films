import { SequentialVideoReader } from './SequentialVideoReader';
import { PreviewFrameCache, previewCapacity } from './PreviewFrameCache';

/**
 * Pictures for a paused, scrubbed playhead, decoded forwards.
 *
 * Seeking a `<video>` costs 110-150 ms on a screen recording with a keyframe
 * every few seconds, measured - the picture followed a dragged playhead at
 * about 7 updates a second. Dragging forwards, the next frame is a few
 * milliseconds away for a decoder that is already there, so this keeps one
 * per clip positioned at the playhead and lets it walk forwards.
 *
 * Going back was the weak side: exact about 7% of the time. A backwards step
 * means restarting at a keyframe, slower than a seek. Two things cover it now:
 *
 *  - Every frame a forward walk decodes and passes over is kept, as a small
 *    picture (`previewFor`), so dragging back over ground just covered is a
 *    lookup. The full-size frame still arrives once the playhead rests.
 *  - A drag that goes back beyond those starts a second reader filling in the
 *    stretch just behind the playhead (`fillBehind`), a few seconds at a time,
 *    ahead of the hand.
 */

/** Beyond this many frames ahead, a forward jump is left to a seek. */
const MAX_WALK_FRAMES = 45;

/** How long the playhead must rest before the decoder follows a jump. */
const SETTLE_MS = 150;

/** Width of the kept pictures. Enough to follow a drag; the rest arrives on release. */
const PREVIEW_WIDTH = 480;

/** How far behind the playhead one fill reaches: three seconds at 30 fps. */
const FILL_BEHIND_FRAMES = 90;

export class ScrubDecoder {
  private reader: SequentialVideoReader | null = null;
  private opening: Promise<void> | null = null;
  private failed = false;

  /** The newest decoded picture and the source frame it shows. */
  private shown: VideoFrame | null = null;
  private shownFrame = -1;

  /** Where the decoder is heading; the newest request wins. */
  private wanted = -1;
  private busy = false;
  private closed = false;

  /* Kept pictures ------------------------------------------------------------ */

  private previews: PreviewFrameCache<ImageBitmap> | null = null;
  private canvas: OffscreenCanvas | null = null;
  private context: OffscreenCanvasRenderingContext2D | null = null;
  /** Timestamp the playhead was last asked for; what eviction keeps close. */
  private focus = 0;

  /* Filling in behind a backwards drag --------------------------------------- */

  private filler: SequentialVideoReader | null = null;
  private filling: Promise<void> | null = null;

  constructor(
    private readonly uri: string,
    private readonly fps: number,
    private readonly onFrame: () => void,
  ) {}

  /** The source frame the decoder last produced, or -1. */
  get position(): number {
    return this.shownFrame;
  }

  /**
   * The picture for `sourceFrame`, if this decoder has it right now.
   *
   * Asked on every draw, so it is also where the kept pictures learn where the
   * playhead is. Eviction keeps what is near it; with the focus updated only on
   * a miss, it stayed wherever the last miss was, and a forward drag evicted
   * its own newest frames - the very ones the drag back needed (15% exact).
   */
  frameFor(sourceFrame: number): VideoFrame | null {
    if (this.reader) this.focus = this.reader.timestampFor(sourceFrame, this.fps);
    return this.shownFrame === sourceFrame ? this.shown : null;
  }

  /** A kept small picture of exactly `sourceFrame`, if one was decoded on the way. */
  previewFor(sourceFrame: number): ImageBitmap | null {
    const reader = this.reader;
    if (!reader || !this.previews) return null;
    const timestamp = reader.timestampFor(sourceFrame, this.fps);
    this.focus = timestamp;
    return this.previews.get(timestamp) ?? null;
  }

  /**
   * True when the decoder is at or just behind `sourceFrame`, so getting there
   * is a short forward walk rather than a keyframe restart.
   */
  canReachCheaply(sourceFrame: number): boolean {
    if (!this.reader || this.shownFrame < 0) return false;
    return sourceFrame >= this.shownFrame && sourceFrame - this.shownFrame <= MAX_WALK_FRAMES;
  }

  private settleFrame = -1;
  private settleSince = 0;

  /**
   * Reposition after a jump, but only once the playhead has stayed put.
   *
   * Going backwards means restarting at a keyframe and decoding up to it;
   * doing that on every step of a backwards drag kept the decoder restarting
   * and fought the element's own seeks for the hardware - measured, the
   * picture was right 1% of the time. Once the playhead rests, catching up
   * costs nothing anyone waits for, and the next forward drag is cheap.
   */
  requestWhenSettled(sourceFrame: number, now: number): void {
    if (sourceFrame !== this.settleFrame) {
      this.settleFrame = sourceFrame;
      this.settleSince = now;
      return;
    }
    if (now - this.settleSince >= SETTLE_MS) this.request(sourceFrame);
  }

  /** Head for `sourceFrame`. Resolves nothing; `onFrame` fires when it lands. */
  request(sourceFrame: number): void {
    if (this.failed || this.closed) return;
    this.wanted = sourceFrame;
    if (!this.reader) {
      const started = performance.now();
      this.opening ??= SequentialVideoReader.open(this.uri)
        .then((reader) => {
          if (this.closed) reader?.close();
          else if (reader) {
            this.reader = reader;
            console.info(`[scrub] forward decoder ready for ${this.uri} in ${Math.round(performance.now() - started)} ms`);
          } else {
            this.failed = true;
            // Said, not swallowed: a file that silently scrubs on the slow
            // path is indistinguishable from a slow machine.
            console.info(`[scrub] no forward decoder for ${this.uri} after ${Math.round(performance.now() - started)} ms; seeking instead`);
          }
        })
        .catch((error: unknown) => {
          this.failed = true;
          console.info(`[scrub] opening the forward decoder failed after ${Math.round(performance.now() - started)} ms: ${String(error)}`);
        })
        .finally(() => {
          if (this.reader) void this.pump();
        });
      return;
    }
    void this.pump();
  }

  /**
   * Decode the stretch just behind `sourceFrame` in the background, keeping
   * every frame, so a drag heading that way finds them already there. One fill
   * at a time; a drag that outruns it starts the next one when this finishes.
   */
  fillBehind(sourceFrame: number): void {
    if (this.failed || this.closed || this.filling || !this.reader) return;
    if (this.previews?.has(this.reader.timestampFor(sourceFrame, this.fps))) return;

    const from = Math.max(0, sourceFrame - FILL_BEHIND_FRAMES);
    this.filling = this.fill(from, sourceFrame)
      .catch(() => {
        // A filler that fails only means going back is as slow as it was.
        this.filler?.close();
        this.filler = null;
      })
      .finally(() => {
        this.filling = null;
      });
  }

  private async fill(from: number, to: number): Promise<void> {
    this.filler ??= await SequentialVideoReader.open(this.uri);
    const filler = this.filler;
    if (!filler || this.closed) return;

    // Landing on `from` restarts at the keyframe before it; walking on to `to`
    // decodes everything in between. Every frame passed is kept.
    this.keep(await filler.frameAt(from, this.fps, this.keep));
    if (this.closed) return;
    this.keep(await filler.frameAt(to, this.fps, this.keep));
    this.onFrame();
  }

  /** Copy a decoded frame into a kept small picture. Synchronous: the frame is closed right after. */
  private readonly keep = (frame: VideoFrame): void => {
    if (this.closed || typeof OffscreenCanvas === 'undefined') return;
    const sourceWidth = frame.displayWidth;
    const sourceHeight = frame.displayHeight;
    if (!sourceWidth || !sourceHeight) return;

    if (!this.canvas || !this.context) {
      const width = Math.min(PREVIEW_WIDTH, sourceWidth);
      const height = Math.max(2, Math.round((width * sourceHeight) / sourceWidth / 2) * 2);
      this.canvas = new OffscreenCanvas(width, height);
      this.context = this.canvas.getContext('2d');
      this.previews = new PreviewFrameCache<ImageBitmap>(previewCapacity(width, height));
    }
    if (!this.context || !this.previews) return;

    this.context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    this.previews.put(frame.timestamp, this.canvas.transferToImageBitmap(), this.focus);
  };

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.closed && this.reader && this.wanted >= 0 && this.wanted !== this.shownFrame) {
        const target = this.wanted;
        const frame = await this.reader.frameAt(target, this.fps, this.keep);
        if (this.closed) return;
        this.keep(frame);
        // Clone: the reader closes its own copy when it moves on, and the
        // viewport may still be about to draw this one.
        this.shown?.close();
        this.shown = frame.clone();
        this.shownFrame = target;
        this.onFrame();
      }
    } catch (error) {
      // Closed on purpose (playback started, the clip left the view): not a
      // failure of the file, and nothing to report.
      if (this.closed) return;
      // A decoder that fails leaves scrubbing to the seek path, as before.
      console.info(`[scrub] forward decoder failed at frame ${this.wanted}: ${String(error)}; seeking instead`);
      this.failed = true;
      this.reader?.close();
      this.reader = null;
    } finally {
      this.busy = false;
    }
  }

  close(): void {
    this.closed = true;
    this.reader?.close();
    this.reader = null;
    this.filler?.close();
    this.filler = null;
    this.shown?.close();
    this.shown = null;
    this.shownFrame = -1;
    this.previews?.clear();
    this.previews = null;
    this.canvas = null;
    this.context = null;
  }
}
