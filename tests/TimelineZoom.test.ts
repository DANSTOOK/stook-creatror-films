import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset } from '@shared/types';
import {
  MIN_PIXELS_PER_FRAME,
  fitZoom,
  isSpanVisible,
  playheadAnchor,
  revealSpan,
  zoomAround,
} from '@renderer/components/Timeline/zoom';
import { bucketsFor } from '@renderer/audio/WaveformExtractor';
import { parseRange } from '@main/ipc/mediaProtocol';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Timeline zoom, placement of new clips, and the long-footage plumbing.
 *
 * Real footage runs 40-50 minutes. Every number here is checked against that
 * scale, not against the three-second clips the suite used to think in.
 */

const state = () => useProjectStore.getState();
const FPS = 30;
const MINUTES_45 = 45 * 60 * FPS; // 81,000 frames

describe('fitZoom', () => {
  it('fits a 45-minute timeline into a 1400 px view', () => {
    const ppf = fitZoom(MINUTES_45, 1400) as number;
    expect(MINUTES_45 * ppf).toBeLessThanOrEqual(1400);
    expect(MINUTES_45 * ppf).toBeGreaterThan(1300); // Uses the space, with a small margin.
  });

  it('can show three hours of 60 fps footage without hitting the floor', () => {
    const threeHours = 3 * 3600 * 60;
    expect(threeHours * MIN_PIXELS_PER_FRAME).toBeLessThanOrEqual(1400);
  });

  it('refuses to guess before the view has been measured', () => {
    expect(fitZoom(MINUTES_45, 0)).toBeNull();
    expect(fitZoom(0, 1400)).toBeNull();
  });
});

describe('zoomAround', () => {
  it('keeps the anchored frame exactly where it was on screen', () => {
    const view = { pixelsPerFrame: 2, scrollLeftPx: 1000 };
    const anchorPx = 300;
    const frameBefore = (view.scrollLeftPx + anchorPx) / view.pixelsPerFrame;

    const zoomed = zoomAround(view, 1.4, anchorPx);
    const frameAfter = (zoomed.scrollLeftPx + anchorPx) / zoomed.pixelsPerFrame;

    expect(frameAfter).toBeCloseTo(frameBefore, 6);
    expect(zoomed.pixelsPerFrame).toBeCloseTo(2.8);
  });

  it('never scrolls before the start of the timeline', () => {
    expect(zoomAround({ pixelsPerFrame: 2, scrollLeftPx: 0 }, 1 / 1.4, 10).scrollLeftPx).toBe(0);
  });

  it('anchors on the playhead when it is on screen, the middle otherwise', () => {
    const view = { pixelsPerFrame: 2, scrollLeftPx: 0 };
    expect(playheadAnchor(view, 100, 1400)).toBe(200);
    expect(playheadAnchor(view, 5000, 1400)).toBe(700);
  });
});

describe('revealSpan', () => {
  const view = { pixelsPerFrame: 2, scrollLeftPx: 0 };

  it('leaves a visible span alone - a deliberate zoom is kept', () => {
    expect(revealSpan(view, 100, 200, 5000, 1400)).toEqual(view);
  });

  it('scrolls to a span that fits at the current zoom', () => {
    const next = revealSpan(view, 2000, 2300, 5000, 1400);
    expect(next.pixelsPerFrame).toBe(2);
    expect(isSpanVisible(next, 2000, 2300, 1400)).toBe(true);
  });

  it('zooms out to fit only when the span is too long for the view', () => {
    const next = revealSpan(view, 0, MINUTES_45, MINUTES_45, 1400);
    expect(next.pixelsPerFrame).toBeLessThan(2);
    expect(isSpanVisible(next, 0, MINUTES_45, 1400)).toBe(true);
  });
});

describe('adding media from the panel', () => {
  const asset = (id: string, durationFrames = 90, kind: MediaAsset['kind'] = 'video'): MediaAsset => ({
    id,
    name: `${id}.mp4`,
    uri: `blob:${id}`,
    kind,
    durationFrames,
    width: 1280,
    height: 720,
    hasAlphaChannel: false,
  });

  beforeEach(() => {
    useProjectStore.getState().newProject(1280, 720, FPS);
    useHistoryStore.getState().clear();
    useProjectStore.getState().setUi({ viewportWidthPx: 1400 });
  });

  const clipFor = (id: string) => Object.values(state().project.clips).find((c) => c.id === id);

  it('puts "+" at the playhead, not after the last clip', () => {
    state().setCurrentFrame(300);
    const id = state().addAssetAtPlayhead(asset('a')) as string;
    expect(clipFor(id)?.startFrame).toBe(300);
  });

  it('never covers a clip that is under the playhead', () => {
    const first = state().addAssetAtPlayhead(asset('a', 100)) as string;
    state().setCurrentFrame(50);
    const second = state().addAssetAtPlayhead(asset('b', 100)) as string;
    expect(clipFor(first)?.startFrame).toBe(0);
    expect(clipFor(second)?.startFrame).toBe(100);
  });

  it('uses the selected clip\'s track when it can take the asset', () => {
    const id = state().addAssetAtPlayhead(asset('a')) as string;
    const video2 = state().project.tracks.find((t) => t.name === 'Video 2')!;
    state().moveClipTo(id, video2.id, 0);
    state().selectClips([id]);

    const next = state().addAssetAtPlayhead(asset('b')) as string;
    expect(clipFor(next)?.trackId).toBe(video2.id);
  });

  it('still offers the old behaviour: after the last clip on the track', () => {
    state().addAssetAtPlayhead(asset('a', 100));
    state().setCurrentFrame(0);
    const id = state().appendAsset(asset('b')) as string;
    expect(clipFor(id)?.startFrame).toBe(100);
  });

  it('can put an asset on a brand new track', () => {
    const before = state().project.tracks.length;
    state().addAssetOnNewTrack(asset('a'));
    expect(state().project.tracks).toHaveLength(before + 1);
  });

  it('shows a 45-minute clip whole as soon as it is added', () => {
    state().addAssetAtPlayhead(asset('long', MINUTES_45));
    const { pixelsPerFrame, scrollLeftPx, viewportWidthPx } = state().ui;
    expect(isSpanVisible({ pixelsPerFrame, scrollLeftPx }, 0, MINUTES_45, viewportWidthPx)).toBe(true);
  });

  it('keeps the measured view width across a new project', () => {
    state().newProject();
    expect(state().ui.viewportWidthPx).toBe(1400);
  });
});

describe('long-footage plumbing', () => {
  it('gives a 45-minute source a waveform finer than one bucket per 1.3 s', () => {
    const buckets = bucketsFor(45 * 60);
    expect((45 * 60) / buckets).toBeLessThanOrEqual(0.01);
  });

  it('bounds waveform memory for very long sources', () => {
    expect(bucketsFor(10 * 3600)).toBe(1_000_000);
  });

  describe('parseRange (media:// streaming)', () => {
    const size = 2_000_000_000; // a 2 GB recording

    it('serves the byte range a seeking <video> asks for', () => {
      expect(parseRange('bytes=1000-1999', size)).toEqual({ start: 1000, end: 1999 });
    });

    it('serves an open-ended range to the end of the file', () => {
      expect(parseRange('bytes=1500000000-', size)).toEqual({ start: 1_500_000_000, end: size - 1 });
    });

    it('serves a suffix range (the moov atom at the end of an MP4)', () => {
      expect(parseRange('bytes=-500', size)).toEqual({ start: size - 500, end: size - 1 });
    });

    it('clamps a range that runs past the end', () => {
      expect(parseRange('bytes=0-99999999999', 1000)).toEqual({ start: 0, end: 999 });
    });

    it('rejects ranges it cannot satisfy rather than serving the wrong bytes', () => {
      expect(parseRange('bytes=5000-', 1000)).toBeNull();
      expect(parseRange('bytes=10-5', 1000)).toBeNull();
      expect(parseRange('bytes=0-10,20-30', 1000)).toBeNull();
      expect(parseRange('items=0-10', 1000)).toBeNull();
    });

    it('treats no header as "the whole file"', () => {
      expect(parseRange(null, 1000)).toBeNull();
    });
  });
});
