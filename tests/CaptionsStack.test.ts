import { describe, expect, it } from 'vitest';
import { captionOffsets } from '@renderer/captions/captionStack';

describe('captions of several tracks on screen together', () => {
  it('leaves a caption alone where it is', () => {
    expect(captionOffsets([{ id: 'a', anchor: 'bottom', height: 110, gap: 14 }]).size).toBe(0);
  });

  it('lifts the upper track above the lower one at the bottom, by its height and a gap', () => {
    const offsets = captionOffsets([
      { id: 'low', anchor: 'bottom', height: 110, gap: 14 },
      { id: 'high', anchor: 'bottom', height: 55, gap: 14 },
    ]);
    expect(offsets.has('low')).toBe(false);
    expect(offsets.get('high')).toBe(-124);
  });

  it('stacks a third one above both', () => {
    const offsets = captionOffsets([
      { id: 'a', anchor: 'bottom', height: 100, gap: 10 },
      { id: 'b', anchor: 'bottom', height: 50, gap: 10 },
      { id: 'c', anchor: 'bottom', height: 50, gap: 10 },
    ]);
    expect(offsets.get('b')).toBe(-110);
    expect(offsets.get('c')).toBe(-170);
  });

  it('lowers one at the top below another at the top, and keeps the edges apart', () => {
    const offsets = captionOffsets([
      { id: 'bottom', anchor: 'bottom', height: 100, gap: 10 },
      { id: 'top1', anchor: 'top', height: 60, gap: 10 },
      { id: 'top2', anchor: 'top', height: 60, gap: 10 },
    ]);
    expect(offsets.has('bottom')).toBe(false);
    expect(offsets.has('top1')).toBe(false);
    expect(offsets.get('top2')).toBe(70);
  });

  it('does not move one pinned to the middle', () => {
    const offsets = captionOffsets([
      { id: 'a', anchor: 'center', height: 100, gap: 10 },
      { id: 'b', anchor: 'center', height: 100, gap: 10 },
    ]);
    expect(offsets.size).toBe(0);
  });
});
