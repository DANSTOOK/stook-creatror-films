/**
 * Small copies of frames already decoded, around the playhead.
 *
 * Dragging the playhead backwards used to show the exact frame about 7% of the
 * time: every step back meant restarting a decoder at a keyframe, or seeking
 * the video element, and either takes longer than the hand takes to move on.
 * But a forward drag had just decoded every one of those frames - and thrown
 * them away. This keeps them, as small pictures, so going back over ground
 * just covered is a lookup.
 *
 * Bounded by a count worked out from a memory budget. When it is full, what
 * goes is whatever lies farthest from where the playhead is now: a drag back
 * and forth keeps its neighbourhood, and the far end of a long drag is the
 * first thing given up.
 *
 * Keyed by the sample's timestamp in microseconds - the same key the reader
 * itself resolves a timeline frame to - so a lookup can never answer with a
 * neighbouring frame. Pure apart from `close`, so it is tested directly.
 */

export interface ClosablePicture {
  close(): void;
}

/** Memory for the previews of one clip: 388 frames at 480x270, about 13 s of 30 fps. */
export const PREVIEW_BUDGET_BYTES = 192 * 1024 * 1024;

/** How many previews of this size fit the budget - never fewer than a second's worth. */
export function previewCapacity(width: number, height: number, budgetBytes = PREVIEW_BUDGET_BYTES): number {
  const bytes = Math.max(1, width * height * 4);
  return Math.max(30, Math.floor(budgetBytes / bytes));
}

export class PreviewFrameCache<Picture extends ClosablePicture> {
  private readonly entries = new Map<number, Picture>();

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  has(timestamp: number): boolean {
    return this.entries.has(timestamp);
  }

  get(timestamp: number): Picture | undefined {
    return this.entries.get(timestamp);
  }

  /** Keep `picture` for `timestamp`; beyond capacity, drop what is farthest from `focus`. */
  put(timestamp: number, picture: Picture, focus: number): void {
    const previous = this.entries.get(timestamp);
    if (previous && previous !== picture) previous.close();
    this.entries.set(timestamp, picture);

    while (this.entries.size > this.capacity) {
      let farthest = timestamp;
      let distance = -1;
      for (const key of this.entries.keys()) {
        const gap = Math.abs(key - focus);
        if (gap > distance) {
          distance = gap;
          farthest = key;
        }
      }
      this.entries.get(farthest)?.close();
      this.entries.delete(farthest);
    }
  }

  clear(): void {
    for (const picture of this.entries.values()) picture.close();
    this.entries.clear();
  }
}
