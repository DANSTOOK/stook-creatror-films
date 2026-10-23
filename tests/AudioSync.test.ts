import { describe, expect, it } from 'vitest';
import { SYNC_RATE, alignCurves, onsetCurveOf } from '../src/main/media/audioSync';

/** Seconds of a room: noise at a low level with claps and spoken bursts, the same each time for the same seed. */
function room(seconds: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SYNC_RATE));
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = 0; i < out.length; i += 1) out[i] = (random() - 0.5) * 0.01;
  // An event every 0.3 to 1.5 s: a short burst of a tone with a sharp start.
  for (let at = 0.2; at < seconds - 0.5; at += 0.3 + random() * 1.2) {
    const start = Math.round(at * SYNC_RATE);
    const length = Math.round((0.05 + random() * 0.3) * SYNC_RATE);
    const pitch = 150 + random() * 600;
    const level = 0.2 + random() * 0.6;
    for (let i = 0; i < length && start + i < out.length; i += 1) {
      out[start + i] += level * Math.exp(-i / (0.4 * length)) * Math.sin((2 * Math.PI * pitch * i) / SYNC_RATE);
    }
  }
  return out;
}

/** What a second camera heard: from `from` seconds, quieter, through another microphone, with its own noise. */
function heardFrom(sound: Float32Array, from: number, seconds: number, gain: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SYNC_RATE));
  const noise = room(seconds, seed);
  let low = 0;
  for (let i = 0; i < out.length; i += 1) {
    const source = Math.round(from * SYNC_RATE) + i;
    const value = source >= 0 && source < sound.length ? sound[source] : 0;
    low += 0.3 * (value - low);
    out[i] = gain * low + 0.3 * noise[i];
  }
  return out;
}

describe('lining angles up by sound', () => {
  const scene = room(60, 7);

  it('finds a camera that started later, to the hundredth', () => {
    const master = heardFrom(scene, 5, 40, 1, 11);
    const late = heardFrom(scene, 12.37, 40, 0.3, 13);
    const found = alignCurves(onsetCurveOf(master), onsetCurveOf(late));
    // The late camera's 0 s is the master's 7.37 s: the master's start is heard 7.37 s before its start.
    expect(found.seconds).toBeCloseTo(-7.37, 1);
    expect(found.confidence).toBeGreaterThan(5);
  });

  it('finds a camera that started earlier', () => {
    const master = heardFrom(scene, 20, 30, 1, 17);
    const early = heardFrom(scene, 3.5, 50, 0.5, 19);
    const found = alignCurves(onsetCurveOf(master), onsetCurveOf(early));
    expect(found.seconds).toBeCloseTo(16.5, 1);
  });

  it('is not sure of two rooms that never heard each other', () => {
    const one = heardFrom(scene, 0, 30, 1, 23);
    const other = heardFrom(room(30, 99), 0, 30, 1, 29);
    const found = alignCurves(onsetCurveOf(one), onsetCurveOf(other));
    const sure = alignCurves(onsetCurveOf(one), onsetCurveOf(heardFrom(scene, 4, 20, 0.6, 31)));
    expect(found.confidence).toBeLessThan(sure.confidence / 2);
  });
});
