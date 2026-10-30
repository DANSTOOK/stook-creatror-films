import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe, Vector2D } from '@shared/types';
import { createClip } from '@renderer/store/types';
import { createEffect } from '@renderer/fx/effects/catalog';
import { audioRowId, clipSpan, effectRowId, neighbourKeyframe, removeKeyframes, retime, rowsOf, setEasing, setKeyframeValue, toggleKeyframeAt, transformRowId } from '@renderer/keyframes/rows';

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

/**
 * The sound rows (audio keyframes): shown only for a clip that has sound, and
 * edited through exactly the same machinery as the transform's, so a move, a
 * curve and a delete behave the same way on a volume row as on a position one.
 */
describe('the sound rows', () => {
  it('are left out for a clip with no sound, and added for one that has', () => {
    expect(rowsOf(fixture()).some((row) => row.group === 'audio')).toBe(false);
    const rows = rowsOf(fixture(), true);
    expect(rows.filter((row) => row.group === 'audio').map((row) => row.id)).toEqual([audioRowId('volume'), audioRowId('pan')]);
    // Between the transform and the effects, where the inspector puts them.
    expect(rows.map((row) => row.group)).toEqual(['transform', 'transform', 'transform', 'transform', 'audio', 'audio', 'effect']);
  });

  it('read the fader while there is no curve, and the curve once there is', () => {
    const clip = { ...fixture(), volume: 0.5 };
    const [volume] = rowsOf(clip, true).filter((row) => row.group === 'audio');
    expect(volume.keyframes).toEqual([]);
    expect(volume.channels[0].at(150)).toBeCloseTo(0.5, 6);
    expect(volume.channels[0].range).toEqual([0, 2]);

    const curved = apply(clip, toggleKeyframeAt(clip, audioRowId('volume'), 120));
    expect(curved.volumeKeyframes?.map((k) => k.frame)).toEqual([120]);
    // The diamond takes the value the row had there, so nothing jumps.
    expect(curved.volumeKeyframes?.[0].value).toBeCloseTo(0.5, 6);
  });

  it('move, ease and hold like any other row', () => {
    let clip = { ...fixture(), volume: 1 };
    clip = apply(clip, toggleKeyframeAt(clip, audioRowId('volume'), 110));
    clip = apply(clip, toggleKeyframeAt(clip, audioRowId('volume'), 170));
    const [first, second] = clip.volumeKeyframes ?? [];
    clip = apply(clip, setKeyframeValue(clip, audioRowId('volume'), second.id, 'value', 0));
    const row = rowsOf(clip, true).find((candidate) => candidate.id === audioRowId('volume'));
    // Half way between 1 at frame 110 and 0 at frame 170.
    expect(row?.channels[0].at(140)).toBeCloseTo(0.5, 6);

    clip = apply(clip, retime(clip, [{ row: audioRowId('volume'), id: second.id }], -20));
    expect(clip.volumeKeyframes?.map((k) => k.frame)).toEqual([110, 150]);
    clip = apply(clip, setEasing(clip, [{ row: audioRowId('volume'), id: first.id }], 'hold'));
    expect(clip.volumeKeyframes?.[0].easing).toBe('hold');
    // Held: still full gain just before the second keyframe.
    const held = rowsOf(clip, true).find((candidate) => candidate.id === audioRowId('volume'));
    expect(held?.channels[0].at(149)).toBeCloseTo(1, 6);
  });

  it('a keyframe cannot be moved out of the clip', () => {
    let clip = { ...fixture(), volume: 1 };
    clip = apply(clip, toggleKeyframeAt(clip, audioRowId('volume'), 110));
    const [only] = clip.volumeKeyframes ?? [];
    clip = apply(clip, retime(clip, [{ row: audioRowId('volume'), id: only.id }], -500));
    expect(clip.volumeKeyframes?.[0].frame).toBe(clipSpan(clip)[0]);
  });

  it('deleting the last keyframe leaves the fader where the curve had got to', () => {
    let clip = { ...fixture(), volume: 1 };
    clip = apply(clip, toggleKeyframeAt(clip, audioRowId('volume'), 110));
    const [only] = clip.volumeKeyframes ?? [];
    clip = apply(clip, setKeyframeValue(clip, audioRowId('volume'), only.id, 'value', 0.25));
    const after = apply(clip, removeKeyframes(clip, [{ row: audioRowId('volume'), id: only.id }], 150));
    expect(after.volumeKeyframes).toEqual([]);
    // Not back to 1, which is what the fader said before the curve was drawn.
    expect(after.volume).toBeCloseTo(0.25, 6);
  });

  it('the pan row keeps to its own range', () => {
    let clip = { ...fixture(), pan: 0 };
    clip = apply(clip, toggleKeyframeAt(clip, audioRowId('pan'), 110));
    const [only] = clip.panKeyframes ?? [];
    clip = apply(clip, setKeyframeValue(clip, audioRowId('pan'), only.id, 'value', -3));
    const row = rowsOf(clip, true).find((candidate) => candidate.id === audioRowId('pan'));
    expect(row?.channels[0].range).toEqual([-1, 1]);
    // Stored as asked, but never heard beyond hard left.
    expect(row?.channels[0].at(110)).toBe(-1);
  });
});
