import { describe, expect, it } from 'vitest';

import {
  clipTrimRoom,
  expandSelection,
  isLinked,
  linkClips,
  partnersOf,
  sharedTrimDelta,
  tidyLinkGroups,
  unlinkClips,
} from '@renderer/components/Timeline/linkGroups';
import type { Clip } from '@shared/types';

const clip = (id: string, overrides: Partial<Clip> = {}): Clip =>
  ({
    id,
    trackId: 'v1',
    name: id,
    sourceUri: `blob:${id}`,
    startFrame: 0,
    durationFrames: 100,
    sourceOffsetFrames: 0,
    hasAlphaChannel: false,
    volume: 1,
    pan: 0,
    ...overrides,
  }) as Clip;

const index = (...list: Clip[]): Record<string, Clip> =>
  Object.fromEntries(list.map((entry) => [entry.id, entry]));

describe('linking clips', () => {
  it('links a selection into one group', () => {
    const linked = linkClips(index(clip('a'), clip('b'), clip('c')), ['a', 'b']);
    expect(linked.a.linkGroup).toBeDefined();
    expect(linked.b.linkGroup).toBe(linked.a.linkGroup);
    expect(linked.c.linkGroup).toBeUndefined();
  });

  it('refuses to link one clip to itself: a group of one is not a group', () => {
    const clips = index(clip('a'));
    expect(linkClips(clips, ['a'])).toBe(clips);
  });

  it('joins two groups rather than splitting one', () => {
    // b was linked to c; linking a to b cannot leave c behind and still mean
    // "these move as one".
    let clips = linkClips(index(clip('a'), clip('b'), clip('c')), ['b', 'c']);
    clips = linkClips(clips, ['a', 'b']);
    expect(new Set([clips.a.linkGroup, clips.b.linkGroup, clips.c.linkGroup]).size).toBe(1);
  });

  it('unlinks the whole group, not just the clip that was clicked', () => {
    const clips = unlinkClips(linkClips(index(clip('a'), clip('b')), ['a', 'b']), ['a']);
    expect(clips.a.linkGroup).toBeUndefined();
    expect(clips.b.linkGroup).toBeUndefined();
  });

  it('says whether a selection is already one group', () => {
    const clips = linkClips(index(clip('a'), clip('b'), clip('c')), ['a', 'b']);
    expect(isLinked(clips, ['a', 'b'])).toBe(true);
    expect(isLinked(clips, ['a', 'c'])).toBe(false);
    expect(isLinked(clips, ['a'])).toBe(false);
    expect(isLinked(index(clip('a'), clip('b')), ['a', 'b'])).toBe(false);
  });
});

describe('what a click on a linked clip selects', () => {
  it('brings every partner along, with the clicked clip still first', () => {
    const clips = linkClips(index(clip('a'), clip('b'), clip('c')), ['a', 'c']);
    expect(expandSelection(clips, ['c'])).toEqual(['c', 'a']);
    expect(expandSelection(clips, ['b'])).toEqual(['b']);
  });

  it('names no clip twice when partners are selected together', () => {
    const clips = linkClips(index(clip('a'), clip('b')), ['a', 'b']);
    expect(expandSelection(clips, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('leaves a clip that is gone out of it', () => {
    expect(partnersOf(index(clip('a')), 'ghost')).toEqual([]);
  });
});

describe('a group that has lost its other half', () => {
  it('stops claiming to be linked', () => {
    const linked = linkClips(index(clip('a'), clip('b')), ['a', 'b']);
    const { b: _deleted, ...left } = linked;
    expect(tidyLinkGroups(left).a.linkGroup).toBeUndefined();
  });

  it('leaves a group that still has two members alone', () => {
    const linked = linkClips(index(clip('a'), clip('b')), ['a', 'b']);
    expect(tidyLinkGroups(linked)).toBe(linked);
  });
});

describe('trimming linked clips in step', () => {
  const room = { left: 0, right: 0 };

  it('measures what one edge can give', () => {
    // 40 frames of footage used from frame 10; the next clip starts at 200.
    const target = clip('a', { startFrame: 100, durationFrames: 40, sourceOffsetFrames: 10 });
    expect(clipTrimRoom(target, 'start', 80, 200)).toEqual({ left: 10, right: 39 });
    expect(clipTrimRoom(target, 'end', 200, 200)).toEqual({ left: 39, right: 60 });
  });

  it('lets a still be held for as long as anyone likes', () => {
    const still = clip('a', { startFrame: 0, durationFrames: 50 });
    expect(clipTrimRoom(still, 'end', 1000).right).toBe(950);
  });

  it('stops the end at the last frame the file has', () => {
    const target = clip('a', { startFrame: 0, durationFrames: 50, sourceOffsetFrames: 0 });
    expect(clipTrimRoom(target, 'end', 1000, 60).right).toBe(10);
  });

  it('never lets the head go before the start of the timeline', () => {
    const target = clip('a', { startFrame: 5, durationFrames: 50, sourceOffsetFrames: 40 });
    expect(clipTrimRoom(target, 'start', 0, 90).left).toBe(5);
  });

  it('moves every edge by what the tightest clip can take', () => {
    expect(sharedTrimDelta([{ ...room, right: 30 }, { ...room, right: 12 }], 20)).toBe(12);
    expect(sharedTrimDelta([{ ...room, left: 30 }, { ...room, left: 12 }], -20)).toBe(-12);
  });

  it('gives the whole move when everyone has the room', () => {
    expect(sharedTrimDelta([{ ...room, right: 30 }, { ...room, right: 30 }], 20)).toBe(20);
  });

  it('stays put when one of them cannot move at all', () => {
    expect(sharedTrimDelta([{ ...room, right: 30 }, room], 20)).toBe(0);
  });
});
