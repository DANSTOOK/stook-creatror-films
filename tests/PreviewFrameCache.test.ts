import { describe, expect, it } from 'vitest';
import { PreviewFrameCache, previewCapacity } from '@renderer/engine/PreviewFrameCache';

/**
 * The frames a scrub has already decoded, kept for going back over them.
 * Backwards dragging showed the exact frame about 7% of the time.
 */

class Picture {
  closed = false;
  constructor(readonly name: string) {}
  close(): void {
    this.closed = true;
  }
}

const frameUs = (index: number) => Math.round((index / 30) * 1e6);

describe('PreviewFrameCache', () => {
  it('answers exactly the frame it was given, and nothing for its neighbours', () => {
    const cache = new PreviewFrameCache<Picture>(10);
    const picture = new Picture('f5');
    cache.put(frameUs(5), picture, frameUs(5));

    expect(cache.get(frameUs(5))).toBe(picture);
    expect(cache.get(frameUs(4))).toBeUndefined();
    expect(cache.get(frameUs(6))).toBeUndefined();
  });

  it('when full, gives up the frame farthest from the playhead', () => {
    const cache = new PreviewFrameCache<Picture>(3);
    const pictures = [0, 1, 2, 3].map((i) => new Picture(`f${i}`));
    pictures.slice(0, 3).forEach((picture, i) => cache.put(frameUs(i), picture, frameUs(i)));

    // Dragging back towards frame 1 while frame 3 arrives: frame 0 and frame 3
    // are equally far from 1.5 in spirit, but 3 is the farthest from 1.
    cache.put(frameUs(3), pictures[3], frameUs(1));

    expect(cache.size).toBe(3);
    expect(cache.has(frameUs(1))).toBe(true);
    expect(pictures.filter((picture) => picture.closed).map((picture) => picture.name)).toEqual(['f3']);
  });

  it('keeps the neighbourhood of a drag back and forth', () => {
    const cache = new PreviewFrameCache<Picture>(60);
    // A forward drag over 200 frames...
    for (let i = 0; i < 200; i += 1) cache.put(frameUs(i), new Picture(`f${i}`), frameUs(i));
    // ...holds the last 60, the ones the drag back will reach first.
    expect(cache.has(frameUs(199))).toBe(true);
    expect(cache.has(frameUs(140))).toBe(true);
    expect(cache.has(frameUs(139))).toBe(false);
    expect(cache.has(frameUs(0))).toBe(false);
  });

  it('closes a picture it replaces, and everything on clear', () => {
    const cache = new PreviewFrameCache<Picture>(5);
    const first = new Picture('first');
    const second = new Picture('second');
    cache.put(frameUs(1), first, 0);
    cache.put(frameUs(1), second, 0);
    expect(first.closed).toBe(true);
    expect(cache.get(frameUs(1))).toBe(second);

    cache.clear();
    expect(second.closed).toBe(true);
    expect(cache.size).toBe(0);
  });
});

describe('previewCapacity', () => {
  it('fits about 13 seconds of 480x270 previews in the default budget', () => {
    // 192 MiB / (480 x 270 x 4 bytes) = 388 frames, 12.9 s at 30 fps.
    expect(previewCapacity(480, 270)).toBe(388);
  });

  it('never holds less than a second, however large the frames', () => {
    expect(previewCapacity(7680, 4320)).toBe(30);
  });
});
