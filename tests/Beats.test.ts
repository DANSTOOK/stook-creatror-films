import { describe, expect, it } from 'vitest';
import { BEAT_RATE, analyseBeats } from '../src/main/media/beats';

/** A drum loop in miniature: a kick on every beat at `bpm`, a softer hat between, over a quiet hum. */
function loop(bpm: number, seconds: number, offset = 0.1): Float32Array {
  const samples = new Float32Array(Math.round(BEAT_RATE * seconds));
  const beat = 60 / bpm;
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.02 * Math.sin((2 * Math.PI * 110 * i) / BEAT_RATE);
  for (let t = offset; t < seconds; t += beat / 2) {
    const kick = Math.round((t - offset) / beat * 2) % 2 === 0;
    const start = Math.round(t * BEAT_RATE);
    for (let i = 0; i < 2000 && start + i < samples.length; i += 1) {
      const decay = Math.exp(-i / (kick ? 400 : 120));
      samples[start + i] += (kick ? 0.8 * Math.sin((2 * Math.PI * 60 * i) / BEAT_RATE) : 0.25 * Math.sin(i * 1.7)) * decay;
    }
  }
  return samples;
}

describe('the beats of a piece of music', () => {
  for (const bpm of [90, 120, 128, 150]) {
    it(`finds ${bpm} beats a minute and lays the beats on the kicks`, () => {
      const result = analyseBeats(loop(bpm, 12));
      expect(Math.abs(result.bpm - bpm)).toBeLessThan(2);
      const beat = 60 / bpm;
      // Every beat within 30 ms of a kick.
      for (const time of result.beats) {
        const nearest = 0.1 + Math.round((time - 0.1) / beat) * beat;
        expect(Math.abs(time - nearest)).toBeLessThan(0.03);
      }
      expect(result.beats.length).toBeGreaterThan(Math.floor((12 - 0.2) / beat) - 2);
      expect(result.downbeats.length).toBeGreaterThan(0);
    });
  }
});
