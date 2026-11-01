import { describe, expect, it } from 'vitest';
import type { AnimationLayer, DrawnAnimation, OnionSkin, Stroke } from '../src/shared/types';
import {
  celAt,
  duplicateCel,
  emptyAnimation,
  exposureAt,
  exposureCount,
  frameOfExposure,
  normalizeAnimation,
  onionAround,
  stepOf,
  strokeCount,
  withStroke,
} from '../src/renderer/animation/model';
import { rasterKey } from '../src/renderer/animation/raster';
import { drawKeyOf, nextDrawing, previousDrawing, SIZE_STEP } from '../src/renderer/animation/keys';
import { chainOf, isMoved, NO_PLACE, placeOf } from '../src/renderer/animation/motion';
import { isRealDrag, MAX_SIDES, MIN_SIDES, shapePoints, shapeStroke } from '../src/renderer/animation/shapes';

const stroke = (id: string, points = [0.1, 0.1, 0.5, 0.2, 0.2, 0.5]): Stroke => ({
  id,
  brush: 'pencil',
  color: '#ffffff',
  size: 0.006,
  opacity: 1,
  points,
});

const layer = (cels: { at: number; id?: string; strokes?: Stroke[] }[]): AnimationLayer => ({
  id: 'layer-1',
  name: 'Layer 1',
  visible: true,
  opacity: 1,
  cels: cels.map((cel) => ({ id: cel.id ?? `cel-${cel.at}`, at: cel.at, strokes: cel.strokes ?? [stroke(`s-${cel.at}`)] })),
});

const anim = (layers: AnimationLayer[], step = 2, onion?: OnionSkin): DrawnAnimation => ({ layers, step, onion });

/** A clip stub, declared once so a test may pass a length the arithmetic ignores. */
const clipAt = (startFrame: number, durationFrames: number): { startFrame: number; durationFrames: number } => ({ startFrame, durationFrames });

describe('exposures and timeline frames', () => {
  it('holds each drawing for `step` frames, so twos is two frames a drawing', () => {
    const a = anim([layer([{ at: 0 }])], 2);
    const clip = { startFrame: 0, durationFrames: 48 };
    expect(exposureAt(a, clip, 0)).toBe(0);
    expect(exposureAt(a, clip, 1)).toBe(0);
    expect(exposureAt(a, clip, 2)).toBe(1);
    expect(exposureAt(a, clip, 3)).toBe(1);
    expect(exposureAt(a, clip, 46)).toBe(23);
  });

  it('counts from the clip, not the timeline, so moving a clip shows the same drawings', () => {
    const a = anim([layer([{ at: 0 }])], 2);
    expect(exposureAt(a, clipAt(100, 48), 104)).toBe(2);
    expect(exposureAt(a, clipAt(0, 48), 4)).toBe(2);
  });

  it('shows the first drawing before the clip starts rather than a part of one', () => {
    const a = anim([layer([{ at: 0 }])], 3);
    expect(exposureAt(a, clipAt(10, 30), 4)).toBe(0);
  });

  it('turns an exposure back into the frame it appears on', () => {
    const a = anim([layer([{ at: 0 }])], 3);
    const clip = { startFrame: 12, durationFrames: 60 };
    expect(frameOfExposure(a, clip, 0)).toBe(12);
    expect(frameOfExposure(a, clip, 4)).toBe(24);
    // And back again, which must agree or the sheet and the playhead disagree.
    expect(exposureAt(a, clip, frameOfExposure(a, clip, 4))).toBe(4);
  });

  it('fits the exposures to the clip length, rounding up so the last frames are drawn', () => {
    expect(exposureCount(anim([layer([{ at: 0 }])], 2), { durationFrames: 48 })).toBe(24);
    // 49 frames on twos is 25 drawings: the last one covers a single frame.
    expect(exposureCount(anim([layer([{ at: 0 }])], 2), { durationFrames: 49 })).toBe(25);
    expect(exposureCount(anim([layer([{ at: 0 }])], 1), { durationFrames: 1 })).toBe(1);
  });

  it('refuses a step that is not a whole number of frames', () => {
    expect(stepOf(anim([], 0))).toBe(1);
    expect(stepOf(anim([], -4))).toBe(1);
    expect(stepOf(anim([], 2.4))).toBe(2);
    expect(stepOf(anim([], 999))).toBe(8);
    expect(stepOf(anim([], Number.NaN))).toBe(1);
  });
});

describe('a drawing is held until the next one', () => {
  it('shows the last drawing that has begun', () => {
    const l = layer([{ at: 0 }, { at: 4 }, { at: 10 }]);
    expect(celAt(l, 0)?.at).toBe(0);
    expect(celAt(l, 3)?.at).toBe(0);
    expect(celAt(l, 4)?.at).toBe(4);
    expect(celAt(l, 9)?.at).toBe(4);
    expect(celAt(l, 400)?.at).toBe(10);
  });

  it('shows nothing before a layer’s first drawing, so a character can enter', () => {
    const l = layer([{ at: 6 }]);
    expect(celAt(l, 0)).toBeNull();
    expect(celAt(l, 5)).toBeNull();
    expect(celAt(l, 6)?.at).toBe(6);
  });
});

describe('drawing onto a drawing', () => {
  it('adds to the drawing that is its own', () => {
    const l = withStroke(layer([{ at: 2 }]), 2, stroke('new'));
    expect(l.cels).toHaveLength(1);
    expect(l.cels[0].strokes.map((s) => s.id)).toEqual(['s-2', 'new']);
  });

  it('starts a new, BLANK drawing at an exposure that was only holding one', () => {
    // A new exposure is a new drawing - that is what frame-by-frame animation
    // is. Carrying the held drawing over would make onion skin pointless (the
    // previous drawing would always sit identical underneath) and would make
    // every drawing accumulate every stroke before it.
    const l = withStroke(layer([{ at: 2 }]), 5, stroke('new'));
    expect(l.cels.map((cel) => cel.at)).toEqual([2, 5]);
    expect(l.cels[0].strokes.map((s) => s.id)).toEqual(['s-2']);
    expect(l.cels[1].strokes.map((s) => s.id)).toEqual(['new']);
  });

  it('copies the held drawing only when asked to, to draw on top of it', () => {
    const l = duplicateCel(layer([{ at: 2 }]), 5);
    expect(l.cels.map((cel) => cel.at)).toEqual([2, 5]);
    expect(l.cels[1].strokes.map((s) => s.id)).toEqual(['s-2']);
    // Nothing to copy, or it already has its own: left alone.
    expect(duplicateCel(layer([{ at: 2 }]), 2).cels).toHaveLength(1);
    expect(duplicateCel(layer([{ at: 7 }]), 3).cels).toHaveLength(1);
  });

  it('keeps the drawings ascending however they are put in', () => {
    let l = layer([{ at: 4 }]);
    l = withStroke(l, 9, stroke('a'));
    l = withStroke(l, 1, stroke('b'));
    expect(l.cels.map((cel) => cel.at)).toEqual([1, 4, 9]);
  });

  it('counts what is drawn across every layer', () => {
    const a = anim([layer([{ at: 0 }, { at: 2 }]), { ...layer([{ at: 0 }]), id: 'layer-2' }]);
    expect(strokeCount(a)).toBe(3);
  });
});

describe('onion skin', () => {
  const on = (over: Partial<OnionSkin> = {}): OnionSkin => ({ enabled: true, before: 1, after: 1, opacity: 0.4, by: 'drawings', ...over });

  it('shows nothing when it is off', () => {
    expect(onionAround(layer([{ at: 0 }, { at: 1 }]), 1, on({ enabled: false }))).toEqual([]);
  });

  it('by drawings, steps from one drawing to the next however long each is held', () => {
    // Drawings at 0, 5 and 20. At 5, the neighbours are 0 and 20 - not
    // whatever happens to be four and six exposures away.
    const ghosts = onionAround(layer([{ at: 0 }, { at: 5 }, { at: 20 }]), 5, on());
    expect(ghosts.map((ghost) => ghost.cel.at)).toEqual([0, 20]);
    expect(ghosts.map((ghost) => ghost.side)).toEqual(['before', 'after']);
  });

  it('by frames, looks a fixed distance in time and so shows a held drawing no twice', () => {
    // A drawing held from 0 to 20: one exposure either side of 10 is the SAME
    // drawing, so there is nothing new to show. This is the distinction most
    // programs muddle.
    expect(onionAround(layer([{ at: 0 }, { at: 20 }]), 10, on({ by: 'frames' }))).toEqual([]);
    // One exposure before 20 is the drawing at 0, which is something new.
    const ghosts = onionAround(layer([{ at: 0 }, { at: 20 }]), 20, on({ by: 'frames' }));
    expect(ghosts.map((ghost) => ghost.cel.at)).toEqual([0]);
  });

  it('never shows the drawing that is current', () => {
    for (const by of ['drawings', 'frames'] as const) {
      const ghosts = onionAround(layer([{ at: 0 }, { at: 1 }, { at: 2 }]), 1, on({ before: 4, after: 4, by }));
      expect(ghosts.map((ghost) => ghost.cel.at)).not.toContain(1);
    }
  });

  it('fades with distance, so the drawing just before is clearly the one just before', () => {
    const ghosts = onionAround(layer([{ at: 0 }, { at: 1 }, { at: 2 }, { at: 3 }]), 3, on({ before: 3, after: 0, opacity: 0.6 }));
    expect(ghosts).toHaveLength(3);
    expect(ghosts[0].opacity).toBeCloseTo(0.6);
    expect(ghosts[0].opacity).toBeGreaterThan(ghosts[1].opacity);
    expect(ghosts[1].opacity).toBeGreaterThan(ghosts[2].opacity);
    expect(ghosts[2].opacity).toBeGreaterThan(0);
  });

  it('stops at the ends instead of inventing drawings', () => {
    expect(onionAround(layer([{ at: 0 }]), 0, on({ before: 5, after: 5 }))).toEqual([]);
  });

  it('shows nothing at no opacity, rather than draw an invisible layer', () => {
    expect(onionAround(layer([{ at: 0 }, { at: 1 }]), 1, on({ opacity: 0 }))).toEqual([]);
  });
});

describe('the cache key', () => {
  it('does not change while a drawing is held, which is what makes playback free', () => {
    const a = anim([layer([{ at: 0 }, { at: 8 }])], 2);
    expect(rasterKey(a, 1, 1920, 1080)).toBe(rasterKey(a, 7, 1920, 1080));
    expect(rasterKey(a, 7, 1920, 1080)).not.toBe(rasterKey(a, 8, 1920, 1080));
  });

  it('changes when a stroke is added, so the drawing is drawn again', () => {
    const before = anim([layer([{ at: 0 }])]);
    const after = anim([withStroke(layer([{ at: 0 }]), 0, stroke('new'))]);
    expect(rasterKey(before, 0, 1920, 1080)).not.toBe(rasterKey(after, 0, 1920, 1080));
  });

  it('changes with the size drawn at, and with a layer being hidden', () => {
    const a = anim([layer([{ at: 0 }])]);
    expect(rasterKey(a, 0, 1920, 1080)).not.toBe(rasterKey(a, 0, 960, 540));
    const hidden = anim([{ ...layer([{ at: 0 }]), visible: false }]);
    expect(rasterKey(a, 0, 1920, 1080)).not.toBe(rasterKey(hidden, 0, 1920, 1080));
  });

  it('separates the onion skin, so the export’s picture is not the viewer’s', () => {
    const a = anim([layer([{ at: 0 }, { at: 1 }])]);
    const onion: OnionSkin = { enabled: true, before: 1, after: 1, opacity: 0.4, by: 'drawings' };
    expect(rasterKey(a, 1, 1920, 1080)).not.toBe(rasterKey(a, 1, 1920, 1080, onion));
  });
});

describe('reading an animation from a file', () => {
  it('keeps a sound one and sorts its drawings', () => {
    const read = normalizeAnimation({
      step: 2,
      layers: [{ id: 'l', name: 'A', visible: true, opacity: 1, cels: [{ id: 'c2', at: 5, strokes: [stroke('s')] }, { id: 'c1', at: 0, strokes: [] }] }],
    });
    expect(read?.layers[0].cels.map((cel) => cel.at)).toEqual([0, 5]);
    expect(read?.step).toBe(2);
  });

  it('drops a stroke whose coordinates do not make whole points', () => {
    // Four numbers is not a point and a half: half a stroke would draw wrongly.
    const read = normalizeAnimation({
      step: 1,
      layers: [{ id: 'l', name: 'A', visible: true, opacity: 1, cels: [{ id: 'c', at: 0, strokes: [{ ...stroke('bad'), points: [0, 0, 1, 0.5] }, stroke('good')] }] }],
    });
    expect(read?.layers[0].cels[0].strokes.map((s) => s.id)).toEqual(['good']);
  });

  it('drops a stroke with a coordinate that is not a number', () => {
    const read = normalizeAnimation({
      step: 1,
      layers: [{ id: 'l', name: 'A', visible: true, opacity: 1, cels: [{ id: 'c', at: 0, strokes: [{ ...stroke('bad'), points: [0, 0, 'x' as unknown as number] }] }] }],
    });
    expect(read?.layers[0].cels[0].strokes).toEqual([]);
  });

  it('gives back nothing at all when there is nothing to draw', () => {
    expect(normalizeAnimation(undefined)).toBeUndefined();
    expect(normalizeAnimation({})).toBeUndefined();
    expect(normalizeAnimation({ layers: [] })).toBeUndefined();
    // A layer with no id cannot be addressed, so it is not a layer.
    expect(normalizeAnimation({ layers: [{ name: 'A' }] })).toBeUndefined();
  });

  it('mends what can be mended instead of throwing the drawing away', () => {
    const read = normalizeAnimation({
      step: 40,
      layers: [{ id: 'l', opacity: 5, cels: [{ id: 'c', at: 0, strokes: [{ ...stroke('s'), color: 'red', opacity: 9, size: -1 }] }] }],
    });
    expect(read?.step).toBe(8);
    expect(read?.layers[0].opacity).toBe(1);
    expect(read?.layers[0].name).toBe('Layer');
    const kept = read?.layers[0].cels[0].strokes[0];
    expect(kept?.color).toBe('#ffffff');
    expect(kept?.opacity).toBe(1);
    expect(kept?.size).toBeGreaterThan(0);
  });

  it('keeps only one drawing per exposure, since two could not both be shown', () => {
    const read = normalizeAnimation({
      step: 1,
      layers: [{ id: 'l', cels: [{ id: 'a', at: 3, strokes: [] }, { id: 'b', at: 3, strokes: [] }] }],
    });
    expect(read?.layers[0].cels).toHaveLength(1);
  });

  it('reads back what a new animation starts as', () => {
    const fresh = emptyAnimation();
    const read = normalizeAnimation(JSON.parse(JSON.stringify(fresh)));
    expect(read).toEqual(fresh);
  });
});

describe('moving between drawings', () => {
  it('steps to the next drawing that exists, not the next exposure', () => {
    const a = anim([layer([{ at: 0 }, { at: 6 }])], 2);
    const clip = clipAt(0, 60);
    expect(nextDrawing(a, clip, layer([{ at: 0 }, { at: 6 }]), 0)).toBe(6);
    expect(previousDrawing(layer([{ at: 0 }, { at: 6 }]), 6)).toBe(0);
    void a;
  });

  it('past the last drawing, goes one on so a new one can be started there', () => {
    const a = anim([layer([{ at: 0 }])], 2);
    expect(nextDrawing(a, clipAt(0, 60), layer([{ at: 0 }]), 0)).toBe(1);
  });

  it('stops at the ends of the clip rather than running past them', () => {
    // 8 frames on twos is 4 exposures: 0 to 3.
    const a = anim([layer([{ at: 0 }])], 2);
    expect(nextDrawing(a, clipAt(0, 8), layer([{ at: 0 }]), 3)).toBe(3);
    expect(previousDrawing(layer([{ at: 0 }]), 0)).toBe(0);
  });

  it('works on a layer with nothing drawn on it', () => {
    const a = anim([layer([])], 1);
    expect(nextDrawing(a, clipAt(0, 60), undefined, 4)).toBe(5);
    expect(previousDrawing(undefined, 4)).toBe(3);
  });
});

describe('the brush’s keys', () => {
  const press = (key: string, over: Partial<KeyboardEvent> = {}) =>
    drawKeyOf({ key, ctrlKey: false, metaKey: false, altKey: false, ...over } as KeyboardEvent);

  it('changes the width with the brackets every program uses', () => {
    expect(press(']')).toEqual({ kind: 'size', by: SIZE_STEP });
    expect(press('[')?.kind).toBe('size');
    expect((press('[') as { by: number }).by).toBeLessThan(1);
  });

  it('steps between drawings with the comma and the full stop', () => {
    expect(press('.')).toEqual({ kind: 'step', by: 1 });
    expect(press(',')).toEqual({ kind: 'step', by: -1 });
  });

  it('picks the eraser and the pencil, either case', () => {
    expect(press('e')).toEqual({ kind: 'brush', brush: 'eraser' });
    expect(press('E')).toEqual({ kind: 'brush', brush: 'eraser' });
    expect(press('P')).toEqual({ kind: 'brush', brush: 'pencil' });
  });

  it('leaves the editor’s own keys alone', () => {
    // B splits a clip and C is the razor: a hand reaches for those between
    // strokes, so the brush must not take them.
    expect(press('b')).toBeNull();
    expect(press('c')).toBeNull();
    expect(press('v')).toBeNull();
    expect(press(' ')).toBeNull();
  });

  it('never takes a key with a modifier, so Ctrl+Z still undoes a stroke', () => {
    expect(press('e', { ctrlKey: true })).toBeNull();
    expect(press(']', { altKey: true })).toBeNull();
    expect(press('.', { metaKey: true })).toBeNull();
  });
});

describe('a split or trimmed animation clip', () => {
  it('carries on from where it was cut, instead of going back to drawing one', () => {
    // Split at frame 20 of a clip on twos: the second piece starts at 20 with
    // 20 frames already behind it, which is exposure 10. Without
    // sourceOffsetFrames it would show exposure 0 again.
    const a = anim([layer([{ at: 0 }, { at: 10 }])], 2);
    const second = { startFrame: 20, durationFrames: 28, sourceOffsetFrames: 20 };
    expect(exposureAt(a, second, 20)).toBe(10);
    expect(exposureAt(a, second, 22)).toBe(11);
  });

  it('and the sheet still points at the frame a drawing is on', () => {
    const a = anim([layer([{ at: 0 }])], 2);
    const second = { startFrame: 20, durationFrames: 28, sourceOffsetFrames: 20 };
    expect(frameOfExposure(a, second, 10)).toBe(20);
    expect(exposureAt(a, second, frameOfExposure(a, second, 13))).toBe(13);
  });

  it('is unchanged for a clip that was never cut', () => {
    const a = anim([layer([{ at: 0 }])], 2);
    expect(exposureAt(a, { startFrame: 10, sourceOffsetFrames: 0 }, 14)).toBe(2);
    expect(exposureAt(a, { startFrame: 10 }, 14)).toBe(2);
  });
});

describe('cut-out animation: a layer moved as a whole', () => {
  const key = (frame: number, value: unknown) => ({ id: `k${frame}`, frame, value, easing: 'linear' as const });
  const moving = (id: string, motion: object, parentId?: string): AnimationLayer => ({
    ...layer([{ at: 0 }]),
    id,
    motion: motion as AnimationLayer['motion'],
    ...(parentId ? { parentId } : {}),
  });

  it('sits still when it has no motion at all', () => {
    expect(placeOf(undefined, 10)).toEqual(NO_PLACE);
    expect(isMoved(placeOf(undefined, 10))).toBe(false);
  });

  it('interpolates between keyframes, with the app’s own easings', () => {
    const motion = { position: [key(0, { x: 0, y: 0 }), key(10, { x: 0.5, y: 0.25 })] };
    expect(placeOf(motion as never, 0).x).toBeCloseTo(0);
    expect(placeOf(motion as never, 5).x).toBeCloseTo(0.25);
    expect(placeOf(motion as never, 10).x).toBeCloseTo(0.5);
    expect(placeOf(motion as never, 5).y).toBeCloseTo(0.125);
  });

  it('holds the first and last values outside the keyframes, as every other track does', () => {
    const motion = { rotation: [key(10, 0), key(20, 90)] };
    expect(placeOf(motion as never, 0).rotation).toBe(0);
    expect(placeOf(motion as never, 999).rotation).toBe(90);
  });

  it('takes the middle as the pivot unless one is given', () => {
    expect(placeOf({ rotation: [key(0, 45)] } as never, 0).pivotX).toBe(0.5);
    expect(placeOf({ rotation: [key(0, 45)], pivot: { x: 0.2, y: 0.8 } } as never, 0).pivotY).toBe(0.8);
  });

  it('builds the chain furthest ancestor first, so a hand follows its arm', () => {
    const hand = moving('hand', {}, 'arm');
    const arm = moving('arm', {}, 'body');
    const body = moving('body', {});
    const layers = [body, arm, hand];
    expect(chainOf(layers, hand).map((link) => link.id)).toEqual(['body', 'arm', 'hand']);
    expect(chainOf(layers, body).map((link) => link.id)).toEqual(['body']);
  });

  it('refuses a loop rather than hang, and ignores a parent that is not there', () => {
    const a = moving('a', {}, 'b');
    const b = moving('b', {}, 'a');
    expect(chainOf([a, b], a).map((link) => link.id)).toEqual(['b', 'a']);
    // Its own parent, and a parent that does not exist: neither is a chain.
    const lonely = moving('lonely', {}, 'ghost');
    expect(chainOf([lonely], lonely).map((link) => link.id)).toEqual(['lonely']);
  });

  it('the cache key changes as a layer moves, so a held drawing is drawn again', () => {
    // A drawing held across the whole clip, but the layer moving: without the
    // motion in the key the picture would freeze on the first frame.
    const l = moving('arm', { position: [key(0, { x: 0, y: 0 }), key(10, { x: 0.5, y: 0 })] });
    const a = anim([l], 2);
    expect(rasterKey(a, 0, 1920, 1080, undefined, 0)).not.toBe(rasterKey(a, 0, 1920, 1080, undefined, 5));
  });

  it('and does not change for a layer that never moves', () => {
    const a = anim([layer([{ at: 0 }])], 2);
    expect(rasterKey(a, 0, 1920, 1080, undefined, 0)).toBe(rasterKey(a, 0, 1920, 1080, undefined, 5));
  });

  it('reads a rig back from a file, and drops what it cannot play', () => {
    const read = normalizeAnimation({
      step: 2,
      layers: [
        {
          id: 'arm',
          cels: [{ id: 'c', at: 0, strokes: [] }],
          parentId: 'body',
          motion: {
            position: [
              { id: 'a', frame: 10, value: { x: 0.2, y: 0.1 }, easing: 'bounce' },
              { id: 'b', frame: 0, value: { x: 0, y: 0 }, easing: 'linear' },
              // Not playable: dropped rather than jumped to.
              { id: 'c', frame: 5, value: { x: Number.NaN, y: 0 } },
              { id: 'd', frame: 'soon', value: { x: 1, y: 1 } },
            ],
            rotation: [{ id: 'r', frame: 0, value: 45, easing: 'nonsense' }],
          },
        },
      ],
    });
    const arm = read?.layers[0];
    expect(arm?.parentId).toBe('body');
    expect(arm?.motion?.position?.map((k) => k.frame)).toEqual([0, 10]);
    expect(arm?.motion?.position?.[1].easing).toBe('bounce');
    // An easing this build does not know becomes the plainest one.
    expect(arm?.motion?.rotation?.[0].easing).toBe('linear');
  });

  it('a layer with nothing playable carries no motion at all', () => {
    const read = normalizeAnimation({
      step: 1,
      layers: [{ id: 'l', cels: [{ id: 'c', at: 0, strokes: [] }], motion: { position: [], rotation: 'none' } }],
    });
    expect(read?.layers[0].motion).toBeUndefined();
    // And a layer cannot be its own parent.
    const self = normalizeAnimation({ step: 1, layers: [{ id: 'l', parentId: 'l', cels: [] }] });
    expect(self?.layers[0].parentId).toBeUndefined();
  });
});

describe('shapes dragged out', () => {
  const pt = (points: number[], index: number) => ({ x: points[index * 3], y: points[index * 3 + 1], p: points[index * 3 + 2] });
  const from = { x: 0.2, y: 0.3 };
  const to = { x: 0.6, y: 0.7 };

  it('a line is its two ends, at full pressure so it draws evenly', () => {
    const points = shapePoints({ kind: 'line', from, to });
    expect(points).toHaveLength(6);
    expect(pt(points, 0)).toEqual({ x: 0.2, y: 0.3, p: 1 });
    expect(pt(points, 1)).toEqual({ x: 0.6, y: 0.7, p: 1 });
  });

  it('a rectangle closes, or its last side would be missing', () => {
    const points = shapePoints({ kind: 'rectangle', from, to });
    expect(points).toHaveLength(15);
    expect(pt(points, 0)).toEqual(pt(points, 4));
    // Every corner, whichever way the drag went.
    const corners = [0, 1, 2, 3].map((index) => pt(points, index));
    expect(new Set(corners.map((c) => `${c.x},${c.y}`)).size).toBe(4);
  });

  it('a rectangle is the same however the drag runs', () => {
    const forwards = shapePoints({ kind: 'rectangle', from, to });
    const backwards = shapePoints({ kind: 'rectangle', from: to, to: from });
    expect(new Set(forwards).size).toBe(new Set(backwards).size);
    expect(Math.min(...forwards.filter((_, i) => i % 3 === 0))).toBeCloseTo(0.2);
  });

  it('an ellipse is round the middle of the drag and closes on itself', () => {
    const points = shapePoints({ kind: 'ellipse', from, to });
    expect(pt(points, 0).x).toBeCloseTo(pt(points, points.length / 3 - 1).x);
    expect(pt(points, 0).y).toBeCloseTo(pt(points, points.length / 3 - 1).y);
    const xs = points.filter((_, i) => i % 3 === 0);
    const ys = points.filter((_, i) => i % 3 === 1);
    // It fills the drag exactly: left to right, top to bottom.
    expect(Math.min(...xs)).toBeCloseTo(0.2);
    expect(Math.max(...xs)).toBeCloseTo(0.6);
    expect(Math.min(...ys)).toBeCloseTo(0.3);
    expect(Math.max(...ys)).toBeCloseTo(0.7);
  });

  it('a polygon has the sides asked for, and points upwards', () => {
    for (const sides of [3, 5, 8]) {
      const points = shapePoints({ kind: 'polygon', from, to, sides });
      // One point per side, plus the first again to close it.
      expect(points.length / 3).toBe(sides + 1);
      expect(pt(points, 0).x).toBeCloseTo(0.4);
      expect(pt(points, 0).y).toBeCloseTo(0.3);
    }
  });

  it('a polygon refuses a side count that is not a polygon', () => {
    expect(shapePoints({ kind: 'polygon', from, to, sides: 1 }).length / 3).toBe(MIN_SIDES + 1);
    expect(shapePoints({ kind: 'polygon', from, to, sides: 99 }).length / 3).toBe(MAX_SIDES + 1);
  });

  it('Shift squares a rectangle and circles an ellipse', () => {
    const points = shapePoints({ kind: 'rectangle', from: { x: 0.2, y: 0.2 }, to: { x: 0.8, y: 0.3 }, even: true });
    const xs = points.filter((_, i) => i % 3 === 0);
    const ys = points.filter((_, i) => i % 3 === 1);
    // Measured from the LONGER side, so the shape follows the hand.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.6);
  });

  it('Shift holds a line to a right angle, along whichever way it went further', () => {
    const across = shapePoints({ kind: 'line', from: { x: 0.2, y: 0.2 }, to: { x: 0.8, y: 0.25 }, even: true });
    expect(pt(across, 1).y).toBeCloseTo(0.2);
    const down = shapePoints({ kind: 'line', from: { x: 0.2, y: 0.2 }, to: { x: 0.25, y: 0.8 }, even: true });
    expect(pt(down, 1).x).toBeCloseTo(0.2);
  });

  it('a shape becomes an ordinary stroke, which is what makes everything else work on it', () => {
    const stroke = shapeStroke({ kind: 'ellipse', from, to }, { brush: 'pencil', color: '#ff0000', size: 0.01, opacity: 1 });
    expect(stroke.id).toBeTruthy();
    expect(stroke.color).toBe('#ff0000');
    // And it survives a save and a load like any other stroke.
    const read = normalizeAnimation({
      step: 1,
      layers: [{ id: 'l', cels: [{ id: 'c', at: 0, strokes: [JSON.parse(JSON.stringify(stroke))] }] }],
    });
    expect(read?.layers[0].cels[0].strokes[0].points).toEqual(stroke.points);
  });

  it('ignores a slip of the hand that is not really a drag', () => {
    expect(isRealDrag({ x: 0.5, y: 0.5 }, { x: 0.5006, y: 0.5 })).toBe(false);
    expect(isRealDrag({ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5 })).toBe(true);
  });
});
