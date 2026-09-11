import { SequentialVideoReader } from './SequentialVideoReader';

/**
 * Pictures for a paused, scrubbed playhead, decoded forwards.
 *
 * Seeking a `<video>` costs 110-150 ms on a screen recording with a keyframe
 * every few seconds, measured - the picture followed a dragged playhead at
 * about 7 updates a second. Dragging forwards, the next frame is a few
 * milliseconds away for a decoder that is already there, so this keeps one
 * per clip positioned at the playhead and lets it walk forwards.
 *
 * It only answers what it can answer cheaply (`canReachCheaply`): going back,
 * or jumping past a keyframe, would mean decoding a whole GOP, which is slower
 * than a seek. Those still seek the element, and this catches up behind it so
 * the next forward drag is cheap again.
 */

/** Beyond this many frames ahead, a forward jump is left to a seek. */
const MAX_WALK_FRAMES = 45;

/** How long the playhead must rest before the decoder follows a jump. */
const SETTLE_MS = 150;

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

  constructor(
    private readonly uri: string,
    private readonly fps: number,
    private readonly onFrame: () => void,
  ) {}

  /** The picture for `sourceFrame`, if this decoder has it right now. */
  frameFor(sourceFrame: number): VideoFrame | null {
    return this.shownFrame === sourceFrame ? this.shown : null;
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
      this.opening ??= SequentialVideoReader.open(this.uri)
        .then((reader) => {
          if (this.closed) reader?.close();
          else if (reader) this.reader = reader;
          else this.failed = true;
        })
        .catch(() => {
          this.failed = true;
        })
        .finally(() => {
          if (this.reader) void this.pump();
        });
      return;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.closed && this.reader && this.wanted >= 0 && this.wanted !== this.shownFrame) {
        const target = this.wanted;
        const frame = await this.reader.frameAt(target, this.fps);
        if (this.closed) return;
        // Clone: the reader closes its own copy when it moves on, and the
        // viewport may still be about to draw this one.
        this.shown?.close();
        this.shown = frame.clone();
        this.shownFrame = target;
        this.onFrame();
      }
    } catch {
      // A decoder that fails leaves scrubbing to the seek path, as before.
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
    this.shown?.close();
    this.shown = null;
    this.shownFrame = -1;
  }
}
