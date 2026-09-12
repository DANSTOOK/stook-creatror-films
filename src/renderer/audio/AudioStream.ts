import { parseMoovAudio, readLayout, type Mp4AudioTrack, type Mp4Sample } from '@renderer/engine/mp4';
import { fileSize, rangeReader } from '@renderer/engine/rangeFetch';

/**
 * Audio decoded as it is needed, instead of all of it at once.
 *
 * Playback used to hold every source as one `AudioBuffer`: 45 minutes of
 * stereo is about a gigabyte of Float32, and it was the largest thing in the
 * page by far. This keeps ONE decoder per file running forwards, hands out
 * spans as it passes them, and remembers only a window around the playhead -
 * about 11 MB instead of a gigabyte.
 *
 * It runs forwards, and starts either at the head or right next to what was
 * asked for, depending on where that is.
 *
 * Only the first few seconds of an AAC stream cannot be decoded from the
 * middle: measured against both the browser's own decode and ffmpeg, a
 * decode starting inside roughly the first 6 seconds differs audibly there
 * (as little as -28 dB against the signal, and more run-up does not help,
 * because the error is positional rather than a warm-up deficit), while one
 * starting at 6 s or beyond is bit-exact - checked at 6, 10, 20, 60, 300,
 * 900 and 1800 s, with byte-identical exports. So near the head it winds
 * from the head, which is cheap to reach; past that it starts where it is
 * wanted, which is what keeps a render from the 30th minute from having to
 * chew through 30 minutes of audio first.
 *
 * Only AAC in MP4 works this way (which is what `extractAudio` writes, and
 * what phones and cameras record). Anything else - a bare `.aac`, MP3, WAV,
 * FLAC, Opus - returns null from `open` and the caller decodes it whole, as
 * before.
 */

/** Decoded audio kept around the playhead. 30 s of 48 kHz stereo is ~11 MB. */
const WINDOW_SECONDS = 30;

/**
 * How much of the window sits BEHIND the playhead.
 *
 * Going back further than this restarts the decoder at the head of the file,
 * which costs real time (about 3.7 s to reach minute 40, decoding at ~650x).
 * Ten seconds covers the small steps back that scrubbing and replaying a
 * line are made of, without holding the whole file.
 */
const KEEP_BEHIND_SECONDS = 10;

/**
 * Inside this much of the head, a decode has to start at the head.
 *
 * The boundary measured at 5-6 s on two different files; ten seconds leaves
 * room and costs about 20 ms to wind through.
 */
const NEAR_HEAD_SECONDS = 10;

/**
 * Further ahead than this and the decoder starts again next to the target
 * instead of being fed everything in between.
 */
const FAR_AHEAD_SECONDS = 30;

/** Samples in one AAC-LC frame, which is also its run-up length. */
const AAC_FRAME_SAMPLES = 1024;

/**
 * Samples of run-up AAC-LC hands back before the sound itself, which have to
 * be thrown away.
 *
 * It is a fact about the codec, not the container. A file written with an
 * edit list says so - `time` is then negative for those samples - but a
 * stream-copied track need not carry one, and the samples are there all the
 * same. `decodeAudioData` discards them either way, and everything in the
 * app is lined up against that, so this does too.
 */
const AAC_PRIMING_SAMPLES = AAC_FRAME_SAMPLES;

/**
 * Frames fed before a span that `decodeUncached` is asked for.
 *
 * Only a nicety there: it does NOT make a mid-stream decode match one from
 * the head. That was measured - two frames and twenty-three frames of
 * run-up gave the same difference - which is why everything that has to be
 * exact goes through the forward decoder instead.
 */
const LEAD_IN_FRAMES = 8;

/** Chunks allowed to wait in the decoder at once. */
const MAX_QUEUE = 8;

/** No output for this long means the decoder is stuck. */
const STALL_MS = 8000;

/** Bytes fetched per read; audio frames are small and consecutive. */
const READ_WINDOW = 1024 * 1024;

/** Decoded, planar, at the file's own sample rate. */
export interface DecodedSpan {
  /** One Float32Array per channel. */
  planes: Float32Array[];
  sampleRate: number;
  channels: number;
  /** Sound time of the first sample, in seconds. */
  startSeconds: number;
}

/** One decoded frame, at an absolute sample position in sound time. */
interface DecodedFrame {
  at: number;
  planes: Float32Array[];
}

export class AudioStream {
  /** Samples in presentation order; AAC stores them in order already. */
  private readonly samples: Mp4Sample[];

  private buffer: Uint8Array | null = null;
  private bufferStart = 0;
  private readonly read: ReturnType<typeof rangeReader>;

  /**
   * Seconds of codec run-up in front of the sound, to skip over.
   *
   * Zero when the container already accounts for it - the edit list puts
   * those samples before time zero, so the first sample's `time` is negative
   * - and one AAC frame when it does not. See AAC_PRIMING_SAMPLES.
   */
  private readonly primingSeconds: number;
  private readonly primingSamples: number;

  /* The forward decoder and what it has produced. */
  private decoder: AudioDecoder | null = null;
  private frames: DecodedFrame[] = [];
  private heldSamples = 0;
  private nextFeed = 0;
  private fedCount = 0;
  private decodedUntil = 0;
  private endReached = false;
  /** -1024 when the decoder started at the head, 0 when it started mid-stream. */
  private labelShift = -AAC_FRAME_SAMPLES;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  /** Serialises `ensure`, so two spans never feed the decoder at once. */
  private pumping: Promise<void> | null = null;

  private constructor(
    url: string,
    private readonly track: Mp4AudioTrack,
  ) {
    this.samples = track.samples;
    this.read = rangeReader(url);
    this.primingSeconds = this.samples[0].time < 0 ? 0 : AAC_PRIMING_SAMPLES / track.sampleRate;
    this.primingSamples = Math.round(this.primingSeconds * track.sampleRate);
  }

  get sampleRate(): number {
    return this.track.sampleRate;
  }

  get channels(): number {
    return this.track.channels;
  }

  /** Seconds of sound, priming excluded. */
  get duration(): number {
    const last = this.samples[this.samples.length - 1];
    return Math.max(0, last.time + last.duration - this.primingSeconds);
  }

  /** Decoded audio held right now, in bytes. */
  get heldBytes(): number {
    return this.heldSamples * this.track.channels * 4;
  }

  /**
   * What this stream decided about the file, for the comparison harness to
   * report. An offset between this and the browser's own decode is always
   * one of these numbers being wrong, so they are worth printing rather than
   * inferring from the audio.
   */
  debugInfo(): {
    sampleRate: number;
    channels: number;
    sampleCount: number;
    firstSampleTime: number;
    secondSampleTime: number;
    primingSeconds: number;
    duration: number;
    heldSeconds: number;
    decodedUntilSeconds: number;
  } {
    return {
      sampleRate: this.track.sampleRate,
      channels: this.track.channels,
      sampleCount: this.samples.length,
      firstSampleTime: this.samples[0].time,
      secondSampleTime: this.samples[1]?.time ?? NaN,
      primingSeconds: this.primingSeconds,
      duration: this.duration,
      heldSeconds: this.heldSamples / this.track.sampleRate,
      decodedUntilSeconds: this.decodedUntil / this.track.sampleRate,
    };
  }

  /** A stream for `url`, or null when the file has to be decoded whole. */
  static async open(url: string): Promise<AudioStream | null> {
    if (typeof AudioDecoder === 'undefined' || !url.startsWith('media:')) return null;

    try {
      const size = await fileSize(url);
      // Fragments too: a fragmented file's moov alone lists no samples.
      const layout = await readLayout(rangeReader(url), size);
      const track = layout ? parseMoovAudio(layout.moov, layout.fragments) : null;
      if (!track || track.samples.length === 0) return null;

      const support = await AudioDecoder.isConfigSupported({
        codec: track.codec,
        sampleRate: track.sampleRate,
        numberOfChannels: track.channels,
        description: track.description,
      }).catch(() => null);
      if (!support?.supported) return null;

      return new AudioStream(url, track);
    } catch {
      return null;
    }
  }

  private async bytes(sample: Mp4Sample): Promise<Uint8Array> {
    const end = sample.offset + sample.size;
    if (!this.buffer || sample.offset < this.bufferStart || end > this.bufferStart + this.buffer.byteLength) {
      this.bufferStart = sample.offset;
      this.buffer = await this.read(sample.offset, Math.max(READ_WINDOW, sample.size));
    }
    const at = sample.offset - this.bufferStart;
    return this.buffer.subarray(at, at + sample.size);
  }

  /** First sample index whose sound reaches `seconds`. */
  private indexAt(seconds: number): number {
    let low = 0;
    let high = this.samples.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.samples[mid].time + this.samples[mid].duration <= seconds) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private notify(): void {
    const resume = this.wake;
    this.wake = null;
    resume?.();
  }

  private waitForDecoder(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        reject(new Error('audio decoder stalled'));
      }, STALL_MS);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Start (or restart) the decoder so that `fromSeconds` is reached.
   *
   * Near the head that means the head itself, which is the only start that
   * reproduces the browser's own decode there. Past NEAR_HEAD_SECONDS it
   * starts a few frames before what was asked for, which is bit-exact and
   * saves winding through everything in front of it.
   */
  private startAt(fromSeconds: number): void {
    this.closeDecoder();
    this.frames = [];
    this.heldSamples = 0;
    this.fedCount = 0;
    this.endReached = false;
    this.failure = null;

    const { sampleRate, channels } = this.track;

    // Where to begin feeding, in sample-table terms.
    const fileFrom = Math.max(0, fromSeconds) + this.primingSeconds;
    const start =
      fromSeconds < NEAR_HEAD_SECONDS
        ? 0
        : Math.max(0, this.indexAt(fileFrom) - LEAD_IN_FRAMES);

    this.nextFeed = start;
    // Labels run one frame ahead of content only when starting at the head.
    this.labelShift = start === 0 ? -AAC_FRAME_SAMPLES : 0;
    // Everything before the first frame fed is simply not held.
    this.decodedUntil =
      start === 0
        ? 0
        : Math.max(0, Math.round(this.samples[start].time * sampleRate) - this.primingSamples);
    this.decoder = new AudioDecoder({
      output: (data) => {
        try {
          // The decoder's labels run one frame ahead of its content when it
          // starts at the head, and sound time starts after the priming.
          const at =
            Math.round((data.timestamp / 1e6) * sampleRate) + this.labelShift - this.primingSamples;
          const count = data.numberOfFrames;

          // Entirely run-up: nothing of it belongs to the sound.
          if (at + count > 0) {
            const planes: Float32Array[] = [];
            for (let channel = 0; channel < channels; channel += 1) {
              const plane = new Float32Array(count);
              if (channel < data.numberOfChannels) {
                data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
              }
              planes.push(plane);
            }
            this.frames.push({ at, planes });
            this.heldSamples += count;
            this.decodedUntil = Math.max(this.decodedUntil, at + count);
          }
        } catch (error) {
          this.failure = error instanceof Error ? error : new Error(String(error));
        } finally {
          data.close();
          this.notify();
        }
      },
      error: (error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.notify();
      },
    });
    this.decoder.addEventListener('dequeue', () => this.notify());
    this.decoder.configure({
      codec: this.track.codec,
      sampleRate,
      numberOfChannels: channels,
      description: this.track.description,
    });
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }

  /** Decode forward until `untilSample` is covered, or the file ends. */
  private async ensure(untilSample: number): Promise<void> {
    while (this.pumping) await this.pumping.catch(() => undefined);

    const work = (async () => {
      if (!this.decoder) this.startAt(0);
      const decoder = this.decoder as AudioDecoder;

      while (this.decodedUntil < untilSample && !this.endReached) {
        if (this.failure) throw this.failure;

        if (this.nextFeed >= this.samples.length) {
          await decoder.flush();
          this.endReached = true;
          break;
        }

        if (decoder.decodeQueueSize < MAX_QUEUE) {
          const sample = this.samples[this.nextFeed];
          this.nextFeed += 1;
          const data = await this.bytes(sample);
          if (decoder.state !== 'configured') break;
          decoder.decode(
            new EncodedAudioChunk({
              // Only the first frame opens the sequence; AAC frames after it
              // continue one, since each is built on an overlap with the last.
              type: this.fedCount === 0 ? 'key' : 'delta',
              timestamp: Math.round(sample.time * 1e6),
              duration: Math.round(sample.duration * 1e6),
              data,
            }),
          );
          this.fedCount += 1;
          continue;
        }

        await this.waitForDecoder();
      }

      if (this.failure) throw this.failure;
    })();

    this.pumping = work.finally(() => {
      this.pumping = null;
    });
    await this.pumping;
  }

  /** Forget decoded frames that sit further back than the window keeps. */
  private trim(keepFromSample: number): void {
    const limit = WINDOW_SECONDS * this.track.sampleRate;
    while (
      this.frames.length > 1 &&
      this.heldSamples > limit &&
      this.frames[0].at + this.frames[0].planes[0].length <= keepFromSample
    ) {
      const dropped = this.frames.shift() as DecodedFrame;
      this.heldSamples -= dropped.planes[0].length;
    }
  }

  /**
   * The sound in `[fromSeconds, fromSeconds + seconds)`.
   *
   * Decodes forward to reach it, and restarts from the head when asked for
   * something older than the window still holds.
   */
  async span(fromSeconds: number, seconds: number): Promise<DecodedSpan> {
    const { sampleRate, channels } = this.track;
    const from = Math.max(0, fromSeconds);
    const wantFrom = Math.round(from * sampleRate);
    const length = Math.max(1, Math.round(seconds * sampleRate));
    const wantTo = wantFrom + length;

    // Start again when what is wanted sits behind what is still held, or so
    // far ahead that feeding everything in between would cost more than
    // starting next to it. An empty window with a live decoder means it is
    // simply still working towards the first frames.
    const behind = this.frames.length > 0 && wantFrom < this.frames[0].at;
    const farAhead = wantFrom > this.decodedUntil + FAR_AHEAD_SECONDS * sampleRate;
    if (!this.decoder || behind || farAhead) this.startAt(from);

    await this.ensure(wantTo);

    const planes = Array.from({ length: channels }, () => new Float32Array(length));
    for (const frame of this.frames) {
      const count = frame.planes[0].length;
      const overlapFrom = Math.max(wantFrom, frame.at);
      const overlapTo = Math.min(wantTo, frame.at + count);
      if (overlapTo <= overlapFrom) continue;

      for (let channel = 0; channel < channels; channel += 1) {
        planes[channel].set(
          frame.planes[channel].subarray(overlapFrom - frame.at, overlapTo - frame.at),
          overlapFrom - wantFrom,
        );
      }
    }

    this.trim(wantFrom - KEEP_BEHIND_SECONDS * sampleRate);
    return { planes, sampleRate, channels, startSeconds: wantFrom / sampleRate };
  }

  /**
   * One range, decoded on its own, with nothing kept.
   *
   * Faster to reach a far-off moment than winding the forward decoder there,
   * but NOT exact: started mid-stream it can differ from the real decode by
   * around -28 dB against the signal near some positions. Only for sound
   * short enough that a moment of roughness does not matter - a scrub grain
   * far from the window - never for playback or export.
   */
  async decodeUncached(
    fromSeconds: number,
    seconds: number,
    /** Set by the comparison harness to record what the decoder handed back. */
    trace?: { timestamp: number; frames: number; level: number; at: number; kept: number }[],
  ): Promise<Float32Array[]> {
    const { sampleRate, channels } = this.track;
    const length = Math.max(0, Math.round(seconds * sampleRate));
    const planes = Array.from({ length: channels }, () => new Float32Array(length));
    if (length === 0) return planes;

    const fileFrom = fromSeconds + this.primingSeconds;
    const firstSample = Math.round(fileFrom * sampleRate);
    const endSeconds = fileFrom + seconds;
    const start = Math.max(0, this.indexAt(fileFrom) - LEAD_IN_FRAMES);
    const labelShift = start === 0 ? -AAC_FRAME_SAMPLES : 0;
    const feedUntilSeconds = endSeconds - labelShift / sampleRate;

    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };

    const decoder = new AudioDecoder({
      output: (data) => {
        try {
          const at = Math.round((data.timestamp / 1e6) * sampleRate) - firstSample + labelShift;
          const count = data.numberOfFrames;
          const from = Math.max(0, -at);
          const to = Math.min(count, length - at);

          if (trace) {
            const whole = new Float32Array(count);
            data.copyTo(whole, { planeIndex: 0, format: 'f32-planar' });
            let sum = 0;
            for (let i = 0; i < count; i += 1) sum += Math.abs(whole[i]);
            trace.push({
              timestamp: data.timestamp,
              frames: count,
              level: sum / Math.max(1, count),
              at,
              kept: Math.max(0, to - from),
            });
          }

          if (to > from) {
            for (let channel = 0; channel < channels && channel < data.numberOfChannels; channel += 1) {
              const plane = new Float32Array(count);
              data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
              planes[channel].set(plane.subarray(from, to), at + from);
            }
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        } finally {
          data.close();
          notify();
        }
      },
      error: (error) => {
        failure = error instanceof Error ? error : new Error(String(error));
        notify();
      },
    });
    decoder.addEventListener('dequeue', notify);
    decoder.configure({
      codec: this.track.codec,
      sampleRate,
      numberOfChannels: channels,
      description: this.track.description,
    });

    let fed = 0;
    try {
      for (let index = start; index < this.samples.length; index += 1) {
        const sample = this.samples[index];
        if (sample.time >= feedUntilSeconds) break;

        while (decoder.decodeQueueSize > MAX_QUEUE && !failure) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (failure) throw failure;

        decoder.decode(
          new EncodedAudioChunk({
            type: fed === 0 ? 'key' : 'delta',
            timestamp: Math.round(sample.time * 1e6),
            duration: Math.round(sample.duration * 1e6),
            data: await this.bytes(sample),
          }),
        );
        fed += 1;
      }

      await decoder.flush();
      if (failure) throw failure;
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }

    return planes;
  }

  /** Everything decoded is dropped; the tables stay. */
  close(): void {
    this.closeDecoder();
    this.frames = [];
    this.heldSamples = 0;
    this.decodedUntil = 0;
    this.nextFeed = 0;
    this.fedCount = 0;
    this.endReached = false;
    this.buffer = null;
    this.notify();
  }
}
