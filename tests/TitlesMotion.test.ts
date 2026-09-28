import { describe, expect, it } from 'vitest';
import type { Clip, TitleAnimation } from '@shared/types';
import {
  animationFrames,
  easeExit,
  easeStandard,
  normalizeAnimation,
  POP_FROM,
  presetAnimation,
  REVEAL_ALL,
  springBounce,
  titleAnimationAt,
  TRAVEL,
  WIPE_SOFTNESS,
} from '@renderer/text/animation';
import { geometryFromLayout, titleTransformAt } from '@renderer/text/geometry';
import { layoutTitle, type Measurer } from '@renderer/text/layout';
import { migrateTitleOrigin, presetStyle, TITLE_SAFE } from '@renderer/text/titleStyle';
import { SPRINGS } from '@renderer/motion/tokens.generated';
import {
  anchorPosition,
  containsPoint,
  layerToPixels,
  quadCorners,
  rotationFromPointer,
  angleAround,
  scaleFromHandle,
  snappedTitlePosition,
  type LayerShape,
} from '@renderer/components/PreviewViewport/viewportTransform';
import { createClip, normalizeProject } from '@renderer/store/types';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Titles, phase 2: the animations frame by frame, the credits roll, the
 * pivot and its migration, and the viewer's geometry for a title - all
 * without a GPU. The pixels are tests/ui/titles-motion.mjs.
 */

const FPS = 30;
const H = 1080;
const frame = { width: 1920, height: 1080 };
const anim = (patch: Partial<TitleAnimation>): TitleAnimation => ({ in: 'none', inSeconds: 0.5, out: 'none', outSeconds: 0.33, roll: false, ...patch });

describe('entrances', () => {
  it('Fade: nothing on the first frame, all of it after half a second, on the standard curve between', () => {
    const fade = anim({ in: 'fade' });
    expect(animationFrames(fade, 150, FPS).inFrames).toBe(15);
    expect(titleAnimationAt(fade, 0, 150, FPS, H).opacity).toBe(0);
    expect(titleAnimationAt(fade, 5, 150, FPS, H).opacity).toBeCloseTo(easeStandard(5 / 15), 12);
    expect(titleAnimationAt(fade, 15, 150, FPS, H).opacity).toBe(1);
    // The standard curve decelerates: two thirds there by a third of the way.
    expect(easeStandard(1 / 3)).toBeGreaterThan(0.6);
  });

  it('Rise: comes up 4% of the frame as it fades in', () => {
    const rise = anim({ in: 'rise' });
    expect(titleAnimationAt(rise, 0, 150, FPS, H).offset.y).toBeCloseTo(TRAVEL * H, 9);
    expect(titleAnimationAt(rise, 0, 150, FPS, H).offset.y).toBeCloseTo(43.2, 9);
    expect(titleAnimationAt(rise, 15, 150, FPS, H).offset.y).toBe(0);
    const middle = titleAnimationAt(rise, 6, 150, FPS, H);
    expect(middle.offset.y).toBeCloseTo((1 - easeStandard(6 / 15)) * 43.2, 9);
    expect(middle.opacity).toBeCloseTo(easeStandard(6 / 15), 12);
  });

  it('Pop: the size springs with the 0.25 bounce and overshoots; the opacity never does', () => {
    const pop = anim({ in: 'pop' });
    const frames = Array.from({ length: 16 }, (_, at) => titleAnimationAt(pop, at, 150, FPS, H));
    expect(frames[0].scale).toBeCloseTo(POP_FROM, 12);
    expect(frames[15].scale).toBe(1);
    const largest = Math.max(...frames.map((state) => state.scale));
    expect(largest).toBeGreaterThan(1);
    expect(largest).toBeCloseTo(POP_FROM + (1 - POP_FROM) * Math.max(...SPRINGS.standardBounce.points), 3);
    for (let i = 1; i < frames.length; i += 1) expect(frames[i].opacity).toBeGreaterThanOrEqual(frames[i - 1].opacity);
    expect(frames.every((state) => state.opacity <= 1)).toBe(true);
    // The spring as the motion tokens sample it.
    expect(springBounce(0.5)).toBeCloseTo(SPRINGS.standardBounce.points[20], 12);
  });

  it('Wipe: the soft edge crosses from before the title to its far side', () => {
    const wipe = anim({ in: 'wipe' });
    expect(titleAnimationAt(wipe, 0, 150, FPS, H).reveal).toBeCloseTo(-WIPE_SOFTNESS, 12);
    expect(titleAnimationAt(wipe, 14, 150, FPS, H).reveal).toBeLessThan(1);
    expect(titleAnimationAt(wipe, 15, 150, FPS, H).reveal).toBe(REVEAL_ALL);
    expect(titleAnimationAt(wipe, 15, 150, FPS, H).opacity).toBe(1);
  });
});

describe('exits', () => {
  it('are counted from the clip end: trim the clip and the exit moves with it', () => {
    const fadeOut = anim({ out: 'fade' });
    expect(animationFrames(fadeOut, 150, FPS).outFrames).toBe(10);
    const long = [140, 145, 149].map((at) => titleAnimationAt(fadeOut, at, 150, FPS, H).opacity);
    const trimmed = [110, 115, 119].map((at) => titleAnimationAt(fadeOut, at, 120, FPS, H).opacity);
    expect(trimmed).toEqual(long);
    expect(long[0]).toBe(1);
    expect(long[2]).toBeCloseTo(1 - easeExit(0.9), 12);
    expect(titleAnimationAt(fadeOut, 139, 150, FPS, H).opacity).toBe(1);
  });

  it('Drop falls 4% of the frame; Vanish shrinks - and neither bounces', () => {
    const drop = [140, 144, 148].map((at) => titleAnimationAt(anim({ out: 'drop' }), at, 150, FPS, H));
    const vanish = [140, 144, 148].map((at) => titleAnimationAt(anim({ out: 'vanish' }), at, 150, FPS, H));
    expect(drop.map((state) => state.offset.y)).toEqual([...drop.map((state) => state.offset.y)].sort((a, b) => a - b));
    expect(drop[2].offset.y).toBeCloseTo(easeExit(1 - 2 / 10) * TRAVEL * H, 9);
    for (let i = 1; i < vanish.length; i += 1) expect(vanish[i].scale).toBeLessThan(vanish[i - 1].scale);
    expect(vanish.every((state) => state.scale <= 1)).toBe(true);
  });

  it('share a short clip in proportion, never overlapping', () => {
    const both = anim({ in: 'fade', inSeconds: 2, out: 'fade', outSeconds: 2 });
    const { inFrames, outFrames } = animationFrames(both, 30, FPS);
    expect(inFrames + outFrames).toBe(30);
    expect(inFrames).toBe(15);
  });
});

describe('the credits roll', () => {
  it('moves the same number of pixels every frame, from below the frame to above it', () => {
    const block = { y: 300, height: 480 };
    const roll = anim({ roll: true });
    const offsets = [0, 1, 2, 100, 299, 300].map((at) => titleAnimationAt(roll, at, 300, FPS, H, block).offset.y);
    const speed = (H + block.height) / 300;
    expect(offsets[1] - offsets[0]).toBeCloseTo(-speed, 9);
    expect(offsets[2] - offsets[1]).toBeCloseTo(-speed, 9);
    expect(offsets[3] - offsets[2]).toBeCloseTo(-98 * speed, 9);
    // First frame: the text's top on the frame's bottom edge. Last: its bottom on the top edge.
    expect(block.y + offsets[0]).toBeCloseTo(H, 9);
    expect(block.y + block.height + offsets[5]).toBeCloseTo(0, 9);
  });

  it('is what the end credits template does', () => {
    expect(presetAnimation('credits').roll).toBe(true);
    expect(presetAnimation('title').in).toBe('fade');
    expect(presetAnimation('lowerThird').in).toBe('rise');
  });
});

describe('an animation read from a file', () => {
  it('keeps what is valid and turns anything unknown into none', () => {
    expect(normalizeAnimation({ in: 'spin', inSeconds: 99, out: 'drop', roll: 'yes' })).toEqual({
      in: 'none',
      inSeconds: 5,
      out: 'drop',
      outSeconds: 0.33,
      roll: false,
    });
  });
});

/** A monospace stand-in, as in Titles.test.ts. */
const mono: Measurer = {
  width: (text, size, spacing) => [...text].length * (size * 0.5 + spacing) - (text ? spacing : 0),
  metrics: (size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
};

const titleClip = (patch: Partial<Clip> = {}): Clip => ({
  ...createClip({ trackId: 'v', name: 'T', sourceUri: 'scf-title:t', startFrame: 100, durationFrames: 150 }),
  title: { preset: 'lowerThird', text: 'Ana\nEditor', style: presetStyle('lowerThird'), animation: anim({ in: 'pop', out: 'vanish' }), origin: 'text' },
  ...patch,
});

describe('a title on top of its keyframes', () => {
  it('multiplies opacity and scale, and adds movement', () => {
    const base = titleClip();
    const clip: Clip = {
      ...base,
      transform: {
        ...base.transform,
        opacity: [{ id: 'o', frame: 100, value: 0.5, easing: 'linear' }],
        scale: [{ id: 's', frame: 100, value: { x: 2, y: 2 }, easing: 'linear' }],
        position: [{ id: 'p', frame: 100, value: { x: 10, y: -20 }, easing: 'linear' }],
      },
    };
    const geometry = geometryFromLayout(layoutTitle(clip.title!, frame, mono), clip.title!, frame);
    const at = titleTransformAt(clip, 105, FPS, frame, geometry);
    const alone = titleAnimationAt(clip.title!.animation, 5, 150, FPS, H, geometry.block);
    expect(at.transform.opacity).toBeCloseTo(0.5 * alone.opacity, 12);
    expect(at.transform.scale.x).toBeCloseTo(2 * alone.scale, 12);
    expect(at.transform.position).toEqual({ x: 10 + alone.offset.x, y: -20 + alone.offset.y });
    // At rest - while it is typed into - the keyframes alone.
    const resting = titleTransformAt(clip, 105, FPS, frame, geometry, true);
    expect(resting.transform.opacity).toBe(0.5);
    expect(resting.transform.scale.x).toBe(2);
  });
});

describe('the pivot', () => {
  it('is the centre of the text (with its box) for a new title, and the frame centre for an old one', () => {
    const clip = titleClip();
    const layout = layoutTitle(clip.title!, frame, mono);
    const box = layout.box!;
    expect(geometryFromLayout(layout, clip.title!, frame).pivot).toEqual({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const { origin: _origin, ...old } = clip.title!;
    void _origin;
    expect(geometryFromLayout(layout, old, frame).pivot).toEqual({ x: 960, y: 540 });
  });

  it('moves an old title to its text centre on opening only when that changes nothing', () => {
    const { origin: _origin, ...oldTitle } = titleClip().title!;
    void _origin;
    const plain = migrateTitleOrigin(titleClip({ title: oldTitle }));
    expect(plain.title!.origin).toBe('text');
    const identityKeys = migrateTitleOrigin(
      titleClip({
        title: oldTitle,
        transform: { ...titleClip().transform, scale: [{ id: 's', frame: 0, value: { x: 1, y: 1 }, easing: 'linear' }], rotation: [{ id: 'r', frame: 0, value: 0, easing: 'linear' }] },
      }),
    );
    expect(identityKeys.title!.origin).toBe('text');
    const scaled = migrateTitleOrigin(
      titleClip({ title: oldTitle, transform: { ...titleClip().transform, scale: [{ id: 's', frame: 0, value: { x: 1.5, y: 1.5 }, easing: 'linear' }] } }),
    );
    expect(scaled.title!.origin).toBe('frame');
    const turned = migrateTitleOrigin(
      titleClip({ title: oldTitle, transform: { ...titleClip().transform, rotation: [{ id: 'r', frame: 0, value: 10, easing: 'linear' }] } }),
    );
    expect(turned.title!.origin).toBe('frame');
    // And through a project being opened.
    const project = { ...useProjectStore.getState().project, clips: { [plain.id]: { ...plain, title: oldTitle } } };
    expect(normalizeProject(JSON.parse(JSON.stringify(project))).clips[plain.id].title!.origin).toBe('text');
  });
});

describe('the viewer, for a title', () => {
  const clip = titleClip();
  const geometry = geometryFromLayout(layoutTitle(clip.title!, frame, mono), clip.title!, frame);
  const layer: LayerShape = { rect: geometry.block, pivot: geometry.pivot };
  const resting = { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, opacity: 1, anchorPoint: { x: 0.5, y: 0.5 } };

  it('draws its box round the text, not the frame', () => {
    const corners = quadCorners(resting, frame, layer);
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    expect(Math.min(...xs)).toBeCloseTo(geometry.block.x, 6);
    expect(Math.max(...xs)).toBeCloseTo(geometry.block.x + geometry.block.width, 6);
    expect(Math.min(...ys)).toBeCloseTo(geometry.block.y, 6);
    expect(Math.max(...ys)).toBeCloseTo(geometry.block.y + geometry.block.height, 6);
    // A click beside the text is not on the title.
    expect(containsPoint(resting, { x: geometry.pivot.x, y: geometry.pivot.y }, frame, layer)).toBe(true);
    expect(containsPoint(resting, { x: 1700, y: 200 }, frame, layer)).toBe(false);
  });

  it('turns and scales it about the text centre: the pivot stays put', () => {
    const turned = { ...resting, rotation: 30, scale: { x: 1.5, y: 1.5 } };
    const pivot = anchorPosition(turned, frame, layer);
    expect(pivot.x).toBeCloseTo(geometry.pivot.x, 6);
    expect(pivot.y).toBeCloseTo(geometry.pivot.y, 6);
    // The drawn corners have all moved away from the pivot by 1.5x.
    const before = quadCorners(resting, frame, layer)[0];
    const after = quadCorners({ ...resting, scale: { x: 1.5, y: 1.5 } }, frame, layer)[0];
    expect(after.x - geometry.pivot.x).toBeCloseTo((before.x - geometry.pivot.x) * 1.5, 6);
    expect(after.y - geometry.pivot.y).toBeCloseTo((before.y - geometry.pivot.y) * 1.5, 6);
  });

  it('with the frame as its layer, is exactly the clip that fills the frame', () => {
    const turned = { ...resting, rotation: 20, scale: { x: 0.7, y: 0.9 }, position: { x: 40, y: -30 } };
    const whole: LayerShape = { rect: { x: 0, y: 0, width: 1920, height: 1080 }, pivot: { x: 960, y: 540 } };
    const withLayer = quadCorners(turned, frame, whole);
    const without = quadCorners(turned, frame);
    withLayer.forEach((corner, index) => {
      expect(corner.x).toBeCloseTo(without[index].x, 9);
      expect(corner.y).toBeCloseTo(without[index].y, 9);
    });
  });

  it('scales from a corner grip keeping the opposite corner still', () => {
    const start = resting;
    const corners = quadCorners(start, frame, layer);
    // Pull the top-right grip out by 60 px to the right.
    const topRight = corners[2];
    const result = scaleFromHandle(start, 'topRight', { x: topRight.x + 60, y: topRight.y }, frame, {}, layer);
    const after = quadCorners({ ...start, ...result }, frame, layer);
    expect(after[0].x).toBeCloseTo(corners[0].x, 6);
    expect(after[0].y).toBeCloseTo(corners[0].y, 6);
    expect(result.scale.x).toBeGreaterThan(1);
  });

  it('turns from the rotate grip about the text centre', () => {
    const grab = angleAround(resting, { x: geometry.pivot.x + 100, y: geometry.pivot.y }, frame, layer);
    const rotation = rotationFromPointer(resting, { x: geometry.pivot.x, y: geometry.pivot.y + 100 }, frame, { grabAngle: grab }, layer);
    expect(Math.round(rotation)).toBe(90);
  });

  it('maps the title\'s own pixels onto the picture for the text editor', () => {
    const moved = { ...resting, position: { x: 25, y: -10 } };
    const [a, b, c, d, e, f] = layerToPixels(moved, frame, layer);
    const map = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
    const pivot = map(geometry.pivot.x, geometry.pivot.y);
    expect(pivot.x).toBeCloseTo(geometry.pivot.x + 25, 6);
    expect(pivot.y).toBeCloseTo(geometry.pivot.y - 10, 6);
  });

  it('snaps a dragged title to the frame centre and the title-safe edges', () => {
    const margin = (1920 * (1 - TITLE_SAFE)) / 2;
    // Lower third: its left edge already on the safe edge; nudge it 6 px right.
    const nearEdge = snappedTitlePosition({ x: 6, y: 0 }, resting, frame, layer, 10, TITLE_SAFE);
    expect(nearEdge.position.x).toBeCloseTo(0, 6);
    expect(nearEdge.safe).toBe(true);
    expect(geometry.block.x).toBeCloseTo(margin, 6);
    // Its centre dragged to within 5 px of the frame's centre.
    const shift = 960 - (geometry.block.x + geometry.block.width / 2);
    const nearCentre = snappedTitlePosition({ x: shift - 5, y: 0 }, resting, frame, layer, 10, TITLE_SAFE);
    expect(nearCentre.position.x).toBeCloseTo(shift, 6);
    expect(nearCentre.vertical).toBe(true);
  });
});
