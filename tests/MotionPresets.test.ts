import { describe, expect, it } from 'vitest';
import { buildMotionTransform, motionPreview, MOTION_PRESETS, type MotionBase } from '@renderer/fx/motion/presets';
import { evaluateVector } from '@renderer/engine/KeyframeEvaluator';

/**
 * The screen-zoom and pan presets, as pure keyframe maths - no GPU, no store.
 *
 * These moves are keyframes on the clip's own position and scale, which the
 * compositor applies in the viewer and in export alike, so proving the numbers
 * here proves the move wherever the frame is drawn.
 */

const CLIP = { startFrame: 0, durationFrames: 100 }; // Last frame 99.
const FRAME = { width: 1920, height: 1080 };
const IDENTITY: MotionBase = { scale: { x: 1, y: 1 }, position: { x: 0, y: 0 } };

const start = (track: ReturnType<typeof buildMotionTransform>['scale']) => track[0].frame;
const last = (track: ReturnType<typeof buildMotionTransform>['scale']) => track[track.length - 1].frame;

describe('motion presets', () => {
  it('zoom in ends larger than it starts, and stays centred', () => {
    const move = buildMotionTransform('zoomIn', CLIP, FRAME, IDENTITY);
    const first = evaluateVector(move.scale, 0, IDENTITY.scale);
    const end = evaluateVector(move.scale, 99, IDENTITY.scale);
    expect(end.x).toBeGreaterThan(first.x);
    expect(end.y).toBeGreaterThan(first.y);
    // A zoom holds its framing: no position keyframes.
    expect(move.position).toHaveLength(0);
  });

  it('zoom out ends smaller than it starts', () => {
    const move = buildMotionTransform('zoomOut', CLIP, FRAME, IDENTITY);
    const first = evaluateVector(move.scale, 0, IDENTITY.scale);
    const end = evaluateVector(move.scale, 99, IDENTITY.scale);
    expect(end.x).toBeLessThan(first.x);
    expect(end.x).toBeCloseTo(1, 5); // Back to the whole frame.
  });

  it('a pan holds one zoom and slides position, finishing on the clip\'s last frame', () => {
    const move = buildMotionTransform('panRight', CLIP, FRAME, IDENTITY);
    // Fixed zoom: a single scale keyframe is a constant, not an animation.
    expect(move.scale).toHaveLength(1);
    expect(move.position).toHaveLength(2);
    const first = evaluateVector(move.position, 0, IDENTITY.position);
    const end = evaluateVector(move.position, 99, IDENTITY.position);
    expect(end.x).toBeGreaterThan(first.x);
    expect(last(move.position)).toBe(99);
    expect(start(move.position)).toBe(0);
  });

  it('every pan keeps its drift inside the overscan, so no black edge shows', () => {
    for (const preset of ['panLeft', 'panRight', 'panUp', 'panDown'] as const) {
      const move = buildMotionTransform(preset, CLIP, FRAME, IDENTITY);
      const factor = move.scale[0].value.x; // Fixed zoom.
      const marginX = ((factor - 1) / 2) * FRAME.width;
      const marginY = ((factor - 1) / 2) * FRAME.height;
      for (const key of move.position) {
        expect(Math.abs(key.value.x)).toBeLessThanOrEqual(marginX + 1e-6);
        expect(Math.abs(key.value.y)).toBeLessThanOrEqual(marginY + 1e-6);
      }
    }
  });

  it('Ken Burns zooms and drifts together, both eased at the ends', () => {
    const move = buildMotionTransform('kenBurns', CLIP, FRAME, IDENTITY);
    expect(move.scale).toHaveLength(2);
    expect(move.position).toHaveLength(2);
    // The outgoing keyframe carries the slow-in/slow-out curve.
    expect(move.scale[0].easing).toBe('bezier');
    expect(move.position[0].easing).toBe('bezier');
    const scaleEnd = evaluateVector(move.scale, 99, IDENTITY.scale);
    expect(scaleEnd.x).toBeGreaterThan(1);
  });

  it('builds on the clip\'s fit base, so a portrait still keeps its shape', () => {
    const portrait: MotionBase = { scale: { x: 0.5625, y: 1 }, position: { x: 0, y: 0 } };
    const move = buildMotionTransform('zoomIn', CLIP, FRAME, portrait);
    // The x/y ratio of the fit is preserved while it grows.
    const end = evaluateVector(move.scale, 99, portrait.scale);
    expect(end.x / end.y).toBeCloseTo(0.5625, 5);
    expect(end.x).toBeGreaterThan(portrait.scale.x);
  });

  it('every preset builds a usable track with at least one keyframe', () => {
    for (const preset of MOTION_PRESETS) {
      const move = buildMotionTransform(preset, CLIP, FRAME, IDENTITY);
      expect(move.scale.length + move.position.length).toBeGreaterThan(0);
    }
  });

  it('the preview sampler eases from the start pose to the end pose', () => {
    const atStart = motionPreview('zoomIn', 0);
    const atEnd = motionPreview('zoomIn', 1);
    expect(atStart.factor).toBeCloseTo(1, 5);
    expect(atEnd.factor).toBeGreaterThan(atStart.factor);
  });
});
