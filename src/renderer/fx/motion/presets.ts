import type { BezierCurve, Keyframe, Vector2D } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { createId } from '@shared/utils/id';

/**
 * Motion presets: screen zoom and pan built from the clip's own transform
 * keyframes, not from a shader.
 *
 * Position and scale are already keyframeable, evaluated by the
 * KeyframeEvaluator and applied by the compositor in the viewer and in every
 * export alike (see engine/Compositor). So a "zoom in" is two scale keyframes
 * and a "pan" is two position keyframes - which means these moves cost nothing
 * extra to render and look identical wherever the frame is drawn. This is how
 * Premiere's Pan-and-Zoom and the Ken Burns move are made: keyframe Scale and
 * Position, then ease the ends (Adobe, "Ken Burns effect").
 *
 * The maths here is pure data, so the unit tests read it without a GPU.
 */

export type MotionPresetId = 'zoomIn' | 'zoomOut' | 'kenBurns' | 'panLeft' | 'panRight' | 'panUp' | 'panDown';

export const MOTION_PRESETS: readonly MotionPresetId[] = ['zoomIn', 'zoomOut', 'kenBurns', 'panLeft', 'panRight', 'panUp', 'panDown'];

export const motionPresetLabel = (id: MotionPresetId): MessageKey => `fxm.${id}` as MessageKey;
export const motionPresetHint = (id: MotionPresetId): MessageKey => `fxm.${id}Hint` as MessageKey;

/**
 * One preset's shape. Scale is a factor on the clip's own fit scale, so a
 * portrait still that was fitted with bars keeps its shape while it zooms.
 * Position offsets are fractions of the frame, turned into the pixels the
 * transform stores against the project's width and height - so the same move
 * drifts the same share of the picture at any resolution.
 *
 * The pans hold a fixed zoom so there is picture to move into: at scale s the
 * picture overhangs each edge by (s - 1) / 2 of the frame, so a drift of that
 * much each way never shows a black edge. Every pan below keeps its drift
 * inside that margin.
 */
interface MotionSpec {
  scaleStart: number;
  scaleEnd: number;
  /** Offset at the first keyframe, as a fraction of frame width and height. */
  fromX: number;
  fromY: number;
  /** Offset at the last keyframe. */
  toX: number;
  toY: number;
}

/** Slow-in, slow-out: the ends ease, as Adobe asks for a Ken Burns move. */
const EASE_IN_OUT: BezierCurve = { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } };

/** A gentle, cinematic amount - a little goes a long way on a full-screen move. */
const PAN_ZOOM = 1.25; // Overhang of 0.125 of the frame each side.
const PAN_DRIFT = 0.1; // Inside that margin, so no black edge shows.

const MOTION_SPECS: Record<MotionPresetId, MotionSpec> = {
  // Push in from the whole frame to a quarter closer.
  zoomIn: { scaleStart: 1, scaleEnd: 1.3, fromX: 0, fromY: 0, toX: 0, toY: 0 },
  // Pull back out to the whole frame.
  zoomOut: { scaleStart: 1.3, scaleEnd: 1, fromX: 0, fromY: 0, toX: 0, toY: 0 },
  // The documentary move: a slow push with a diagonal drift, both easing.
  kenBurns: { scaleStart: 1.1, scaleEnd: 1.25, fromX: -0.045, fromY: 0.03, toX: 0.045, toY: -0.03 },
  // Fixed zoom, sliding across. "Left" moves the picture leftward past the frame.
  panLeft: { scaleStart: PAN_ZOOM, scaleEnd: PAN_ZOOM, fromX: PAN_DRIFT, fromY: 0, toX: -PAN_DRIFT, toY: 0 },
  panRight: { scaleStart: PAN_ZOOM, scaleEnd: PAN_ZOOM, fromX: -PAN_DRIFT, fromY: 0, toX: PAN_DRIFT, toY: 0 },
  panUp: { scaleStart: PAN_ZOOM, scaleEnd: PAN_ZOOM, fromX: 0, fromY: PAN_DRIFT, toX: 0, toY: -PAN_DRIFT },
  panDown: { scaleStart: PAN_ZOOM, scaleEnd: PAN_ZOOM, fromX: 0, fromY: -PAN_DRIFT, toX: 0, toY: PAN_DRIFT },
};

export interface MotionClip {
  startFrame: number;
  durationFrames: number;
}

export interface MotionFrame {
  width: number;
  height: number;
}

/** The scale and position a clip rests at before any move: its fit, centred. */
export interface MotionBase {
  scale: Vector2D;
  position: Vector2D;
}

export interface MotionTransform {
  position: Keyframe<Vector2D>[];
  scale: Keyframe<Vector2D>[];
}

/**
 * The zoom factor and drift the thumbnail shows at loop progress `t`, so the
 * picture in the panel moves the way the clip will. The ends ease, matching
 * the keyframes the preset writes.
 */
export function motionPreview(preset: MotionPresetId, t: number): { factor: number; offsetX: number; offsetY: number } {
  const spec = MOTION_SPECS[preset];
  // A smooth-step: the same slow-in, slow-out shape as EASE_IN_OUT, cheap to compute.
  const p = Math.min(1, Math.max(0, t));
  const eased = p * p * (3 - 2 * p);
  return {
    factor: spec.scaleStart + (spec.scaleEnd - spec.scaleStart) * eased,
    offsetX: spec.fromX + (spec.toX - spec.fromX) * eased,
    offsetY: spec.fromY + (spec.toY - spec.fromY) * eased,
  };
}

const vec = (frame: number, value: Vector2D, easing: Keyframe<Vector2D>['easing'], bezierParams?: BezierCurve): Keyframe<Vector2D> => ({
  id: createId('kf'),
  frame,
  value,
  easing,
  ...(bezierParams ? { bezierParams } : {}),
});

/**
 * The position and scale tracks that play `preset` over `clip`, on top of the
 * clip's `base` rest pose. A zoom animates scale and leaves position still; a
 * pan animates position and holds one zoom. The last keyframe lands on the
 * clip's final frame so the move finishes exactly as the clip ends.
 */
export function buildMotionTransform(preset: MotionPresetId, clip: MotionClip, frame: MotionFrame, base: MotionBase): MotionTransform {
  const spec = MOTION_SPECS[preset];
  const start = clip.startFrame;
  // Guard a one-frame or zero-length clip: a track needs two distinct frames.
  const end = Math.max(start + 1, start + Math.max(1, clip.durationFrames) - 1);

  const scaleAt = (factor: number): Vector2D => ({ x: base.scale.x * factor, y: base.scale.y * factor });
  const posAt = (fx: number, fy: number): Vector2D => ({ x: base.position.x + fx * frame.width, y: base.position.y + fy * frame.height });

  const scaleMoves = spec.scaleStart !== spec.scaleEnd;
  const posMoves = spec.fromX !== spec.toX || spec.fromY !== spec.toY;

  return {
    scale: scaleMoves
      ? [vec(start, scaleAt(spec.scaleStart), 'bezier', EASE_IN_OUT), vec(end, scaleAt(spec.scaleEnd), 'linear')]
      : // A pan holds one zoom: a single keyframe is a fixed value, not an animation.
        [vec(start, scaleAt(spec.scaleStart), 'linear')],
    position: posMoves
      ? [vec(start, posAt(spec.fromX, spec.fromY), 'bezier', EASE_IN_OUT), vec(end, posAt(spec.toX, spec.toY), 'linear')]
      : [],
  };
}
