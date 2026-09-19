import { beforeEach, describe, expect, it } from 'vitest';
import { fitScale } from '../src/renderer/media/fitToFrame';
import { useProjectStore } from '../src/renderer/store/useProjectStore';
import type { MediaAsset } from '../src/shared/types';

const FRAME = { width: 1920, height: 1080 };

describe('fitting a picture whole inside the frame', () => {
  it('leaves a picture of the frame\'s own shape alone', () => {
    expect(fitScale({ width: 3840, height: 2160 }, FRAME)).toBeNull();
    expect(fitScale({ width: 1280, height: 720 }, FRAME)).toBeNull();
  });

  it('puts a portrait photo in at full height, with bars at the sides', () => {
    const scale = fitScale({ width: 1080, height: 1920 }, FRAME);
    expect(scale?.y).toBe(1);
    // On screen: 1080 tall, so 607.5 wide - its own 9:16.
    expect((scale!.x * FRAME.width) / (scale!.y * FRAME.height)).toBeCloseTo(1080 / 1920, 6);
  });

  it('puts a panorama in at full width, with bars top and bottom', () => {
    const scale = fitScale({ width: 4000, height: 1000 }, FRAME);
    expect(scale?.x).toBe(1);
    expect((scale!.x * FRAME.width) / (scale!.y * FRAME.height)).toBeCloseTo(4, 6);
  });

  it('never overflows the frame', () => {
    for (const media of [{ width: 16, height: 16 }, { width: 2071, height: 1301 }, { width: 3000, height: 4000 }]) {
      const scale = fitScale(media, FRAME)!;
      expect(scale.x).toBeLessThanOrEqual(1);
      expect(scale.y).toBeLessThanOrEqual(1);
      expect(Math.max(scale.x, scale.y)).toBe(1);
    }
  });

  it('gives up on a picture with no size rather than guessing', () => {
    expect(fitScale({ width: 0, height: 0 }, FRAME)).toBeNull();
  });
});

describe('placing and then resizing a fitted photo', () => {
  const asset = (id: string, width: number, height: number, kind: MediaAsset['kind'] = 'image'): MediaAsset => ({
    id,
    name: `${id}.jpg`,
    uri: `blob:${id}`,
    kind,
    durationFrames: 150,
    durationSeconds: 5,
    width,
    height,
    hasAlphaChannel: false,
  });

  beforeEach(() => {
    useProjectStore.getState().newProject(1920, 1080, 30);
  });

  const videoTrack = () => useProjectStore.getState().project.tracks.find((t) => t.type === 'video')!.id;

  it('comes in fitted, as one fixed value', () => {
    const id = useProjectStore.getState().addAssetToTimeline(asset('portrait', 1080, 1920), videoTrack(), 30);
    const clip = useProjectStore.getState().project.clips[id!];
    expect(clip.transform.scale).toHaveLength(1);
    expect(clip.transform.scale[0].value.y).toBe(1);
    expect(clip.transform.scale[0].value.x).toBeCloseTo(0.3164, 3);
  });

  it('leaves a same-shape picture and sound untouched', () => {
    const still = useProjectStore.getState().addAssetToTimeline(asset('wide', 1920, 1080), videoTrack(), 0);
    expect(useProjectStore.getState().project.clips[still!].transform.scale).toHaveLength(0);
  });

  it('resized in the viewer half-way through, it stays one size - no animation appears', () => {
    const id = useProjectStore.getState().addAssetToTimeline(asset('portrait', 1080, 1920), videoTrack(), 30)!;
    useProjectStore.getState().setTransformAt(id, 30 + 75, { scale: { x: 0.2, y: 0.63 } });
    const clip = useProjectStore.getState().project.clips[id];
    expect(clip.transform.scale).toHaveLength(1);
    expect(clip.transform.scale[0].value).toEqual({ x: 0.2, y: 0.63 });
  });

  it('an animation already there is edited at the playhead, as before', () => {
    const id = useProjectStore.getState().addAssetToTimeline(asset('portrait', 1080, 1920), videoTrack(), 30)!;
    useProjectStore.getState().setVectorKeyframe(id, 'scale', 150, { x: 0.5, y: 1 });
    useProjectStore.getState().setTransformAt(id, 100, { scale: { x: 0.4, y: 0.9 } });
    expect(useProjectStore.getState().project.clips[id].transform.scale).toHaveLength(3);
  });

  it('placing it is one undo step, fit included', () => {
    const before = Object.keys(useProjectStore.getState().project.clips).length;
    useProjectStore.getState().addAssetToTimeline(asset('portrait', 1080, 1920), videoTrack(), 30);
    useProjectStore.getState().undo();
    expect(Object.keys(useProjectStore.getState().project.clips)).toHaveLength(before);
  });
});
