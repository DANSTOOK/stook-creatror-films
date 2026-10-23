import type { Clip, MaskConfig, ProjectState } from '@shared/types';
import { createId } from '@shared/utils/id';
import { createTrack } from '@renderer/store/types';
import { trackAboveFor } from '@renderer/components/Timeline/layers';
import { insertionRow, isPictureTrack, nextTrackName, timelineRows, withRowOrders } from '@renderer/components/Timeline/trackRows';

/**
 * Split screen and picture-in-picture: two to four clips laid out in the
 * frame at once - side by side, one above the other, a big one and two
 * small, a grid of four, or one in a corner of the other - as CapCut's and
 * Filmora's split-screen templates do.
 *
 * Each clip starts where the first of them starts, on a track of its own
 * (the corner picture on top), and fills its cell without being stretched:
 * scaled to cover it, centred on it, and cut to it by a rectangular mask.
 * Plain keyframes and a mask, so every cell can still be moved, sized and
 * re-cut in the inspector afterwards. Pure: the store runs it as one undo
 * step.
 */

export type SplitLayout = 'side' | 'stack' | 'pip' | 'main3' | 'columns3' | 'grid4';

/** A cell, as fractions of the frame from its top-left corner. */
interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const SPLIT_LAYOUTS: Record<SplitLayout, { clips: number; cells: readonly Cell[] }> = {
  side: { clips: 2, cells: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] },
  stack: { clips: 2, cells: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }] },
  // The corner picture: a third of the frame, a margin in from the bottom-right corner.
  pip: { clips: 2, cells: [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0.64, y: 0.6, w: 0.32, h: 0.32 }] },
  main3: { clips: 3, cells: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] },
  columns3: { clips: 3, cells: [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }] },
  grid4: {
    clips: 4,
    cells: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
};

/** The layouts for this many clips. */
export const layoutsFor = (count: number): SplitLayout[] =>
  (Object.keys(SPLIT_LAYOUTS) as SplitLayout[]).filter((layout) => SPLIT_LAYOUTS[layout].clips === count);

/** The gap between cells, in pixels of a 1080-line frame: a thin black line, as the templates have. */
const GAP = 6;

/** `cell` moved in from every edge it shares with another cell by half the gap, in pixels. */
function inset(cell: Cell, width: number, height: number, gap: number, corner: boolean): { x: number; y: number; w: number; h: number } {
  let left = cell.x * width;
  let top = cell.y * height;
  let right = (cell.x + cell.w) * width;
  let bottom = (cell.y + cell.h) * height;
  const half = gap / 2;
  const inner = (edge: number): boolean => edge > 1e-6 && edge < 1 - 1e-6;
  if (corner || inner(cell.x)) left += half;
  if (corner || inner(cell.y)) top += half;
  if (corner || inner(cell.x + cell.w)) right -= half;
  if (corner || inner(cell.y + cell.h)) bottom -= half;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * `project` with `clipIds` laid out in `layout`. `aspectOf` gives each clip's
 * picture shape (width over height), to cover its cell without stretching.
 */
export function withSplitLayout(
  project: ProjectState,
  clipIds: readonly string[],
  layout: SplitLayout,
  aspectOf: (clip: Clip) => number,
): ProjectState {
  const { cells, clips: count } = SPLIT_LAYOUTS[layout];
  const order = new Map(project.tracks.map((track) => [track.id, track.order]));
  const clips = clipIds
    .map((id) => project.clips[id])
    .filter((clip): clip is Clip => Boolean(clip))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.startFrame - b.startFrame);
  if (clips.length !== count) return project;
  const { width, height } = project;
  const gap = (GAP * height) / 1080;
  const start = Math.min(...clips.map((clip) => clip.startFrame));
  let next = project;

  clips.forEach((clip, index) => {
    const corner = layout === 'pip' && index === 1;
    const box = inset(cells[index], width, height, layout === 'pip' && index === 0 ? 0 : gap, corner);
    const aspect = aspectOf(clip) > 0 ? aspectOf(clip) : width / height;
    // Cover the cell: as tall as it, or as wide, whichever is the larger picture.
    const drawnHeight = Math.max(box.h, box.w / aspect);
    const drawnWidth = drawnHeight * aspect;
    const mask: MaskConfig = {
      enabled: true,
      type: 1,
      // The mask is placed in texture space, whose v runs up the frame.
      center: { x: (box.x + box.w / 2) / width, y: 1 - (box.y + box.h / 2) / height },
      size: { x: box.w / width, y: box.h / height },
      rotation: 0,
      cornerRadius: corner ? 0.02 : 0,
      feather: 0,
      invert: false,
    };
    const placed: Clip = {
      ...clip,
      startFrame: start,
      transform: {
        ...clip.transform,
        position: [{ id: createId('kf'), frame: 0, value: { x: box.x + box.w / 2 - width / 2, y: box.y + box.h / 2 - height / 2 }, easing: 'linear' }],
        scale: [{ id: createId('kf'), frame: 0, value: { x: drawnWidth / width, y: drawnHeight / height }, easing: 'linear' }],
        rotation: [],
      },
      mask,
    };
    next = { ...next, clips: { ...next.clips, [clip.id]: placed } };

    // A track of its own: the first keeps its own if nothing else is there now;
    // each other goes on the first free picture track above (a new one on top).
    const overlapping = Object.values(next.clips).some(
      (other) => other.id !== clip.id && other.trackId === placed.trackId && other.startFrame < start + placed.durationFrames && other.startFrame + other.durationFrames > start,
    );
    if (index === 0 && !overlapping) return;
    let rows = timelineRows(next.tracks);
    let trackId = trackAboveFor(next, clip.id);
    const own = next.tracks.find((track) => track.id === placed.trackId);
    const target = trackId ? next.tracks.find((track) => track.id === trackId) : undefined;
    if (!trackId || !target || !isPictureTrack(target) || (own && target.order <= own.order && index > 0)) {
      const track = createTrack('video', 0, nextTrackName(rows, 'video'));
      rows = [...rows];
      rows.splice(insertionRow(rows, 'video'), 0, track);
      trackId = track.id;
    }
    next = { ...next, tracks: withRowOrders(rows), clips: { ...next.clips, [clip.id]: { ...placed, trackId } } };
  });
  return next;
}
