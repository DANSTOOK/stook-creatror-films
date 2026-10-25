import { assetLengthFrames } from '@renderer/media/assetLength';
import { clipsOnTrackExcept, insertIntoTrack } from './trackPacking';
import type { MediaKind, ProjectState, Track } from '@shared/types';

/**
 * Where dropped media lands on the timeline.
 *
 * Pure, so the rules are unit tested rather than discovered by dragging:
 *
 * - a video or a still goes on a video track, audio on an audio track;
 * - the track under the pointer is used when it can take the asset and is not
 *   locked, otherwise the first one that can - and if none exists, a new track
 *   of the right type is asked for (`trackId: null`);
 * - the first asset starts where it was dropped, and several dropped together
 *   follow one another on their track;
 * - with the magnet on, the main track keeps no hole at its end, as CapCut's
 *   main track: a drop past its last clip lands against it (at 0 on an empty
 *   track).
 *
 * Nothing ends up on top of an existing clip, but that is settled when the
 * clips are placed (`insertIntoTrack`): the new clip is INSERTED where it was
 * dropped and what it would cover moves along. It used to be pushed past the
 * clip in its way instead, so a still dropped just before a video landed
 * after it, and dragging it back where it was meant to go overlapped the two.
 */

export interface DroppedAsset {
  id: string;
  kind: MediaKind;
  durationFrames: number;
  durationSeconds?: number;
}

export interface DropPlacement {
  assetId: string;
  /** The track to place on, or null when a new track has to be created. */
  trackId: string | null;
  trackType: Track['type'];
  startFrame: number;
  durationFrames: number;
}

export const trackTypeFor = (kind: MediaKind): Track['type'] =>
  kind === 'audio' ? 'audio' : 'video';

/** The main track: the bottom picture track, the one the edit is built on. */
export function mainTrackOf(tracks: readonly Track[]): Track | null {
  return [...tracks].filter((track) => track.type === 'video').sort((a, b) => a.order - b.order)[0] ?? null;
}

/** Where the last clip on a track ends, or 0 when it has none. */
function trackEnd(project: ProjectState, trackId: string): number {
  let end = 0;
  for (const clip of Object.values(project.clips)) {
    if (clip.trackId === trackId) end = Math.max(end, clip.startFrame + clip.durationFrames);
  }
  return end;
}

export function planDrop(
  project: ProjectState,
  assets: readonly DroppedAsset[],
  targetTrackId: string | null,
  frame: number,
  /** The magnet: on the main track a drop past the last clip lands against it. */
  options: { magnet?: boolean } = {},
): DropPlacement[] {
  const ordered = [...project.tracks].sort((a, b) => a.order - b.order);
  const target = ordered.find((track) => track.id === targetTrackId);
  const main = options.magnet ? mainTrackOf(project.tracks) : null;

  const chooseTrack = (type: Track['type']): Track | null => {
    if (target && target.type === type && !target.locked) return target;
    return ordered.find((track) => track.type === type && !track.locked) ?? null;
  };

  // Where the next asset on each track starts: the drop point first, then the
  // end of whatever was just placed there.
  const cursor = new Map<string, number>();

  return assets.map((asset) => {
    const trackType = trackTypeFor(asset.kind);
    const track = chooseTrack(trackType);
    // A track that does not exist yet is keyed by type, so two dropped clips
    // bound for the same new track still follow one another.
    const key = track?.id ?? `new:${trackType}`;
    const length = assetLengthFrames(asset, project.fps);

    let start = cursor.get(key) ?? frame;
    // The first one on the main track, with the magnet: no hole before it.
    if (main && track?.id === main.id && !cursor.has(key)) start = Math.min(start, trackEnd(project, main.id));
    const startFrame = Math.max(0, Math.round(start));
    cursor.set(key, startFrame + length);

    return { assetId: asset.id, trackId: track?.id ?? null, trackType, startFrame, durationFrames: length };
  });
}

/** Where a drop is shown landing before it is made. */
export interface DropLanding {
  /** The track it lands on, or null for a new one. */
  trackId: string | null;
  start: number;
  end: number;
}

/**
 * Where a dropped asset will really land: planDrop's track and frame, moved
 * to the near edge of a clip it would cut into, as placeAssets inserts it.
 * So the timeline can draw it there while the drag is still over it. One
 * asset at a time, which is what the media panel drags.
 */
export function dropLandings(
  project: ProjectState,
  assets: readonly DroppedAsset[],
  targetTrackId: string | null,
  frame: number,
  options: { magnet?: boolean } = {},
): DropLanding[] {
  return planDrop(project, assets, targetTrackId, frame, options).map((placement) => {
    const start = placement.trackId
      ? insertIntoTrack(clipsOnTrackExcept(project.clips, placement.trackId, new Set()), placement.startFrame, placement.durationFrames).startFrame
      : placement.startFrame;
    return { trackId: placement.trackId, start, end: start + placement.durationFrames };
  });
}

/**
 * Drag payload type for an asset dragged out of the media panel. A custom type
 * rather than text, so dropping it into an unrelated field does nothing and a
 * drop target can tell it apart from files coming from the OS.
 */
export const ASSET_DRAG_TYPE = 'application/x-filmora-asset';
