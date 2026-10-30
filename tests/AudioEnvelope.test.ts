import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe } from '@shared/types';
import {
  clipPanAt,
  clipVolumeAt,
  envelopeSignature,
  envelopeValueAt,
  hasVolumeEnvelope,
  panPoints,
  scheduleEnvelope,
  volumePoints,
  withBreakpoints,
} from '@renderer/audio/audioEnvelope';

/**
 * A clip's gain and stereo position over time.
 *
 * The point of these is that playback, scrubbing and the export all read the
 * curve from here, so if the arithmetic is right once it is right in all
 * three. The keyframes are in TIMELINE frames while the points come out in
 * frames from the clip's start, which is the conversion most likely to be got
 * wrong, so it is checked on a clip that does not start at zero.
 */

const key = (frame: number, value: number, easing: Keyframe['easing'] = 'linear'): Keyframe<number> => ({
  id: `k${frame}`,
  frame,
  value,
  easing,
});

const clipWith = (over: Partial<Clip>): Clip =>
  ({
    id: 'c1',
    trackId: 't1',
    sourceUri: 'blob:x',
    startFrame: 100,
    durationFrames: 60,
    sourceOffsetFrames: 0,
    volume: 1,
    pan: 0,
    eq: { low: 0, mid: 0, high: 0 },
    transform: { position: [], scale: [], rotation: [], opacity: [], anchorPoint: { x: 0.5, y: 0.5 } },
    ...over,
  }) as unknown as Clip;

describe('a clip with no curve', () => {
  it('sounds at its fader, wherever the playhead is', () => {
    const clip = clipWith({ volume: 0.5, pan: -0.25 });
    expect(hasVolumeEnvelope(clip)).toBe(false);
    expect(clipVolumeAt(clip, 100)).toBe(0.5);
    expect(clipVolumeAt(clip, 130)).toBe(0.5);
    expect(clipPanAt(clip, 130)).toBe(-0.25);
    expect(volumePoints(clip)).toBeNull();
    expect(panPoints(clip)).toBeNull();
  });
});

describe('a curve', () => {
  it('is the gain, and the fader steps aside', () => {
    // The fader says 0.2; the curve says 1 at the start. The curve wins.
    const clip = clipWith({ volume: 0.2, volumeKeyframes: [key(100, 1), key(160, 0)] });
    expect(clipVolumeAt(clip, 100)).toBeCloseTo(1, 6);
    expect(clipVolumeAt(clip, 130)).toBeCloseTo(0.5, 6);
    expect(clipVolumeAt(clip, 160)).toBeCloseTo(0, 6);
  });

  it('is read in timeline frames and comes out in clip frames', () => {
    const clip = clipWith({ volumeKeyframes: [key(100, 0), key(160, 2)] });
    const points = volumePoints(clip);
    expect(points).not.toBeNull();
    // The first keyframe is at timeline 100, which is frame 0 of the clip.
    expect(points?.[0]).toEqual({ frame: 0, value: 0 });
    expect(points?.[(points?.length ?? 1) - 1].frame).toBe(60);
  });

  it('holds its value before the first keyframe and after the last', () => {
    const clip = clipWith({ volumeKeyframes: [key(120, 0.25), key(140, 0.75)] });
    expect(clipVolumeAt(clip, 100)).toBeCloseTo(0.25, 6);
    expect(clipVolumeAt(clip, 159)).toBeCloseTo(0.75, 6);
  });

  it('stays inside what the parameter allows', () => {
    const loud = clipWith({ volumeKeyframes: [key(100, 9)] });
    expect(clipVolumeAt(loud, 100)).toBe(2);
    const hardLeft = clipWith({ panKeyframes: [key(100, -4)] });
    expect(clipPanAt(hardLeft, 100)).toBe(-1);
  });

  it('samples a straight line at its ends only, and an eased one in between', () => {
    const straight = volumePoints(clipWith({ volumeKeyframes: [key(100, 0), key(160, 1)] })) ?? [];
    const eased = volumePoints(clipWith({ volumeKeyframes: [key(100, 0, 'easeInOut'), key(160, 1)] })) ?? [];
    expect(straight.length).toBeLessThan(4);
    expect(eased.length).toBeGreaterThan(10);
    // Eased in and out: half way through the time is half way up, but a
    // quarter of the way through is nowhere near a quarter.
    const middle = eased.find((point) => Math.abs(point.frame - 30) < 2);
    expect(middle?.value).toBeCloseTo(0.5, 1);
    const quarter = eased.find((point) => Math.abs(point.frame - 15) < 2);
    expect(quarter?.value).toBeLessThan(0.3);
  });

  it('does not sample a hold, which does not move until the next keyframe', () => {
    const held = volumePoints(clipWith({ volumeKeyframes: [key(100, 0.3, 'hold'), key(160, 1)] })) ?? [];
    expect(held.length).toBeLessThan(4);
    expect(envelopeValueAt(held, 30)).toBeCloseTo(0.3, 6);
  });
});

describe('the points a fade needs', () => {
  it('are added without bending the curve', () => {
    const points = volumePoints(clipWith({ volumeKeyframes: [key(100, 0), key(160, 1)] })) ?? [];
    const merged = withBreakpoints(points, [15, 45]);
    const frames = merged.map((point) => point.frame);
    expect(frames).toContain(15);
    expect(frames).toContain(45);
    // Still the same straight line through the added points.
    expect(merged.find((point) => point.frame === 15)?.value).toBeCloseTo(0.25, 6);
    expect(merged.find((point) => point.frame === 45)?.value).toBeCloseTo(0.75, 6);
    // Sorted, and nothing duplicated.
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    expect(new Set(frames).size).toBe(frames.length);
  });
});

describe('writing a curve onto a parameter', () => {
  /** The least of an AudioParam the scheduler needs, recording what it is told. */
  const spy = (): { value: number; calls: string[]; setValueAtTime: (value: number, when: number) => void; linearRampToValueAtTime: (value: number, when: number) => void } => {
    const calls: string[] = [];
    return {
      value: 0,
      calls,
      setValueAtTime(value: number, when: number) {
        calls.push(`set ${value.toFixed(3)} @ ${when.toFixed(3)}`);
      },
      linearRampToValueAtTime(value: number, when: number) {
        calls.push(`ramp ${value.toFixed(3)} @ ${when.toFixed(3)}`);
      },
    };
  };

  it('starts at the value for the moment it starts sounding, not at the clip start', () => {
    const points = volumePoints(clipWith({ volumeKeyframes: [key(100, 0), key(160, 1)] })) ?? [];
    const param = spy();
    // Playback joined the clip one second in, at 30 fps: half way up.
    scheduleEnvelope(param, points, 10, 1, 30);
    expect(param.calls[0]).toBe('set 0.500 @ 10.000');
    // And nothing is scheduled for a time already past.
    expect(param.calls.every((call) => Number(call.split('@ ')[1]) >= 10)).toBe(true);
  });

  it('multiplies by what rides on it, so a fade still ends at silence', () => {
    const points = volumePoints(clipWith({ volumeKeyframes: [key(100, 0.5), key(160, 0.5)] })) ?? [];
    const param = spy();
    // A fade that is fully out by the clip's last frame.
    scheduleEnvelope(param, points, 0, 0, 30, (frame) => 1 - frame / 60);
    expect(param.calls[0]).toBe('set 0.500 @ 0.000');
    expect(param.calls[param.calls.length - 1]).toBe('ramp 0.000 @ 2.000');
  });
});

describe('the signature of an animated sound', () => {
  it('changes when a keyframe is moved, retimed or re-eased', () => {
    const base = clipWith({ volumeKeyframes: [key(100, 1), key(160, 0)] });
    const lowered = clipWith({ volumeKeyframes: [key(100, 1), key(160, 0.5)] });
    const retimed = clipWith({ volumeKeyframes: [key(100, 1), key(150, 0)] });
    const eased = clipWith({ volumeKeyframes: [key(100, 1, 'easeOut'), key(160, 0)] });
    expect(new Set([base, lowered, retimed, eased].map(envelopeSignature)).size).toBe(4);
  });

  it('does not change when the fader moves on a clip with no curve', () => {
    expect(envelopeSignature(clipWith({ volume: 0.2 }))).toBe(envelopeSignature(clipWith({ volume: 1.8 })));
  });
});
