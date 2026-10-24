import { beforeEach, describe, expect, it } from 'vitest';

import { refitForFrame, refitScale } from '@renderer/edit/frameShape';
import { createClip, createEmptyProject } from '@renderer/store/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import type { ProjectState } from '@shared/types';

/**
 * A new frame shape from the viewer's menu, without stretching anything: each
 * picture keeps its own shape, as big against the new frame as it was
 * against the old, as far from the middle in proportion.
 */

const landscape = { width: 1920, height: 1080 };
const vertical = { width: 1080, height: 1920 };
const close = (actual: { x: number; y: number }, expected: { x: number; y: number }): void => {
  expect(actual.x).toBeCloseTo(expected.x, 4);
  expect(actual.y).toBeCloseTo(expected.y, 4);
};

describe('the scale that keeps a picture as it looked', () => {
  it('fits a video that filled a landscape frame across a vertical one, with bars above and below', () => {
    close(refitScale({ x: 1, y: 1 }, landscape, vertical), { x: 1, y: 1080 / 1920 / (1920 / 1080) });
  });

  it('lets a vertical photo, fitted in a landscape frame, fill a vertical one', () => {
    close(refitScale({ x: 1080 / 1920 / (1920 / 1080), y: 1 }, landscape, vertical), { x: 1, y: 1 });
  });

  it('keeps a picture in picture as big against the frame it fits in', () => {
    // A quarter of the frame's width, wide: a quarter of the vertical frame's width.
    const scale = refitScale({ x: 0.25, y: 0.25 }, landscape, vertical);
    expect(scale.x).toBeCloseTo(0.25, 4);
    expect((scale.x * vertical.width) / (scale.y * vertical.height)).toBeCloseTo(1920 / 1080, 4);
  });

  it('keeps a mirrored picture mirrored, and leaves a scale of nothing alone', () => {
    const mirrored = refitScale({ x: -1, y: 1 }, landscape, vertical);
    expect(mirrored.x).toBeLessThan(0);
    expect(mirrored.y).toBeGreaterThan(0);
    expect(refitScale({ x: 0, y: 1 }, landscape, vertical)).toEqual({ x: 0, y: 1 });
  });

  it('changes nothing for a frame of the same shape', () => {
    close(refitScale({ x: 0.7, y: 0.7 }, landscape, { width: 3840, height: 2160 }), { x: 0.7, y: 0.7 });
  });
});

function project(): ProjectState & { video: string; still: string; title: string; sound: string; moved: string } {
  const base = createEmptyProject();
  const v1 = base.tracks.find((track) => track.type === 'video')!.id;
  const a1 = base.tracks.find((track) => track.type === 'audio')!.id;
  const video = createClip({ trackId: v1, name: 'video', sourceUri: 'blob:v', startFrame: 0, durationFrames: 90 });
  const still = createClip({ trackId: v1, name: 'still', sourceUri: 'blob:s', startFrame: 90, durationFrames: 90, initialScale: { x: 0.316, y: 1 } });
  const moved = createClip({ trackId: v1, name: 'logo', sourceUri: 'blob:l', startFrame: 180, durationFrames: 90 });
  moved.transform.position = [{ id: 'p', frame: 180, value: { x: 600, y: -320 }, easing: 'linear' }];
  const title = { ...createClip({ trackId: v1, name: 'title', sourceUri: '', startFrame: 270, durationFrames: 90 }), title: {} as never };
  const sound = createClip({ trackId: a1, name: 'sound', sourceUri: 'blob:a', startFrame: 0, durationFrames: 90 });
  return {
    ...base,
    width: 1920,
    height: 1080,
    clips: { [video.id]: video, [still.id]: still, [moved.id]: moved, [title.id]: title, [sound.id]: sound },
    video: video.id,
    still: still.id,
    title: title.id,
    sound: sound.id,
    moved: moved.id,
  };
}

describe('every picture in the edit', () => {
  it('gets a scale track that keeps its shape, even one that had none', () => {
    const p = project();
    const moves = refitForFrame(p, vertical);
    close(moves[p.video].scale[0].value, refitScale({ x: 1, y: 1 }, landscape, vertical));
    close(moves[p.still].scale[0].value, refitScale({ x: 0.316, y: 1 }, landscape, vertical));
  });

  it('sits as far from the middle, in proportion', () => {
    const p = project();
    const [key] = refitForFrame(p, vertical)[p.moved].position;
    close(key.value, { x: (600 * 1080) / 1920, y: (-320 * 1920) / 1080 });
  });

  it('leaves titles, captions and sound alone: they have no picture of their own to fit', () => {
    const p = project();
    const moves = refitForFrame(p, vertical);
    expect(moves[p.title]).toBeUndefined();
    expect(moves[p.sound]).toBeUndefined();
  });
});

describe('through the store', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it('is one undo step that gives the frame and the pictures back', () => {
    const p = project();
    useProjectStore.setState({ project: p });
    const before = JSON.stringify(useProjectStore.getState().project);
    useProjectStore.getState().setFrameShape(vertical, refitForFrame(p, vertical));
    const after = useProjectStore.getState().project;
    expect({ width: after.width, height: after.height }).toEqual(vertical);
    expect(after.clips[p.video].transform.scale[0].value.y).toBeLessThan(1);
    useProjectStore.getState().undo();
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(before);
  });
});
