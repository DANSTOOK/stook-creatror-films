import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { followerKeyframes, frameBoxToSource, sourceToFrame, trackRequest } from '@renderer/edit/track';
import { applyFollow, followOrigin, removeFollow } from '@renderer/edit/trackApply';
import { applyClipAnimation } from '@renderer/fx/motion/apply';
import { normalizeProject } from '@renderer/store/types';

const project = { width: 1920, height: 1080, fps: 30 };
const state = () => useProjectStore.getState();

function videoClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'v',
    trackId: 't',
    name: 'v',
    sourceUri: 'blob:v',
    startFrame: 30,
    durationFrames: 300,
    sourceOffsetFrames: 60,
    hasAlphaChannel: false,
    transform: { position: [], scale: [], rotation: [], opacity: [], anchorPoint: { x: 0.5, y: 0.5 } },
    volume: 1,
    pan: 0,
    eq: undefined as never,
    ...extra,
  } as Clip;
}

describe('where a marked thing is on the file, and back', () => {
  it('a box on a full-frame clip is the same box on its file', () => {
    const box = frameBoxToSource({ x: 0.25, y: 0.75, width: 0.1, height: 0.2 }, videoClip(), 40, project);
    expect(box.x).toBeCloseTo(0.25, 6);
    expect(box.y).toBeCloseTo(0.75, 6);
    expect(box.width).toBeCloseTo(0.1, 6);
  });

  it('a clip zoomed 2x and moved: the box is found where the picture is drawn, there and back', () => {
    const clip = videoClip({
      transform: {
        position: [{ id: 'p', frame: 0, value: { x: 200, y: -100 }, easing: 'linear' }],
        scale: [{ id: 's', frame: 0, value: { x: 2, y: 2 }, easing: 'linear' }],
        rotation: [],
        opacity: [],
        anchorPoint: { x: 0.5, y: 0.5 },
      },
    });
    const source = frameBoxToSource({ x: 0.6, y: 0.4, width: 0.1, height: 0.1 }, clip, 40, project);
    expect(source.width).toBeCloseTo(0.05, 6);
    const back = sourceToFrame(source, clip, 40, project);
    expect(back.x).toBeCloseTo(0.6 * 1920, 4);
    expect(back.y).toBeCloseTo(0.4 * 1080, 4);
  });

  it('asks for the stretch of file under the timeline from the marked frame, at the clip’s speed', () => {
    const clip = videoClip({ speed: 2 });
    const request = trackRequest(clip, { width: 1280, height: 720 } as never, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, 90, 179, project);
    // 60 frames into the clip at 2x is 120 file frames past its 60 offset: 6 s.
    expect(request.fromSeconds).toBeCloseTo(6, 6);
    expect(request.toSeconds).toBeCloseTo((60 + 150 * 2) / 30, 6);
    expect(request.sampleFps).toBe(60);
    expect(request.sourceWidth).toBe(1280);
  });
});

describe('the follower’s path', () => {
  it('moves from where the follower is, as the thing moves on screen, and holds when the thing is lost', () => {
    const samples = [
      { t: 0, x: 0.5, y: 0.5, score: 1 },
      { t: 1, x: 0.6, y: 0.5, score: 0.9 },
      { t: 2, x: 0.7, y: 0.5, score: 0.9 },
      { t: 3, x: 0.1, y: 0.1, score: 0.1 },
    ];
    const keys = followerKeyframes(samples, videoClip(), { x: 100, y: 50 }, 40, 400, project);
    const transform = { position: keys, scale: [], rotation: [], opacity: [], anchorPoint: { x: 0.5, y: 0.5 } };
    expect(evaluateTransform(transform, 40).position).toEqual({ x: 100, y: 50 });
    expect(evaluateTransform(transform, 70).position.x).toBeCloseTo(100 + 192, 4);
    expect(evaluateTransform(transform, 100).position.x).toBeCloseTo(100 + 384, 4);
    // Lost at 3 s: held where it last was.
    expect(evaluateTransform(transform, 130).position.x).toBeCloseTo(100 + 384, 4);
  });

  it('stops where either clip ends', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ t: i / 30, x: 0.5 + i * 0.001, y: 0.5, score: 1 }));
    const keys = followerKeyframes(samples, videoClip(), { x: 0, y: 0 }, 40, 70, project);
    expect(Math.max(...keys.map((key) => key.frame))).toBeLessThanOrEqual(70);
  });
});

describe('writing a follow onto a clip', () => {
  let clipId = '';
  beforeEach(() => {
    state().newProject(1920, 1080, 30);
    const track = state().project.tracks.find((candidate) => candidate.type === 'video')!;
    clipId = state().addClip({ trackId: track.id, name: 'sticker', sourceUri: 'blob:s', startFrame: 0, durationFrames: 150 });
    state().updateClip(clipId, { transform: { ...state().project.clips[clipId].transform, scale: [{ id: 'own', frame: 0, value: { x: 0.3, y: 0.3 }, easing: 'linear' }] } });
  });
  const clip = () => state().project.clips[clipId];
  const path = [
    { id: 'a', frame: 30, value: { x: 0, y: 0 }, easing: 'linear' as const },
    { id: 'b', frame: 90, value: { x: 300, y: 0 }, easing: 'linear' as const },
  ];

  it('follows, keeps its animations and size, and one undo takes the follow back', () => {
    applyClipAnimation(clipId, 'pulse');
    applyFollow(clipId, path, 30);
    expect(clip().tracking?.fromFrame).toBe(30);
    expect(evaluateTransform(clip().transform, 60).position.x).toBeCloseTo(150, 4);
    expect(clip().fx?.loop?.id).toBe('pulse');
    const scale = evaluateTransform(clip().transform, 60).scale.x;
    expect(scale).toBeGreaterThan(0.25);
    expect(scale).toBeLessThan(0.36);
    state().undo();
    expect(clip().tracking).toBeUndefined();
    expect(evaluateTransform(clip().transform, 60).position.x).toBeCloseTo(0, 4);
  });

  it('stopping puts the position it had back, and a saved project keeps the follow', () => {
    applyFollow(clipId, path, 30);
    expect(followOrigin(clip(), 90).x).toBeCloseTo(300, 4);
    const opened = normalizeProject(JSON.parse(JSON.stringify(state().project)));
    expect(opened.clips[clipId].tracking?.fromFrame).toBe(30);
    removeFollow(clipId);
    expect(clip().tracking).toBeUndefined();
    expect(clip().transform.position).toEqual([]);
  });
});
