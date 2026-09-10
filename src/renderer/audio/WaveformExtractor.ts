/**
 * Async PCM peak computation for timeline waveforms.
 *
 * The timeline never draws raw samples: it draws a min/max pair per horizontal
 * pixel bucket. Computing those peaks once per asset and caching them is what
 * keeps a 100-clip timeline responsive.
 */

export interface WaveformPeaks {
  /** Interleaved [min, max] pairs, one pair per bucket. */
  peaks: Float32Array;
  bucketCount: number;
  durationSeconds: number;
  sampleRate: number;
}

/**
 * Reduce a mono/interleaved channel set to min/max peaks.
 *
 * Pure and synchronous so it can run inside a worker or a test without an
 * `AudioContext`.
 */
export function computePeaks(
  channels: ArrayLike<number>[],
  bucketCount: number,
): Float32Array {
  if (bucketCount <= 0) throw new RangeError('bucketCount must be positive');

  const peaks = new Float32Array(bucketCount * 2);
  const length = channels[0]?.length ?? 0;
  if (length === 0) return peaks;

  const samplesPerBucket = length / bucketCount;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * samplesPerBucket);
    const end = Math.min(length, Math.max(start + 1, Math.floor((bucket + 1) * samplesPerBucket)));

    let min = 1;
    let max = -1;

    for (const channel of channels) {
      for (let i = start; i < end; i += 1) {
        const sample = channel[i];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
    }

    peaks[bucket * 2] = min > max ? 0 : min;
    peaks[bucket * 2 + 1] = min > max ? 0 : max;
  }

  return peaks;
}

/** Block RMS envelope, used as the sidechain input for auto-ducking. */
export function computeRmsEnvelope(
  samples: ArrayLike<number>,
  blockSize: number,
): Float32Array {
  if (blockSize <= 0) throw new RangeError('blockSize must be positive');

  const blocks = Math.ceil(samples.length / blockSize);
  const envelope = new Float32Array(blocks);

  for (let block = 0; block < blocks; block += 1) {
    const start = block * blockSize;
    const end = Math.min(samples.length, start + blockSize);

    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    envelope[block] = Math.sqrt(sum / Math.max(1, end - start));
  }

  return envelope;
}

export class WaveformExtractor {
  private readonly cache = new Map<string, WaveformPeaks>();
  private readonly pending = new Map<string, Promise<WaveformPeaks>>();

  constructor(private readonly context: BaseAudioContext = new OfflineAudioContext(1, 1, 44100)) {}

  get(uri: string): WaveformPeaks | undefined {
    return this.cache.get(uri);
  }

  /**
   * Decode `data` and reduce it to `bucketCount` peaks.
   *
   * Decoding is offloaded to the browser decoder, so this yields to the event
   * loop rather than blocking the render thread.
   */
  async extract(uri: string, data: ArrayBuffer, bucketCount = 2048): Promise<WaveformPeaks> {
    const cached = this.cache.get(uri);
    if (cached && cached.bucketCount === bucketCount) return cached;

    const inFlight = this.pending.get(uri);
    if (inFlight) return inFlight;

    const request = (async (): Promise<WaveformPeaks> => {
      const buffer = await this.context.decodeAudioData(data.slice(0));
      const channels: Float32Array[] = [];
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        channels.push(buffer.getChannelData(channel));
      }

      const result: WaveformPeaks = {
        peaks: computePeaks(channels, bucketCount),
        bucketCount,
        durationSeconds: buffer.duration,
        sampleRate: buffer.sampleRate,
      };

      this.cache.set(uri, result);
      return result;
    })().finally(() => {
      this.pending.delete(uri);
    });

    this.pending.set(uri, request);
    return request;
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }
}
