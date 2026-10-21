import { describe, expect, it } from 'vitest';
import type { ClipTransform } from '@shared/types';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import {
  CLIP_ANIMATIONS,
  animationPhase,
  animationPoseAt,
  animationWindow,
  animationsOf,
  withAnimation,
} from '@renderer/fx/motion/animations';

const frame = { width: 1920, height: 1080 };
const fps = 30;
const clip = { startFrame: 100, durationFrames: 150 };
const still = (): ClipTransform => ({ position: [], scale: [], rotation: [], opacity: [], anchorPoint: { x: 0.5, y: 0.5 } });
const rest = { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, opacity: 1 };

describe('clip animations', () => {
  it('come in three kinds, with in and out sets of their own', () => {
    expect(animationsOf('in').length).toBeGreaterThanOrEqual(8);
    expect(animationsOf('out').length).toBeGreaterThanOrEqual(5);
    expect(animationsOf('loop').length).toBeGreaterThanOrEqual(3);
  });

  it('an In plays over the clip\'s first moments, an Out over its last, never more than 40 % of it', () => {
    expect(animationWindow('popIn', clip, fps)).toEqual({ from: 100, to: 115 });
    expect(animationWindow('fadeOut', clip, fps)).toEqual({ from: 231, to: 249 });
    const short = { startFrame: 0, durationFrames: 20 };
    const { from, to } = animationWindow('dropIn', short, fps);
    expect(to - from).toBeLessThanOrEqual(8);
  });

  for (const id of CLIP_ANIMATIONS) {
    it(`${id}: lands on the clip as it is, and moves it in between`, () => {
      const window = animationWindow(id, clip, fps);
      const transform = withAnimation(still(), id, window, rest, frame, fps);
      const phase = animationPhase(id);
      if (phase !== 'loop') {
        const atRest = evaluateTransform(transform, phase === 'in' ? window.to : window.from);
        expect(atRest.position.x).toBeCloseTo(0, 6);
        expect(atRest.position.y).toBeCloseTo(0, 6);
        expect(atRest.scale.x).toBeCloseTo(1, 6);
        expect(atRest.rotation).toBeCloseTo(0, 6);
        expect(atRest.opacity).toBeCloseTo(1, 6);
        // And holds it outside the window.
        const outside = evaluateTransform(transform, phase === 'in' ? window.to + 20 : window.from - 20);
        expect(outside.opacity).toBeCloseTo(1, 6);
        expect(outside.scale.x).toBeCloseTo(1, 6);
      }
      // Somewhere inside, the clip is not at rest.
      let moved = false;
      for (let f = window.from; f <= window.to; f += 1) {
        const pose = evaluateTransform(transform, f);
        if (Math.abs(pose.position.x) + Math.abs(pose.position.y) > 1 || Math.abs(pose.scale.x - 1) > 0.005 || Math.abs(pose.rotation) > 0.1 || pose.opacity < 0.99) moved = true;
      }
      expect(moved).toBe(true);
    });
  }

  it('a slide in starts off the frame, so nothing of it shows on the first frame', () => {
    const window = animationWindow('slideInLeft', clip, fps);
    const first = evaluateTransform(withAnimation(still(), 'slideInLeft', window, rest, frame, fps), window.from);
    expect(first.position.x).toBeLessThanOrEqual(-frame.width);
  });

  it('pop in overshoots before it settles', () => {
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => animationPoseAt('popIn', i / 49).scale));
    expect(peak).toBeGreaterThan(1.02);
  });

  it('an In and an Out sit on the same clip together, and keyframes outside them are kept', () => {
    const base = still();
    base.opacity = [{ id: 'mine', frame: 170, value: 0.8, easing: 'linear' }];
    const inWindow = animationWindow('fadeIn', clip, fps);
    const outWindow = animationWindow('fadeOut', clip, fps);
    const both = withAnimation(withAnimation(base, 'fadeIn', inWindow, rest, frame, fps), 'fadeOut', outWindow, rest, frame, fps);
    expect(both.opacity.some((kf) => kf.id === 'mine')).toBe(true);
    expect(evaluateTransform(both, inWindow.from).opacity).toBeCloseTo(0, 6);
    expect(evaluateTransform(both, outWindow.to).opacity).toBeCloseTo(0, 6);
    expect(evaluateTransform(both, 170).opacity).toBeCloseTo(0.8, 6);
  });

  it('rests on the clip\'s own pose: a clip moved and scaled keeps that', () => {
    const own = { position: { x: 200, y: -50 }, scale: { x: 0.5, y: 0.5 }, rotation: 10, opacity: 0.9 };
    const window = animationWindow('popIn', clip, fps);
    const end = evaluateTransform(withAnimation(still(), 'popIn', window, own, frame, fps), window.to);
    expect(end.scale.x).toBeCloseTo(0.5, 6);
    // Pop in leaves position and rotation alone.
    expect(withAnimation(still(), 'popIn', window, own, frame, fps).position).toEqual([]);
  });

  it('a loop swings both ways, a quarter cycle per keyframe, over the whole clip', () => {
    const window = animationWindow('sway', clip, fps);
    expect(window).toEqual({ from: 100, to: 249 });
    const transform = withAnimation(still(), 'sway', window, rest, frame, fps);
    const values = transform.rotation.map((kf) => kf.value);
    expect(Math.max(...values)).toBeCloseTo(2, 3);
    expect(Math.min(...values)).toBeCloseTo(-2, 3);
    expect(transform.rotation.every((kf) => kf.easing === 'bezier')).toBe(true);
  });
});
