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

export interface DuckingParams {
  /** Level above which ducking engages, in dBFS. */
  thresholdDb: number;
  /** How far the music is pulled down at full duck, in dB (positive number). */
  rangeDb: number;
  /** Seconds to reach full duck. */
  attackSeconds: number;
  /** Seconds to recover to unity. */
  releaseSeconds: number;
}

export const DEFAULT_DUCKING: DuckingParams = {
  thresholdDb: -32,
  rangeDb: 12,
  attackSeconds: 0.08,
  releaseSeconds: 0.45,
};

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
