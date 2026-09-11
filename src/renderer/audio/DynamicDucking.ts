import type { DuckingParams } from '@shared/types';
import { DEFAULT_DUCKING } from '@shared/types';
import { clamp } from '@shared/utils/math';

/**
 * Sidechain compression ("auto ducking").
 *
 * The dialogue bus drives the gain of the music bus: when speech is present the
 * music is pulled down, and it recovers over the release time once speech stops.
 *
 * The envelope maths lives in a pure function so it can be unit tested and also
 * reused offline to bake a gain curve during export, where there is no realtime
 * audio graph to analyse.
 */

// The parameters are part of the saved project, so they are declared with the
// rest of the document schema; re-exported here because this is where they are
// interpreted.
export type { DuckingParams } from '@shared/types';
export { DEFAULT_DUCKING } from '@shared/types';

export const linearToDb = (linear: number): number =>
  20 * Math.log10(Math.max(linear, 1e-6));

export const dbToLinear = (db: number): number => 10 ** (db / 20);

/** One-pole smoothing coefficient for a given time constant. */
const smoothingCoefficient = (seconds: number, sampleRate: number): number =>
  seconds <= 0 ? 0 : Math.exp(-1 / (Math.max(seconds, 1e-4) * sampleRate));

/**
 * Compute the music-bus gain curve for a dialogue envelope.
 *
 * `sidechainEnvelope` holds linear amplitude samples (typically the per-block
 * RMS of the dialogue bus) at `sampleRate` samples per second. The result is a
 * linear gain multiplier per sample, in 0..1.
 */
export function computeDuckingEnvelope(
  sidechainEnvelope: ArrayLike<number>,
  sampleRate: number,
  params: DuckingParams = DEFAULT_DUCKING,
): Float32Array {
  const gains = new Float32Array(sidechainEnvelope.length);
  const attack = smoothingCoefficient(params.attackSeconds, sampleRate);
  const release = smoothingCoefficient(params.releaseSeconds, sampleRate);
  const floorGain = dbToLinear(-Math.abs(params.rangeDb));

  let current = 1;
  for (let i = 0; i < sidechainEnvelope.length; i += 1) {
    const levelDb = linearToDb(Math.abs(sidechainEnvelope[i]));
    // Above threshold ducks fully; the transition is smoothed by attack/release
    // rather than by a soft knee, which is what makes speech onsets audible.
    const target = levelDb > params.thresholdDb ? floorGain : 1;
    const coefficient = target < current ? attack : release;

    current = target + (current - target) * coefficient;
    gains[i] = clamp(current, floorGain, 1);
  }

  return gains;
}

/**
 * Realtime ducking: an analyser on the dialogue bus drives the music gain.
 *
 * Call `start()` once the audio graph exists; the follower runs on
 * `requestAnimationFrame` and writes to the music bus gain with short ramps so
 * the change is click-free.
 */
export class DynamicDucking {
  private readonly analyser: AnalyserNode;
  private readonly samples: Float32Array<ArrayBuffer>;
  private rafHandle: number | null = null;
  private currentGain = 1;

  constructor(
    private readonly context: AudioContext,
    dialogueBus: GainNode,
    private readonly musicGain: GainNode,
    public params: DuckingParams = DEFAULT_DUCKING,
  ) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    // Backed by a plain ArrayBuffer so it satisfies the Web Audio signature.
    this.samples = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    // An analyser is a pass-through node, so tapping the bus does not alter it.
    dialogueBus.connect(this.analyser);
  }

  private rms(): number {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i += 1) sum += this.samples[i] * this.samples[i];
    return Math.sqrt(sum / this.samples.length);
  }

  private step = (): void => {
    const levelDb = linearToDb(this.rms());
    const floorGain = dbToLinear(-Math.abs(this.params.rangeDb));
    const target = levelDb > this.params.thresholdDb ? floorGain : 1;

    const timeConstant =
      target < this.currentGain ? this.params.attackSeconds : this.params.releaseSeconds;

    this.currentGain = target;
    this.musicGain.gain.setTargetAtTime(target, this.context.currentTime, timeConstant / 3);

    this.rafHandle = requestAnimationFrame(this.step);
  };

  start(): void {
    if (this.rafHandle === null) this.rafHandle = requestAnimationFrame(this.step);
  }

  stop(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this.musicGain.gain.setTargetAtTime(1, this.context.currentTime, 0.05);
  }

  dispose(): void {
    this.stop();
    this.analyser.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Offline ducking                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Block size used to turn a rendered bus into a sidechain envelope.
 *
 * 128 samples is one render quantum: at 48 kHz that is 2.7 ms, short enough to
 * catch a speech onset and long enough that the envelope is a level rather than
 * a waveform.
 */
export const ENVELOPE_BLOCK = 128;

/**
 * Per-block RMS of a rendered signal, summed across channels.
 *
 * This is the offline equivalent of the realtime `AnalyserNode`: it is what the
 * dialogue bus "looks like" to the sidechain.
 */
export function blockRms(
  channels: readonly Float32Array[],
  block: number = ENVELOPE_BLOCK,
): Float32Array {
  const length = channels[0]?.length ?? 0;
  const blocks = Math.ceil(length / block);
  const envelope = new Float32Array(blocks);

  for (let index = 0; index < blocks; index += 1) {
    const start = index * block;
    const end = Math.min(start + block, length);
    let sum = 0;
    let count = 0;

    for (const channel of channels) {
      for (let i = start; i < end; i += 1) {
        sum += channel[i] * channel[i];
        count += 1;
      }
    }

    envelope[index] = count === 0 ? 0 : Math.sqrt(sum / count);
  }

  return envelope;
}

/**
 * Apply a per-block gain curve to a signal, in place.
 *
 * Gains are interpolated across each block rather than stepped: a gain that
 * jumps between blocks is a 366 Hz buzz at 48 kHz, which is a much worse
 * artefact than the ducking it is implementing.
 */
export function applyGainCurve(
  channels: readonly Float32Array[],
  gains: ArrayLike<number>,
  block: number = ENVELOPE_BLOCK,
): void {
  const length = channels[0]?.length ?? 0;

  for (let i = 0; i < length; i += 1) {
    const position = i / block;
    const index = Math.min(gains.length - 1, Math.floor(position));
    const next = Math.min(gains.length - 1, index + 1);
    const fraction = position - index;
    const gain = gains[index] + (gains[next] - gains[index]) * fraction;

    for (const channel of channels) channel[i] *= gain;
  }
}

/**
 * Bake the ducking curve for an offline mix.
 *
 * `music` is modified in place. Returns the smallest gain the curve reached, so
 * a caller can report whether ducking actually did anything - "enabled" and
 * "audible" are different claims.
 */
export function duckOffline(
  music: readonly Float32Array[],
  dialogue: readonly Float32Array[],
  sampleRate: number,
  params: DuckingParams = DEFAULT_DUCKING,
  block: number = ENVELOPE_BLOCK,
): number {
  const envelope = blockRms(dialogue, block);
  if (envelope.length === 0) return 1;

  const gains = computeDuckingEnvelope(envelope, sampleRate / block, params);
  applyGainCurve(music, gains, block);

  let lowest = 1;
  for (const gain of gains) if (gain < lowest) lowest = gain;
  return lowest;
}
