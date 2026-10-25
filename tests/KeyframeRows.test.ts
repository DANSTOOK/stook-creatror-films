import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe, Vector2D } from '@shared/types';
import { createClip } from '@renderer/store/types';
import { createEffect } from '@renderer/fx/effects/catalog';
import { clipSpan, effectRowId, neighbourKeyframe, removeKeyframes, retime, rowsOf, setEasing, setKeyframeValue, toggleKeyframeAt, transformRowId } from '@renderer/keyframes/rows';

/**
 * What the keyframe editor shows of a clip and the edits it makes
 * (renderer/keyframes/rows): the rows, a move of several keyframes at once,
 * the shapes of their moves, removing and adding at the playhead.
 */

const key = <T extends number | Vector2D>(id: string, frame: number, value: T): Keyframe<T> => ({ id, frame, value, easing: 'linear' });

function fixture(): Clip {
  const clip = createClip({ trackId: 't', name: 'clip', sourceUri: 'file://a.mp4', startFrame: 100, durationFrames: 100 });
  const blur = { ...createEffect('gaussianBlur'), id: 'fx1' };
  return {
    ...clip,
    transform: {
      ...clip.transform,
      position: [key('p1', 100, { x: 0, y: 0 }), key('p2', 150, { x: 100, y: 50 })],
      opacity: [key('o1', 120, 0), key('o2', 140, 1)],
    },
    effects: [{ ...blur, keyframes: { radius: [key('r1', 110, 0), key('r2', 190, 40)] } }],
  };
}

const apply = (clip: Clip, patch: Partial<Clip>): Clip => ({ ...clip, ...patch });

describe('rowsOf', () => {
  it('the transform first, then every setting of every effect that can move, with their keyframes and curves', () => {
    const rows = rowsOf(fixture());
    expect(rows.map((row) => row.id)).toEqual([
      transformRowId('position'), transformRowId('scale'), transformRowId('rotation'), transformRowId('opacity'), effectRowId('fx1', 'radius'),
    ]);
    const position = rows[0];
    expect(position.keyframes.map((k) => k.frame)).toEqual([100, 150]);
    expect(position.channels.map((channel) => channel.id)).toEqual(['x', 'y']);
    expect(position.channels[0].at(125)).toBeCloseTo(50, 6);
    expect(rows[3].channels[0].range).toEqual([0, 1]);
    expect(rows[4].channels[0].at(150)).toBeCloseTo(20, 6);
  });
});

describe('retime', () => {
  it('moves several keyframes of several rows together', () => {
    const clip = fixture();
    const moved = apply(clip, retime(clip, [{ row: transformRowId('position'), id: 'p2' }, { row: effectRowId('fx1', 'radius'), id: 'r1' }], 5));
    expect(moved.transform.position.map((k) => k.frame)).toEqual([100, 155]);
    expect(moved.effects?.[0].keyframes?.radius.map((k) => k.frame)).toEqual([115, 190]);
  });

  it('stops at the clip’s ends, and short of a keyframe that is not moving', () => {
    const clip = fixture();
    expect(clipSpan(clip)).toEqual([100, 199]);
    const late = apply(clip, retime(clip, [{ row: transformRowId('position'), id: 'p2' }], 500));
    expect(late.transform.position[1].frame).toBe(199);
    // p2 cannot land on p1's frame: it stops one after it.
    const early = apply(clip, retime(clip, [{ row: transformRowId('position'), id: 'p2' }], -50));
    expect(early.transform.position.map((k) => k.frame)).toEqual([100, 101]);
    // Held at the start: nothing moves earlier than the clip.
    expect(retime(clip, [{ row: transformRowId('position'), id: 'p1' }], -10)).toEqual({});
  });
});

describe('the other edits', () => {
  it('setEasing gives the picked keyframes their move, and a custom bezier its handles', () => {
    const clip = fixture();
    const curve = { cp1: { x: 0.2, y: 0.9 }, cp2: { x: 0.3, y: 1 } };
    const eased = apply(clip, setEasing(clip, [{ row: transformRowId('opacity'), id: 'o1' }], 'bezier', curve));
    expect(eased.transform.opacity[0]).toMatchObject({ easing: 'bezier', bezierParams: curve });
    const plain = apply(eased, setEasing(eased, [{ row: transformRowId('opacity'), id: 'o1' }], 'easeOut'));
    expect(plain.transform.opacity[0].easing).toBe('easeOut');
    expect(plain.transform.opacity[0].bezierParams).toBeUndefined();
  });

  it('removing every keyframe of a row holds the value it had at the playhead', () => {
    const clip = fixture();
    const gone = apply(clip, removeKeyframes(clip, [{ row: transformRowId('opacity'), id: 'o1' }, { row: transformRowId('opacity'), id: 'o2' }], 130));
    expect(gone.transform.opacity).toHaveLength(1);
    expect(gone.transform.opacity[0].value).toBeCloseTo(0.5, 6);
    const blurGone = apply(clip, removeKeyframes(clip, [{ row: effectRowId('fx1', 'radius'), id: 'r1' }, { row: effectRowId('fx1', 'radius'), id: 'r2' }], 150));
    expect(blurGone.effects?.[0].keyframes).toBeUndefined();
    expect(blurGone.effects?.[0].params.radius).toBeCloseTo(20, 6);
  });

  it('the diamond adds a keyframe with the row’s value there, and removes one that is there', () => {
    const clip = fixture();
    const added = apply(clip, toggleKeyframeAt(clip, transformRowId('position'), 125));
    expect(added.transform.position.map((k) => k.frame)).toEqual([100, 125, 150]);
    expect(added.transform.position[1].value).toEqual({ x: 50, y: 25 });
    const removed = apply(added, toggleKeyframeAt(added, transformRowId('position'), 125));
    expect(removed.transform.position.map((k) => k.frame)).toEqual([100, 150]);
  });

  it('a keyframe’s value set on one channel (the graph’s drag), and ◀ ▶ find the neighbours', () => {
    const clip = fixture();
    const raised = apply(clip, setKeyframeValue(clip, transformRowId('position'), 'p2', 'y', 80));
    expect(raised.transform.position[1].value).toEqual({ x: 100, y: 80 });
    const rows = rowsOf(clip);
    expect(neighbourKeyframe(rows, 125, 1)).toBe(140);
    expect(neighbourKeyframe(rows, 125, -1)).toBe(120);
    expect(neighbourKeyframe(rows, 199, 1)).toBeNull();
  });
});
