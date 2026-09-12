import { parseMoovAudio, readMoov, type Mp4AudioTrack, type Mp4Sample } from '@renderer/engine/mp4';
import { fileSize, rangeReader } from '@renderer/engine/rangeFetch';

/**
 * Audio decoded a few seconds at a time, instead of all of it at once.
 *
 * Playback used to hold every source as one `AudioBuffer`: 45 minutes of
 * stereo is about a gigabyte of Float32, and it was the largest thing in the
 * page by far. This decodes the span that is actually wanted - for playback
 * just ahead of the playhead, for a scrub grain the 85 ms under it, for an
 * export the range being rendered - with a WebCodecs `AudioDecoder`, keeps a
 * bounded cache of recent spans, and forgets the rest.
 *
 * Only AAC in MP4 works this way (which is what `extractAudio` writes, and
 * what phones and cameras record). Anything else - a bare `.aac`, MP3, WAV,
 * FLAC, Opus - returns null from `open` and the caller decodes it whole, as
 * before.
 */

/** Span of audio decoded and cached as a unit. */
const CHUNK_SECONDS = 4;

/** How much decoded audio to keep. 96 MB is ~4 minutes of 48 kHz stereo. */
const CACHE_BYTES = 96 * 1024 * 1024;

/**
 * Frames fed before the wanted span, so the decoder is warm when it reaches
 * it. AAC frames each decode on their own, but a decoder started mid-stream
 * needs run-up through its filter bank before it reproduces samples exactly.
 * Measured against the browser's own decode of the same file: with two
 * frames, a span starting mid-stream still differed from it by about a tenth
 * of the signal near its start; with eight, it matches exactly. The extra
 * output is discarded by position, so the only cost is a little decoding.
 */
const LEAD_IN_FRAMES = 8;

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

/** Bytes fetched per read; audio frames are small and consecutive. */
const READ_WINDOW = 1024 * 1024;

/** Decoded, planar, at the file's own sample rate. */
export interface DecodedSpan {
  /** One Float32Array per channel. */
  planes: Float32Array[];
  sampleRate: number;
  channels: number;
  /** File time of the first sample, in seconds. */
  startSeconds: number;
}

interface CacheEntry {
  planes: Float32Array[];
  bytes: number;
  lastUsed: number;
}

export class AudioStream {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly pending = new Map<number, Promise<Float32Array[]>>();
  private tick = 0;
  private cachedBytes = 0;

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

  private constructor(
    url: string,
    private readonly track: Mp4AudioTrack,
  ) {
    this.samples = track.samples;
    this.read = rangeReader(url);
    this.primingSeconds =
      this.samples[0].time < 0 ? 0 : AAC_PRIMING_SAMPLES / track.sampleRate;
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
  } {
    return {
      sampleRate: this.track.sampleRate,
      channels: this.track.channels,
      sampleCount: this.samples.length,
      firstSampleTime: this.samples[0].time,
      secondSampleTime: this.samples[1]?.time ?? NaN,
      primingSeconds: this.primingSeconds,
      duration: this.duration,
    };
  }

  /** A stream for `url`, or null when the file has to be decoded whole. */
  static async open(url: string): Promise<AudioStream | null> {
    if (typeof AudioDecoder === 'undefined' || !url.startsWith('media:')) return null;

    try {
      const size = await fileSize(url);
      const moov = await readMoov(rangeReader(url), size);
      const track = moov ? parseMoovAudio(moov) : null;
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

  /**
   * Decode `[fromSeconds, fromSeconds + seconds)` into planar channels,
   * without touching the chunk cache.
   *
   * Samples before the start - the encoder's priming and the lead-in frames -
   * are decoded and dropped, so the result begins exactly where asked. An
   * export wants exactly this: one arbitrary range, decoded once, nothing
   * kept afterwards.
   */
  async decodeUncached(
    fromSeconds: number,
    seconds: number,
    /**
     * Set by the comparison harness to record what the decoder handed back,
     * output by output. Which output carries which timestamp, and which one
     * holds the codec's warm-up, cannot be reasoned about reliably - it has
     * to be looked at. Nothing is recorded when this is left out.
     */
    trace?: {
      timestamp: number;
      frames: number;
      level: number;
      at: number;
      kept: number;
    }[],
  ): Promise<Float32Array[]> {
    const { sampleRate, channels } = this.track;
    const length = Math.max(0, Math.round(seconds * sampleRate));
    const planes = Array.from({ length: channels }, () => new Float32Array(length));
    if (length === 0) return planes;

    // Asked in sound time, read in file time: they differ by the priming.
    const fileFrom = fromSeconds + this.primingSeconds;
    const firstSample = Math.round(fileFrom * sampleRate);
    const endSeconds = fileFrom + seconds;
    const start = Math.max(0, this.indexAt(fileFrom) - LEAD_IN_FRAMES);

    /**
     * Starting at the head of the stream, the decoder's labels run one frame
     * ahead of its content.
     *
     * Measured, because two different readings of the spec each contradicted
     * the audio. Feeding from sample 0, the first output comes back stamped
     * at time zero but holding the codec's run-up (level 0.003 against a
     * signal of 0.05), and the output stamped one frame later holds what the
     * browser's own decode puts at zero. Started mid-stream, with frames
     * ahead of it to warm up on, labels and content agree exactly - so this
     * correction applies only when there was nothing earlier to feed.
     */
    const labelShift = start === 0 ? -AAC_FRAME_SAMPLES : 0;

    /**
     * How far to keep feeding, in LABEL time.
     *
     * Content sits `labelShift` behind its label, so filling the last frame
     * of the span needs the output labelled one frame past its end. Cutting
     * the feed at the span's own end left the final 1024 samples of the
     * first chunk empty - which showed up as the one window that straddled
     * the head chunk and the next being slightly off while every other
     * window matched exactly.
     */
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
          // Where this output sits in the file, in samples.
          const at = Math.round((data.timestamp / 1e6) * sampleRate) - firstSample + labelShift;
          const count = data.numberOfFrames;
          // Overlap with the wanted span.
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

    /**
     * Only the first frame fed may claim to be a key frame.
     *
     * AAC-LC frames are not independent: each output is built from an
     * overlap with the frame before it. MP4 marks them all as sync samples
     * (there is no `stss`), and passing that straight through - every chunk
     * declared `key` - gave audio that was in the right place, at the right
     * level, yet a little different from what the same decoder produces via
     * `decodeAudioData`, deterministically, for about a second after a
     * mid-stream start. Two independent decoders agreed with each other and
     * not with this, which is what pointed at the input rather than the
     * decoding. So: the first frame opens the sequence, the rest continue it.
     */
    let fed = 0;

    try {
      for (let index = start; index < this.samples.length; index += 1) {
        const sample = this.samples[index];
        if (sample.time >= feedUntilSeconds) break;

        while (decoder.decodeQueueSize > 8 && !failure) {
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

  private evict(): void {
    if (this.cachedBytes <= CACHE_BYTES) return;
    for (const [index, entry] of [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (this.cachedBytes <= CACHE_BYTES) break;
      this.cachedBytes -= entry.bytes;
      this.cache.delete(index);
    }
  }

  /** The decoded chunk `index` covers `[index * CHUNK, (index + 1) * CHUNK)`. */
  private async chunk(index: number): Promise<Float32Array[]> {
    const cached = this.cache.get(index);
    if (cached) {
      this.tick += 1;
      cached.lastUsed = this.tick;
      return cached.planes;
    }

    const inFlight = this.pending.get(index);
    if (inFlight) return inFlight;

    const request = this.decodeUncached(index * CHUNK_SECONDS, CHUNK_SECONDS)
      .then((planes) => {
        this.tick += 1;
        const bytes = planes.reduce((total, plane) => total + plane.byteLength, 0);
        this.cache.set(index, { planes, bytes, lastUsed: this.tick });
        this.cachedBytes += bytes;
        this.evict();
        return planes;
      })
      .finally(() => this.pending.delete(index));

    this.pending.set(index, request);
    return request;
  }

  /**
   * The sound in `[fromSeconds, fromSeconds + seconds)`, assembled from
   * cached chunks and decoding whatever is missing.
   */
  async span(fromSeconds: number, seconds: number): Promise<DecodedSpan> {
    const { sampleRate, channels } = this.track;
    const from = Math.max(0, fromSeconds);
    const length = Math.max(1, Math.round(seconds * sampleRate));
    const planes = Array.from({ length: channels }, () => new Float32Array(length));

    const firstChunk = Math.floor(from / CHUNK_SECONDS);
    const lastChunk = Math.floor(Math.max(from, from + seconds - 1 / sampleRate) / CHUNK_SECONDS);

    for (let index = firstChunk; index <= lastChunk; index += 1) {
      const chunk = await this.chunk(index);
      const chunkStart = Math.round(index * CHUNK_SECONDS * sampleRate);
      const wantedStart = Math.round(from * sampleRate);
      // Where this chunk overlaps the wanted span.
      const offsetInChunk = Math.max(0, wantedStart - chunkStart);
      const offsetInResult = Math.max(0, chunkStart - wantedStart);
      const count = Math.min(
        chunk[0].length - offsetInChunk,
        length - offsetInResult,
      );
      if (count <= 0) continue;

      for (let channel = 0; channel < channels; channel += 1) {
        planes[channel].set(
          chunk[channel].subarray(offsetInChunk, offsetInChunk + count),
          offsetInResult,
        );
      }
    }

    return { planes, sampleRate, channels, startSeconds: from };
  }

  /** Everything decoded so far is dropped; the tables stay. */
  clearCache(): void {
    this.cache.clear();
    this.pending.clear();
    this.cachedBytes = 0;
    this.buffer = null;
  }
}
