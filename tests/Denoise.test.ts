import { describe, expect, it } from 'vitest';
import { denoiseArgs, noiseFloorDb } from '../src/main/media/denoise';

describe('reduce noise', () => {
  it('the floor is the level of the quietest tenth: the pauses, not the voice', () => {
    const rate = 8000;
    const samples = new Float32Array(rate * 4);
    let seed = 7;
    for (let i = 0; i < samples.length; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const hiss = ((seed / 2147483648) * 2 - 1) * 0.01;
      // A loud tone for the first three seconds, the hiss alone after.
      samples[i] = hiss + (i < rate * 3 ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate) : 0);
    }
    const floor = noiseFloorDb(samples, rate);
    // White noise of amplitude 0.01 is about -45 dBFS.
    expect(floor).toBeGreaterThan(-50);
    expect(floor).toBeLessThan(-40);
  });

  it('afftdn is told the measured floor, a little above it, and how far to pull it down', () => {
    const args = denoiseArgs('in.mp4', 'out.m4a', 'strong', -45);
    const filter = args[args.indexOf('-af') + 1];
    expect(filter).toBe('highpass=f=80,afftdn=nr=28:nf=-42');
    // Never told a floor louder than -20 dB, whatever was measured.
    expect(denoiseArgs('a', 'b', 'light', -5)[denoiseArgs('a', 'b', 'light', -5).indexOf('-af') + 1]).toContain('nf=-20');
  });
});
