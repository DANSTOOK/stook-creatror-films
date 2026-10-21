import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { buildMotionTransform, motionFromZone, motionZone } from '@renderer/fx/motion/presets';
import { applyClipAnimation, applyMotionPreset, setClipFx, withClipAtRest } from '@renderer/fx/motion/apply';
import { normalizeProject } from '@renderer/store/types';

const state = () => useProjectStore.getState();
const W = 1920;
const H = 1080;

describe('a zoom aimed at a zone', () => {
  it('the zone and the zoom it means are one and the same, there and back', () => {
    for (const zone of [
      { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 0.6, height: 0.6 },
      { x: 0.3, y: 0.35, width: 0.4, height: 0.4 },
    ]) {
      const { amount, focus } = motionFromZone('zoomIn', zone);
      const back = motionZone('zoomIn', amount, focus);
      expect(back.x).toBeCloseTo(zone.x, 6);
      expect(back.y).toBeCloseTo(zone.y, 6);
      expect(back.width).toBeCloseTo(zone.width, 6);
    }
  });

  it('zooming into a corner never shows an edge of black, at any frame of the move', () => {
    const move = buildMotionTransform('zoomIn', { startFrame: 0, durationFrames: 90 }, { width: W, height: H }, { scale: { x: 1, y: 1 }, position: { x: 0, y: 0 } }, { amount: 3, focus: { x: 0, y: 1 } });
    const transform = { ...move, rotation: [], opacity: [], anchorPoint: { x: 0.5, y: 0.5 } };
    for (let f = 0; f < 90; f += 1) {
      const { scale, position } = evaluateTransform(transform, f);
      const overhangX = ((scale.x - 1) / 2) * W;
      const overhangY = ((scale.y - 1) / 2) * H;
      expect(Math.abs(position.x)).toBeLessThanOrEqual(overhangX + 1e-6);
      expect(Math.abs(position.y)).toBeLessThanOrEqual(overhangY + 1e-6);
    }
    // And at its closest it is aimed at the bottom-left corner: moved right and up.
    const end = evaluateTransform(transform, 89);
    expect(end.position.x).toBeGreaterThan(0);
    expect(end.position.y).toBeLessThan(0);
  });

  it('a zoom aimed at the centre writes no position at all, as before', () => {
    const move = buildMotionTransform('zoomIn', { startFrame: 0, durationFrames: 90 }, { width: W, height: H }, { scale: { x: 1, y: 1 }, position: { x: 0, y: 0 } });
    expect(move.position).toEqual([]);
  });
});

describe('what is on a clip, kept and changed', () => {
  let clipId = '';
  beforeEach(() => {
    state().newProject(W, H, 30);
    const track = state().project.tracks.find((candidate) => candidate.type === 'video')!;
    clipId = state().addClip({ trackId: track.id, name: 'c', sourceUri: 'blob:v', startFrame: 0, durationFrames: 150 });
  });
  const clip = () => state().project.clips[clipId];

  it('a move and an In and Out put on are remembered, and each can be taken off alone', () => {
    applyMotionPreset(clipId, 'zoomIn');
    applyClipAnimation(clipId, 'slideInLeft');
    applyClipAnimation(clipId, 'fadeOut');
    expect(clip().fx?.motion?.preset).toBe('zoomIn');
    expect(clip().fx?.in?.id).toBe('slideInLeft');
    expect(clip().fx?.out?.id).toBe('fadeOut');
    // The slide starts off the frame; the fade ends in black.
    expect(evaluateTransform(clip().transform, 0).position.x).toBeLessThan(-W);
    expect(evaluateTransform(clip().transform, 149).opacity).toBeCloseTo(0, 5);

    const { in: _in, ...rest } = clip().fx!;
    void _in;
    setClipFx(clipId, rest);
    expect(clip().fx?.in).toBeUndefined();
    expect(evaluateTransform(clip().transform, 0).position.x).toBeCloseTo(0, 5);
    expect(evaluateTransform(clip().transform, 149).opacity).toBeCloseTo(0, 5);
    expect(clip().fx?.motion?.preset).toBe('zoomIn');
  });

  it('changing an In\'s length writes it again over the new length', () => {
    applyClipAnimation(clipId, 'fadeIn');
    setClipFx(clipId, { ...clip().fx, in: { id: 'fadeIn', seconds: 2 } });
    expect(evaluateTransform(clip().transform, 30).opacity).toBeLessThan(0.9);
    expect(evaluateTransform(clip().transform, 60).opacity).toBeCloseTo(1, 5);
    // Never longer than half the clip.
    setClipFx(clipId, { ...clip().fx, in: { id: 'fadeIn', seconds: 3 } });
    expect(evaluateTransform(clip().transform, 75).opacity).toBeCloseTo(1, 5);
  });

  it('taking everything off leaves the clip as it was, with nothing remembered', () => {
    applyMotionPreset(clipId, 'kenBurns');
    applyClipAnimation(clipId, 'pulse');
    setClipFx(clipId, {});
    expect(clip().fx).toBeUndefined();
    expect(clip().transform.position).toEqual([]);
    expect(clip().transform.scale).toEqual([]);
  });

  it('one undo takes back one change', () => {
    applyMotionPreset(clipId, 'zoomIn');
    setClipFx(clipId, { ...clip().fx, motion: { preset: 'zoomIn', amount: 2, focus: { x: 0.2, y: 0.3 } } });
    state().undo();
    expect(clip().fx?.motion?.amount).toBe(1);
  });

  it('the viewer draws a clip being aimed at rest, the same object while nothing changes', () => {
    applyMotionPreset(clipId, 'zoomIn');
    const project = state().project;
    const resting = withClipAtRest(project, state().assets, clipId);
    expect(resting.clips[clipId].transform.scale).toEqual([]);
    expect(withClipAtRest(project, state().assets, clipId)).toBe(resting);
  });

  it('a saved project keeps what is on its clips, and drops what it cannot read', () => {
    applyMotionPreset(clipId, 'zoomIn');
    applyClipAnimation(clipId, 'popIn');
    const saved = JSON.parse(JSON.stringify(state().project));
    saved.clips[clipId].fx.out = { id: 42 };
    const opened = normalizeProject(saved);
    expect(opened.clips[clipId].fx?.motion?.preset).toBe('zoomIn');
    expect(opened.clips[clipId].fx?.in?.id).toBe('popIn');
    expect(opened.clips[clipId].fx?.out).toBeUndefined();
  });
});
