import type { Clip, ResolvedTransform, TitleContent } from '@shared/types';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { titleFontsReady } from './fonts';
import { layoutTitle, type FrameSize, type Rect, type TitleLayout } from './layout';
import { canvasMeasurer } from './render';
import { REVEAL_ALL, titleAnimationAt, type TitleAnimationState } from './animation';
import { originOf } from './titleStyle';

/**
 * Where a title is and how it moves, shared by the compositor (which draws
 * it) and the viewer (which lets you pick it, move it and type into it), so
 * the box you grab is exactly the text you see.
 */

export interface TitleGeometry {
  /** The text on the frame before any transform - with its background box's padding - in project pixels. */
  block: Rect;
  /** What it scales and turns about, in project pixels (see TitleOrigin). */
  pivot: { x: number; y: number };
}

/** The geometry of a laid-out title. */
export function geometryFromLayout(layout: TitleLayout, title: TitleContent, frame: FrameSize): TitleGeometry {
  const block = layout.box ?? layout.block;
  const pivot =
    originOf(title) === 'text'
      ? { x: block.x + block.width / 2, y: block.y + block.height / 2 }
      : { x: frame.width / 2, y: frame.height / 2 };
  return { block: { ...block }, pivot };
}

/**
 * A title laid out at 1:1, measured by Canvas2D. Kept per title object - a
 * title is replaced, never edited in place - and redone once its fonts have
 * loaded, since what was measured before that was a fallback face.
 */
const layouts = new WeakMap<TitleContent, { key: string; layout: TitleLayout }>();

export function titleLayout(title: TitleContent, frame: FrameSize): TitleLayout {
  const key = `${frame.width}x${frame.height}|${titleFontsReady(title) ? 1 : 0}`;
  const known = layouts.get(title);
  if (known?.key === key) return known.layout;
  const layout = layoutTitle(title, frame, canvasMeasurer(title, 1));
  layouts.set(title, { key, layout });
  return layout;
}

export const titleGeometry = (title: TitleContent, frame: FrameSize): TitleGeometry =>
  geometryFromLayout(titleLayout(title, frame), title, frame);

export interface TitleFrame {
  /** The clip's keyframes with the title's animation on top. */
  transform: ResolvedTransform;
  /** Where a Wipe's edge is: see TitleAnimationState. */
  reveal: number;
  animation: TitleAnimationState;
}

/**
 * The title's transform at a timeline frame: its keyframes, with its own
 * animation on top - opacity and scale multiply, movement adds - and scaling
 * about its pivot. `resting` leaves the animation out, for typing into a
 * title that is still fading in.
 */
export function titleTransformAt(
  clip: Clip,
  frame: number,
  fps: number,
  frameSize: FrameSize,
  geometry: TitleGeometry,
  resting = false,
): TitleFrame {
  const base = evaluateTransform(clip.transform, frame);
  const animation = resting
    ? titleAnimationAt(undefined, 0, 1, fps, frameSize.height)
    : titleAnimationAt(clip.title?.animation, frame - clip.startFrame, clip.durationFrames, fps, frameSize.height, geometry.block);
  return {
    transform: {
      ...base,
      position: { x: base.position.x + animation.offset.x, y: base.position.y + animation.offset.y },
      scale: { x: base.scale.x * animation.scale, y: base.scale.y * animation.scale },
      opacity: base.opacity * animation.opacity,
    },
    reveal: animation.reveal ?? REVEAL_ALL,
    animation,
  };
}
