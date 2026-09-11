import { describe, expect, it } from 'vitest';
import type { Clip, ProjectState } from '@shared/types';
import {
  DEFAULT_SNAP_THRESHOLD_PX,
  collectSnapTargets,
  frameToPixel,
  pixelToFrame,
  snapClipMove,
  snapFrame,
} from '@renderer/components/Timeline/snapping';
import {
  clipEndFrame,
  moveClip,
  splitClip,
  splitKeyframeTrack,
  trimClipEnd,
  trimClipStart,
} from '@renderer/components/Timeline/timelineOps';
import { createClip, createEmptyProject } from '@renderer/store/types';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    ...createClip({
      trackId: 'track-1',
      name: 'Clip',
      sourceUri: 'blob:clip',
      startFrame: 100,
      durationFrames: 60,
    }),
    ...overrides,
  };
}

function makeProject(clips: Clip[]): ProjectState {
  const project = createEmptyProject();
  return {
    ...project,
    currentFrame: 0,
    clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])),
  };
}

describe('snapFrame', () => {
  const targets = [
    { frame: 100, kind: 'clip-start' as const },
    { frame: 160, kind: 'clip-end' as const },
  ];

  it('snaps to a target inside the pixel threshold', () => {
    // 4 frames away at 2 px/frame is 8 px, inside the 10 px threshold.
    const result = snapFrame(104, targets, { pixelsPerFrame: 2 });
    expect(result.snapped).toBe(true);
    expect(result.frame).toBe(100);
    expect(result.distancePx).toBe(8);
  });

  it('leaves a frame outside the threshold alone', () => {
    // 6 frames at 2 px/frame is 12 px, outside the threshold.
    const result = snapFrame(106, targets, { pixelsPerFrame: 2 });
    expect(result.snapped).toBe(false);
    expect(result.frame).toBe(106);
  });

  it('measures the threshold in pixels, so zoom changes what snaps', () => {
    // The same 20-frame gap snaps when zoomed out and does not when zoomed in.
    expect(snapFrame(120, targets, { pixelsPerFrame: 0.25 }).snapped).toBe(true);
    expect(snapFrame(120, targets, { pixelsPerFrame: 4 }).snapped).toBe(false);
  });

  it('uses a 10px threshold by default', () => {
    expect(DEFAULT_SNAP_THRESHOLD_PX).toBe(10);
    expect(snapFrame(110, targets, { pixelsPerFrame: 1 }).snapped).toBe(true);
    expect(snapFrame(111, targets, { pixelsPerFrame: 1 }).snapped).toBe(false);
  });

  it('picks the nearest of several candidates', () => {
    const crowded = [
      { frame: 100, kind: 'clip-start' as const },
      { frame: 104, kind: 'clip-end' as const },
    ];
    expect(snapFrame(103, crowded, { pixelsPerFrame: 2 }).frame).toBe(104);
  });

  it('resolves a tie to the earlier target', () => {
    const tied = [
      { frame: 98, kind: 'clip-end' as const },
      { frame: 102, kind: 'clip-start' as const },
    ];
    expect(snapFrame(100, tied, { pixelsPerFrame: 2 }).frame).toBe(98);
  });

  it('does nothing when snapping is disabled', () => {
    const result = snapFrame(101, targets, { pixelsPerFrame: 2, enabled: false });
    expect(result.snapped).toBe(false);
    expect(result.frame).toBe(101);
  });

  it('does nothing with an empty target list', () => {
    expect(snapFrame(101, [], { pixelsPerFrame: 2 }).snapped).toBe(false);
  });
});

describe('collectSnapTargets', () => {
  it('offers both edges of every clip, the playhead and the timeline start', () => {
    const clip = makeClip();
    const project = { ...makeProject([clip]), currentFrame: 42 };
    const targets = collectSnapTargets(project);

    expect(targets.map((target) => target.frame).sort((a, b) => a - b)).toEqual([
      0, 42, 100, 160,
    ]);
    expect(targets.some((target) => target.kind === 'playhead')).toBe(true);
  });

  it('excludes the clip being dragged so it cannot snap to itself', () => {
    const clip = makeClip();
    const targets = collectSnapTargets(makeProject([clip]), { excludeClipIds: [clip.id] });

    expect(targets.some((target) => target.clipId === clip.id)).toBe(false);
  });

  it('includes markers when provided', () => {
    const targets = collectSnapTargets({
      ...makeProject([]),
      markers: [{ id: 'marker-1', frame: 7, label: 'Beat', color: '#facc15' }],
    });
    expect(targets.some((target) => target.kind === 'marker' && target.frame === 7)).toBe(true);
  });
});

describe('snapClipMove', () => {
  const targets = [{ frame: 200, kind: 'clip-start' as const }];

  it('snaps the leading edge of a dragged clip', () => {
    const result = snapClipMove(197, 50, targets, { pixelsPerFrame: 2 });
    expect(result.snapped).toBe(true);
    expect(result.frame).toBe(200);
  });

  it('snaps the trailing edge too, offsetting by the clip length', () => {
    // A 50-frame clip starting at 148 ends at 198, two frames from the target.
    const result = snapClipMove(148, 50, targets, { pixelsPerFrame: 2 });
    expect(result.snapped).toBe(true);
    expect(result.frame).toBe(150);
    expect(clipEndFrame({ ...makeClip(), startFrame: result.frame, durationFrames: 50 })).toBe(200);
  });

  it('prefers whichever edge is closer', () => {
    const both = [
      { frame: 100, kind: 'clip-end' as const },
      { frame: 152, kind: 'clip-start' as const },
    ];
    // Head is 2 frames from 100, tail (at start+50) is 0 frames from 152.
    expect(snapClipMove(102, 50, both, { pixelsPerFrame: 2 }).frame).toBe(102);
  });

  it('returns the raw start when neither edge is close enough', () => {
    const result = snapClipMove(50, 50, targets, { pixelsPerFrame: 4 });
    expect(result.snapped).toBe(false);
    expect(result.frame).toBe(50);
  });
});

describe('pixel and frame conversion', () => {
  it('round-trips through the scroll offset', () => {
    expect(pixelToFrame(frameToPixel(120, 3, 240), 3, 240)).toBe(120);
  });

  it('never returns a negative frame', () => {
    expect(pixelToFrame(-500, 2, 0)).toBe(0);
  });
});

describe('splitClip (razor tool)', () => {
  it('produces two clips whose durations sum to the original', () => {
    const clip = makeClip({ startFrame: 100, durationFrames: 60 });
    const [left, right] = splitClip(clip, 130)!;

    expect(left.durationFrames).toBe(30);
    expect(right.durationFrames).toBe(30);
    expect(left.durationFrames + right.durationFrames).toBe(clip.durationFrames);
  });

  it('places the halves back to back with no gap or overlap', () => {
    const clip = makeClip({ startFrame: 100, durationFrames: 60 });
    const [left, right] = splitClip(clip, 137)!;

    expect(left.startFrame).toBe(100);
    expect(clipEndFrame(left)).toBe(137);
    expect(right.startFrame).toBe(137);
    expect(clipEndFrame(right)).toBe(160);
  });

  it('advances the source offset of the right half by the left duration', () => {
    const clip = makeClip({ startFrame: 100, durationFrames: 60, sourceOffsetFrames: 24 });
    const [left, right] = splitClip(clip, 130)!;

    expect(left.sourceOffsetFrames).toBe(24);
    expect(right.sourceOffsetFrames).toBe(54);
  });

  it('gives the two halves independent identities', () => {
    const clip = makeClip();
    const [left, right] = splitClip(clip, 130)!;

    expect(left.id).toBe(clip.id);
    expect(right.id).not.toBe(clip.id);
  });

  it('deep-copies nested config so the halves do not share state', () => {
    const clip = makeClip();
    const [left, right] = splitClip(clip, 130)!;

    right.mask.feather = 99;
    expect(left.mask.feather).not.toBe(99);
    expect(clip.mask.feather).not.toBe(99);

    right.chromaKey.keyColor[0] = 0.5;
    expect(left.chromaKey.keyColor[0]).not.toBe(0.5);
  });

  it('refuses to cut on or outside a boundary', () => {
    const clip = makeClip({ startFrame: 100, durationFrames: 60 });

    expect(splitClip(clip, 100)).toBeNull();
    expect(splitClip(clip, 160)).toBeNull();
    expect(splitClip(clip, 42)).toBeNull();
    expect(splitClip(clip, 900)).toBeNull();
  });

  it('splits a clip that starts at frame zero', () => {
    const clip = makeClip({ startFrame: 0, durationFrames: 10 });
    const [left, right] = splitClip(clip, 1)!;

    expect(left.durationFrames).toBe(1);
    expect(right.durationFrames).toBe(9);
  });

  it('partitions keyframes and inserts a matching boundary key on each side', () => {
    const clip = makeClip({
      startFrame: 100,
      durationFrames: 60,
      transform: {
        position: [],
        scale: [],
        rotation: [],
        opacity: [
          { id: 'a', frame: 100, value: 0, easing: 'linear' },
          { id: 'b', frame: 160, value: 1, easing: 'linear' },
        ],
        anchorPoint: { x: 0.5, y: 0.5 },
      },
    });

    const [left, right] = splitClip(clip, 130)!;

    expect(left.transform.opacity).toHaveLength(2);
    expect(right.transform.opacity).toHaveLength(2);

    // The cut is invisible: both halves carry the same value at frame 130.
    const leftBoundary = left.transform.opacity.at(-1)!;
    const rightBoundary = right.transform.opacity[0];

    expect(leftBoundary.frame).toBe(130);
    expect(rightBoundary.frame).toBe(130);
    expect(leftBoundary.value).toBeCloseTo(0.5, 6);
    expect(rightBoundary.value).toBeCloseTo(0.5, 6);
  });

  it('does not invent keyframes for an unanimated property', () => {
    const [left, right] = splitClip(makeClip(), 130)!;
    expect(left.transform.position).toEqual([]);
    expect(right.transform.position).toEqual([]);
  });
});

describe('splitKeyframeTrack', () => {
  it('returns two empty tracks for an empty input', () => {
    expect(splitKeyframeTrack([], 10)).toEqual([[], []]);
  });

  it('keeps every key on one side when the cut is outside the range', () => {
    const track = [
      { id: 'a', frame: 10, value: 0, easing: 'linear' as const },
      { id: 'b', frame: 20, value: 1, easing: 'linear' as const },
    ];

    const [beforeLeft, beforeRight] = splitKeyframeTrack(track, 5);
    expect(beforeLeft).toHaveLength(0);
    expect(beforeRight).toHaveLength(2);

    const [afterLeft, afterRight] = splitKeyframeTrack(track, 40);
    expect(afterLeft).toHaveLength(2);
    expect(afterRight).toHaveLength(0);
  });

  it('assigns fresh ids so the halves never collide', () => {
    const track = [
      { id: 'shared', frame: 0, value: 0, easing: 'linear' as const },
      { id: 'other', frame: 10, value: 1, easing: 'linear' as const },
    ];
    const [left, right] = splitKeyframeTrack(track, 5);

    const ids = new Set([...left, ...right].map((keyframe) => keyframe.id));
    expect(ids.size).toBe(left.length + right.length);
  });
});

describe('moveClip and trimming', () => {
  it('drags keyframes along with the clip', () => {
    const clip = makeClip({
      startFrame: 100,
      transform: {
        position: [],
        scale: [],
        rotation: [],
        opacity: [{ id: 'a', frame: 110, value: 1, easing: 'linear' }],
        anchorPoint: { x: 0.5, y: 0.5 },
      },
    });

    const moved = moveClip(clip, 200);
    expect(moved.startFrame).toBe(200);
    expect(moved.transform.opacity[0].frame).toBe(210);
  });

  it('clamps a move to the start of the timeline', () => {
    expect(moveClip(makeClip({ startFrame: 10 }), -50).startFrame).toBe(0);
  });

  it('moves a clip to another track when asked', () => {
    expect(moveClip(makeClip(), 100, 'track-2').trackId).toBe('track-2');
  });

  it('advances the source offset when trimming the head', () => {
    const clip = makeClip({ startFrame: 100, durationFrames: 60, sourceOffsetFrames: 10 });
    const trimmed = trimClipStart(clip, 120);

    expect(trimmed.startFrame).toBe(120);
    expect(trimmed.durationFrames).toBe(40);
    expect(trimmed.sourceOffsetFrames).toBe(30);
    expect(clipEndFrame(trimmed)).toBe(clipEndFrame(clip));
  });

  it('keeps at least one frame when trimming', () => {
    const clip = makeClip({ startFrame: 100, durationFrames: 60 });

    expect(trimClipStart(clip, 999).durationFrames).toBeGreaterThanOrEqual(1);
    expect(trimClipEnd(clip, 0).durationFrames).toBeGreaterThanOrEqual(1);
  });

  it('changes only the duration when trimming the tail', () => {
    const trimmed = trimClipEnd(makeClip({ startFrame: 100, durationFrames: 60 }), 140);

    expect(trimmed.startFrame).toBe(100);
    expect(trimmed.durationFrames).toBe(40);
    expect(trimmed.sourceOffsetFrames).toBe(0);
  });
});
