import { describe, expect, it } from 'vitest';
import { createClip, createEmptyProject } from '../src/renderer/store/types';
import { layoutsFor, withSplitLayout } from '../src/renderer/edit/splitScreen';

describe('split screen', () => {
  it('offers the layouts for the number of clips', () => {
    expect(layoutsFor(2)).toEqual(['side', 'stack', 'pip']);
    expect(layoutsFor(3)).toEqual(['main3', 'columns3']);
    expect(layoutsFor(4)).toEqual(['grid4']);
    expect(layoutsFor(5)).toEqual([]);
  });

  it('side by side: each covers its half without stretching, cut to it, a gap between', () => {
    const project = createEmptyProject(1920, 1080, 30);
    const track = project.tracks[0];
    const a = createClip({ trackId: track.id, name: 'a', sourceUri: 'a.mp4', startFrame: 0, durationFrames: 90 });
    const b = createClip({ trackId: track.id, name: 'b', sourceUri: 'b.mp4', startFrame: 90, durationFrames: 90 });
    project.clips = { [a.id]: a, [b.id]: b };
    const laid = withSplitLayout(project, [a.id, b.id], 'side', () => 16 / 9);
    const left = laid.clips[a.id];
    const right = laid.clips[b.id];
    expect(right.startFrame).toBe(0);
    expect(right.trackId).not.toBe(left.trackId);
    // A 16:9 picture covering a 957 x 1080 half: as tall as the frame, wider than the half.
    expect(left.transform.scale[0].value.y).toBeCloseTo(1, 5);
    expect(left.transform.position[0].value.x).toBeCloseTo(-481.5, 1);
    expect(left.mask).toMatchObject({ enabled: true, type: 1 });
    expect(left.mask.size.x).toBeCloseTo(957 / 1920, 4);
    expect(right.mask.center.x).toBeCloseTo((963 + 957 / 2) / 1920, 4);
    expect(right.mask.center.y).toBeCloseTo(0.5, 5);
  });

  it('leaves the project as it is for the wrong number of clips', () => {
    const project = createEmptyProject(1920, 1080, 30);
    const a = createClip({ trackId: project.tracks[0].id, name: 'a', sourceUri: 'a.mp4', startFrame: 0, durationFrames: 90 });
    project.clips = { [a.id]: a };
    expect(withSplitLayout(project, [a.id], 'grid4', () => 1)).toBe(project);
  });
});
