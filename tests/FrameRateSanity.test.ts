import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '@shared/types';
import { MAX_FRAME_RATE, MIN_FRAME_RATE, snapFrameRate } from '@shared/utils/frameRate';
import { settingsFromAsset } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { createClip } from '@renderer/store/types';

/**
 * The export that would have taken hours.
 *
 * Measuring presentation timestamps on one file returned 7650.71 fps. Every
 * check the rate passed through only asked whether it was greater than zero,
 * so the project adopted it, a 36-minute timeline became 16,492,260.71
 * frames, and the export dialog offered to render all of them - at 570 fps,
 * which is fast, for eight hours, which is not. The progress bar looked
 * broken when it was merely honest.
 *
 * Three separate things had to be wrong for that to happen, and each gets a
 * test here: an implausible measurement was believed, a still's odd width
 * was adopted (2070x1080 - which yuv420p cannot even encode), and a
 * fractional rate was added straight to a frame count.
 */

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a',
  name: 'clip.mp4',
  uri: 'media://clip',
  kind: 'video',
  durationFrames: 300,
  width: 1920,
  height: 1080,
  hasAlphaChannel: false,
  ...overrides,
});

describe('snapFrameRate', () => {
  it('reports an absurd measurement as unknown rather than passing it on', () => {
    expect(snapFrameRate(7650.71)).toBe(0);
    expect(snapFrameRate(100_000)).toBe(0);
    expect(snapFrameRate(0.2)).toBe(0);
  });

  it('still believes every rate real footage uses', () => {
    for (const rate of [24, 25, 30, 50, 60, 120]) {
      expect(snapFrameRate(rate)).toBe(rate);
    }
    // A noisy measurement still snaps, to whichever standard rate is nearest.
    expect(snapFrameRate(29.9994)).toBe(30);
    expect(snapFrameRate(29.96)).toBe(29.97);
    expect(snapFrameRate(59.9)).toBe(59.94);
  });

  it('keeps an unusual but plausible rate, such as a timelapse', () => {
    expect(snapFrameRate(40)).toBe(40);
  });

  it('accepts the edges of the believable range', () => {
    expect(snapFrameRate(MIN_FRAME_RATE)).toBeGreaterThan(0);
    expect(snapFrameRate(MAX_FRAME_RATE)).toBeGreaterThan(0);
  });
});

describe('what a newly imported asset is allowed to change', () => {
  it('does not hand the project an implausible frame rate', () => {
    expect(settingsFromAsset(asset({ sourceFps: 7650.71 }))?.fps).toBeUndefined();
    expect(settingsFromAsset(asset({ sourceFps: 0.01 }))?.fps).toBeUndefined();
  });

  it('does hand over a real one', () => {
    expect(settingsFromAsset(asset({ sourceFps: 59.94 }))?.fps).toBe(59.94);
  });

  it('rounds an odd size down to something a video codec can encode', () => {
    const settings = settingsFromAsset(asset({ kind: 'video', width: 2071, height: 1081 }));
    expect(settings).toMatchObject({ width: 2070, height: 1080 });
  });

  it('takes nothing at all from audio', () => {
    expect(settingsFromAsset(asset({ kind: 'audio', sourceFps: 30 }))).toBeNull();
  });

  it('takes nothing from a still either: the sequence is built from footage', () => {
    expect(settingsFromAsset(asset({ kind: 'image', width: 890, height: 422 }))).toBeNull();
  });
});

describe('a project saved with an impossible rate', () => {
  it('is repaired when opened, keeping the length it had in seconds', () => {
    const store = useProjectStore.getState();
    store.newProject();
    const base = useProjectStore.getState().project;

    // What the bug produced: 36 minutes, counted at 7650.71 fps.
    const broken = { ...base, fps: 7650.71, durationFrames: 16_492_260.71 };
    store.loadDocument({
      version: 1,
      savedAt: new Date().toISOString(),
      project: broken,
      assets: [],
    });

    const repaired = useProjectStore.getState().project;
    expect(repaired.fps).toBe(30);
    expect(Number.isInteger(repaired.durationFrames)).toBe(true);
    // Still about 36 minutes, now counted at a rate that can exist.
    const minutes = repaired.durationFrames / repaired.fps / 60;
    expect(minutes).toBeGreaterThan(35);
    expect(minutes).toBeLessThan(37);
  });
});

describe('project length stays countable in whole frames', () => {
  it('grows to cover its clips without going fractional at 29.97 fps', () => {
    const store = useProjectStore.getState();
    store.newProject();

    const project = useProjectStore.getState().project;
    const track = project.tracks.find((candidate) => candidate.type === 'video')!;
    useProjectStore.setState({ project: { ...project, fps: 29.97 } });

    const clip = createClip({
      trackId: track.id,
      name: 'long',
      sourceUri: 'media://long',
      startFrame: 0,
      durationFrames: 5000,
    });
    useProjectStore.getState().transact('seed', (current) => ({
      ...current,
      clips: { [clip.id]: clip },
    }));

    const grown = useProjectStore.getState().project.durationFrames;
    expect(grown).toBeGreaterThanOrEqual(5000);
    expect(Number.isInteger(grown)).toBe(true);
  });
});
