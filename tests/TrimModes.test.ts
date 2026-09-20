import { describe, expect, it } from 'vitest';
import {
  neighbours,
  rippleTrim,
  rollEdit,
  slideClip,
  slipClip,
  trimTargetAt,
} from '../src/renderer/components/Timeline/trimModes';
import { createClip } from '../src/renderer/store/types';
import type { Clip } from '../src/shared/types';

const clip = (id: string, start: number, length: number, offset = 0, trackId = 'v1'): Clip => ({
  ...createClip({ trackId, name: id, sourceUri: `blob:${id}`, startFrame: start, durationFrames: length }),
  id,
  sourceOffsetFrames: offset,
});

const byId = (...clips: Clip[]): Record<string, Clip> => Object.fromEntries(clips.map((c) => [c.id, c]));
const shape = (clips: Record<string, Clip>, id: string): [number, number, number] => [
  clips[id].startFrame,
  clips[id].durationFrames,
  clips[id].sourceOffsetFrames,
];

// Three clips in a row, each 100 frames, starting 200 frames into their source.
const row = (): Record<string, Clip> => byId(clip('a', 0, 100, 200), clip('b', 100, 100, 200), clip('c', 200, 100, 200));

describe('ripple', () => {
  it('trims the tail and pulls everything after it back', () => {
    const after = rippleTrim(row(), 'b', 'end', 160);
    expect(shape(after, 'b')).toEqual([100, 60, 200]);
    expect(shape(after, 'c')).toEqual([160, 100, 200]);
    expect(shape(after, 'a')).toEqual([0, 100, 200]);
  });

  it('trims the head, leaves the clip where it was, and closes up behind it', () => {
    const after = rippleTrim(row(), 'b', 'start', 130);
    // Same place on the timeline, 30 frames shorter, showing footage 30 later.
    expect(shape(after, 'b')).toEqual([100, 70, 230]);
    // The rest comes back by those 30 frames: no gap, nothing overlapping.
    expect(shape(after, 'c')).toEqual([170, 100, 200]);
  });

  it('will not trim a clip out of existence', () => {
    const after = rippleTrim(row(), 'b', 'end', 100);
    expect(after.b.durationFrames).toBeGreaterThanOrEqual(1);
  });

  it('cannot show footage from before the source starts', () => {
    // Only 200 frames of head room, so the start cannot go back further.
    const after = rippleTrim(byId(clip('a', 500, 100, 200)), 'a', 'start', 100);
    expect(after.a.sourceOffsetFrames).toBe(0);
    expect(after.a.startFrame).toBe(500);
    expect(after.a.durationFrames).toBe(300);
  });

  it('cannot stretch the tail past the end of the footage', () => {
    // 1000 frames of source, 200 already used: 800 left from this point.
    const after = rippleTrim(byId(clip('a', 0, 100, 200)), 'a', 'end', 5000, 1000);
    expect(after.a.durationFrames).toBe(800);
  });
});

describe('roll', () => {
  it('moves the join: one gives what the other takes, and the length holds', () => {
    const before = row();
    const after = rollEdit(before, 'a', 'b', 130);
    expect(shape(after, 'a')).toEqual([0, 130, 200]);
    expect(shape(after, 'b')).toEqual([130, 70, 230]);
    expect(shape(after, 'c')).toEqual([200, 100, 200]);
  });

  it('stops where either clip runs out of footage', () => {
    // b has 200 frames of head room; a has 60 frames of tail left.
    const after = rollEdit(row(), 'a', 'b', 400, { left: 260, right: 1000 });
    expect(after.a.durationFrames).toBe(60);
    expect(after.b.startFrame).toBe(60);
  });

  it('leaves each clip at least a frame', () => {
    const after = rollEdit(row(), 'a', 'b', -500);
    expect(after.a.durationFrames).toBeGreaterThanOrEqual(1);
    expect(after.b.durationFrames).toBeGreaterThanOrEqual(1);
  });
});

describe('slip', () => {
  it('changes which footage shows, and nothing else', () => {
    const slipped = slipClip(clip('a', 100, 100, 200), 40);
    expect([slipped.startFrame, slipped.durationFrames, slipped.sourceOffsetFrames]).toEqual([100, 100, 240]);
  });

  it('stops at both ends of the footage', () => {
    expect(slipClip(clip('a', 0, 100, 20), -500).sourceOffsetFrames).toBe(0);
    // 300 frames of source, 100 of clip: the last place it can start is 200.
    expect(slipClip(clip('a', 0, 100, 20), 500, 300).sourceOffsetFrames).toBe(200);
  });
});

describe('slide', () => {
  it('moves the clip and lets its neighbours give and take', () => {
    const after = slideClip(row(), 'b', 30);
    expect(shape(after, 'b')).toEqual([130, 100, 200]);
    expect(shape(after, 'a')).toEqual([0, 130, 200]);
    expect(shape(after, 'c')).toEqual([230, 70, 230]);
  });

  it('stops when a neighbour would vanish', () => {
    const after = slideClip(row(), 'b', -500);
    expect(after.a.durationFrames).toBeGreaterThanOrEqual(1);
    expect(after.b.startFrame).toBeGreaterThanOrEqual(1);
  });

  it('stops when the next clip would need footage it does not have', () => {
    // c starts 10 frames into its source, so it can only grow 10 frames at the head.
    const clips = byId(clip('a', 0, 100, 200), clip('b', 100, 100, 200), clip('c', 200, 100, 10));
    const after = slideClip(clips, 'b', -50);
    expect(after.c.sourceOffsetFrames).toBe(0);
    expect(after.b.startFrame).toBe(90);
  });

  it('leaves a clip with no neighbours free to move', () => {
    const after = slideClip(byId(clip('a', 100, 50, 0)), 'a', 40);
    expect(after.a.startFrame).toBe(140);
  });
});

describe('which trim the pointer means', () => {
  const clips = row();

  it('is a roll on a join two clips share', () => {
    expect(trimTargetAt(clips, clips.b, 100, 0.5, 6)).toEqual({ mode: 'roll', clipId: 'a', otherId: 'b', edge: 'end' });
    expect(trimTargetAt(clips, clips.b, 200, 0.5, 6)).toEqual({ mode: 'roll', clipId: 'b', otherId: 'c', edge: 'end' });
  });

  it('is a ripple on an edge with nothing beside it', () => {
    const alone = byId(clip('a', 0, 100, 200));
    expect(trimTargetAt(alone, alone.a, 2, 0.5, 6)).toEqual({ mode: 'ripple', clipId: 'a', edge: 'start' });
    expect(trimTargetAt(alone, alone.a, 98, 0.5, 6)).toEqual({ mode: 'ripple', clipId: 'a', edge: 'end' });
  });

  it('is a slip over the body, a slide lower down', () => {
    expect(trimTargetAt(clips, clips.b, 150, 0.2, 6).mode).toBe('slip');
    expect(trimTargetAt(clips, clips.b, 150, 0.8, 6).mode).toBe('slide');
  });

  it('knows a clip\'s neighbours', () => {
    expect(neighbours(clips, clips.b).previous?.id).toBe('a');
    expect(neighbours(clips, clips.b).next?.id).toBe('c');
    expect(neighbours(clips, clips.a).previous).toBeNull();
  });
});
