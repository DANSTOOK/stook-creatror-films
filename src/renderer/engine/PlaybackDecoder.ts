import { SequentialVideoReader } from './SequentialVideoReader';

/**
 * Pictures for a PLAYING playhead, decoded forwards and ahead of it.
 *
 * Playback drew whatever the `<video>` element happened to be showing. The
 * element keeps its own clock and its own pacing, and above 60 fps it does not
 * keep up: measured on this machine (tests/perf/viewer-rates), a 120 fps file
 * presented 114 frames a second and the element itself counted 29 of them
 * skipped in five seconds, on a 179 Hz screen with the draw costing 0.2 ms. The
 * frames were decoded and thrown away before anything could draw them.
 *
 * So above that rate the picture comes from here instead: one WebCodecs reader
 * per clip, walking the file forwards and keeping a few frames AHEAD of the
 * playhead, so the draw that wants frame N finds it already decoded rather
 * than waiting on it. The playhead stays the clock - the picture follows the
 * timeline, not the element's idea of time - which is also what keeps it with
 * the sound, since the sound is on the audio engine's clock and never on the
 * element's.
 *
 * Its own hardware decoder is the cost, so one of these exists only while
 * playback is actually using it, and the element is paused meanwhile rather
 * than left decoding the same file alongside.
 *
 * `ScrubDecoder` is the same idea for a paused, dragged playhead, and is a
 * different shape because of it: it decodes on demand, backwards as often as
 * forwards, and keeps small copies of what it passes for a drag coming back.
 * Playing only ever goes forwards, at a known rate, and needs nothing kept.
 */

/** Frames kept decoded past the playhead. Six is what the reader feeds at once. */
export const LOOKAHEAD = 6;

/**
 * Draws in a row that found no frame ready before the decoder gives up and
 * leaves the file to the element, for good.
 *
 * Not every file can be decoded at its own rate on every machine. Measured
 * here (tests/perf/viewer-rates): a 1080p 120 fps file decodes ahead of the
 * playhead and reaches the eye at 120 frames a second against the element's
 * 114, while a 4K 120 fps file does not keep up at all - one frame ready in
 * five seconds - and the element plays that one at 113. Without this the
 * viewer held the last decoded picture and the preview stood still, which is
 * far worse than the element being a few frames short. A sixth of a second at
 * 120 fps, so a decoder that is merely starting up is not given up on.
 */
export const MAX_LATE_IN_A_ROW = 20;

/**
 * How long a ready reader has to put its FIRST frame in front of the playhead
 * before it is given up on as well.
 *
 * The 4K 120 fps file never gets a frame ahead at all, so the rule above -
 * which only counts once something has been shown - would never fire, and the
 * decoder would sit there holding a hardware decoder and taking frames from
 * the element that is actually making the picture. Half a second is several
 * GOP-less frames' worth of chances at any rate this applies to.
 */
export const FIRST_FRAME_MS = 500;

/**
 * A gap this wide or wider is a jump, not playing: the decoder starts again
 * at the playhead instead of decoding its way there. Half a second at 120 fps,
 * and well past anything a dropped render frame leaves behind.
 */
export const MAX_CATCHUP_FRAMES = 60;

/**
 * What to do with a decoder holding `oldest`..`head` when the playhead asks
 * for `wanted`.
 *
 * `head` is the newest frame decoded and `oldest` the oldest still kept, both
 * -1 for a decoder that has not started. Reading ahead means `head` is NORMALLY
 * past the playhead, which is why going backwards is judged against `oldest`:
 * against `head` every ordinary draw looked like a jump back and restarted the
 * decoder on every frame.
 *
 * Pure, so the three cases are testable without a decoder: carry on, start
 * again at the playhead, or nothing to do because the read-ahead is full.
 */
export function playbackPlan(
  oldest: number,
  head: number,
  wanted: number,
  lookahead = LOOKAHEAD,
  maxCatchup = MAX_CATCHUP_FRAMES,
): { restart: boolean; decodeTo: number | null } {
  // Never started, gone back past what is held, or so far ahead that walking
  // there costs more than a keyframe restart.
  if (head < 0 || oldest < 0 || wanted < oldest || wanted - head >= maxCatchup) {
    return { restart: true, decodeTo: wanted };
  }
  const target = wanted + lookahead;
  return { restart: false, decodeTo: target > head ? target : null };
}

export class PlaybackDecoder {
  private reader: SequentialVideoReader | null = null;
  private opening: Promise<void> | null = null;
  private failed = false;
  private closed = false;
  private busy = false;

  /** Decoded frames at and ahead of the playhead, by source frame. */
  private readonly ahead = new Map<number, VideoFrame>();
  /** The newest frame decoded into `ahead`; -1 before anything is. */
  private head = -1;
  /** Where the playhead wants the decoder to be heading. */
  private wanted = -1;
  /** Set when the next pump must throw away what it has and start again. */
  private restartAt: number | null = null;

  /** Frames the playhead asked for and this had ready, and asked for and did not. */
  private hits = 0;
  private misses = 0;
  /** Draws in a row with nothing ready; see MAX_LATE_IN_A_ROW. */
  private lateInARow = 0;
  /** When the reader opened, which is when it starts being judged. */
  private readyAt: number | null = null;

  constructor(
    private readonly uri: string,
    private readonly fps: number,
    private readonly onFrame: () => void,
  ) {}

  /** The file this decodes; a decoder is only ever handed to a clip of the same one. */
  get sourceUri(): string {
    return this.uri;
  }

  /** True once the file has been found unreadable by WebCodecs; the element takes over. */
  get unusable(): boolean {
    return this.failed;
  }

  /**
   * How well the read-ahead kept up: what a test and the log read.
   * `ready` counts draws served a decoded frame, `late` the ones that had to
   * hold the previous picture or fall back to the element.
   */
  get counts(): { ready: number; late: number } {
    return { ready: this.hits, late: this.misses };
  }

  /**
   * The picture for `sourceFrame`, when it is decoded, and tell the decoder
   * where the playhead is so it keeps reading ahead of it.
   *
   * Called once per draw. The frame belongs to this decoder: upload it, do not
   * keep it - it is closed as the playhead moves past.
   */
  frameFor(sourceFrame: number): VideoFrame | null {
    if (this.closed || this.failed) return null;
    this.wanted = sourceFrame;

    const plan = playbackPlan(this.oldestKept, this.head, sourceFrame);
    if (plan.restart) this.restartAt = sourceFrame;
    this.start();

    const frame = this.ahead.get(sourceFrame) ?? null;
    if (frame) {
      this.hits += 1;
      // Everything the playhead has gone past: a frame held open is a decoder
      // buffer held with it, and a hardware decoder has only a few.
      for (const [at, old] of [...this.ahead]) {
        if (at < sourceFrame) {
          old.close();
          this.ahead.delete(at);
        }
      }
      this.lateInARow = 0;
      return frame;
    }
    this.misses += 1;
    if (this.hits > 0) {
      this.lateInARow += 1;
      if (this.lateInARow >= MAX_LATE_IN_A_ROW) this.giveUp(`${this.lateInARow} draws in a row with nothing ready`);
    } else if (this.readyAt !== null && performance.now() - this.readyAt > FIRST_FRAME_MS) {
      this.giveUp(`nothing ready in the first ${FIRST_FRAME_MS} ms`);
    }
    return null;
  }

  /** Leave this file to the element for good, and let go of the hardware decoder. */
  private giveUp(why: string): void {
    console.info(`[play] the forward decoder cannot keep up with ${this.uri} at ${this.fps} fps (${why}); the element plays it instead`);
    this.failed = true;
    this.drop();
    this.reader?.close();
    this.reader = null;
  }

  /**
   * The oldest frame still held, which is where "the playhead went back" is
   * measured from. With nothing held the decoder is behind the playhead
   * rather than ahead of it, and `head` is the honest answer: catching up
   * forwards is playing, not a jump.
   */
  private get oldestKept(): number {
    if (this.head < 0) return -1;
    let oldest = Infinity;
    for (const at of this.ahead.keys()) if (at < oldest) oldest = at;
    return Number.isFinite(oldest) ? oldest : this.head;
  }

  /** Open the reader if needed, then keep the read-ahead full. */
  private start(): void {
    if (this.failed || this.closed) return;
    if (!this.reader) {
      const started = performance.now();
      this.opening ??= SequentialVideoReader.open(this.uri)
        .then((reader) => {
          if (this.closed) reader?.close();
          else if (reader) {
            this.reader = reader;
            this.readyAt = performance.now();
            console.info(`[play] forward decoder ready for ${this.uri} in ${Math.round(performance.now() - started)} ms`);
          } else {
            this.failed = true;
            // Said, not swallowed: a 120 fps file silently on the element's
            // path looks exactly like a slow machine.
            console.info(`[play] no forward decoder for ${this.uri}; the element plays it instead`);
          }
        })
        .catch((error: unknown) => {
          this.failed = true;
          console.info(`[play] opening the forward decoder failed: ${String(error)}`);
        })
        .finally(() => {
          if (this.reader) void this.pump();
        });
      return;
    }
    void this.pump();
  }

  /** Throw away the read-ahead: a jump, or a decoder starting again. */
  private drop(): void {
    for (const frame of this.ahead.values()) frame.close();
    this.ahead.clear();
    this.head = -1;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        if (this.closed || !this.reader) return;

        if (this.restartAt !== null) {
          // A jump: what was decoded is of somewhere else. The reader
          // restarts itself at the keyframe before the frame asked for.
          this.restartAt = null;
          this.drop();
        }

        const plan = playbackPlan(this.oldestKept, this.head, this.wanted);
        const target = plan.restart ? this.wanted : plan.decodeTo;
        if (target === null || target < 0) return;

        const next = this.head < 0 || plan.restart ? target : this.head + 1;
        const frame = await this.reader.frameAt(next, this.fps);
        if (this.closed) return;
        // Clone: the reader closes its own copy as soon as it moves on, and
        // this one waits for a draw that has not happened yet.
        this.ahead.set(next, frame.clone());
        this.head = next;
        this.onFrame();
      }
    } catch (error) {
      if (this.closed) return;
      // A decoder that fails leaves playback to the element, as before.
      console.info(`[play] forward decoder failed at frame ${this.wanted}: ${String(error)}; the element plays it instead`);
      this.failed = true;
      this.drop();
      this.reader?.close();
      this.reader = null;
    } finally {
      this.busy = false;
    }
  }

  close(): void {
    this.closed = true;
    this.drop();
    this.reader?.close();
    this.reader = null;
  }
}
