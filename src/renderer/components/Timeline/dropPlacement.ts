import type { MediaKind, ProjectState, Track } from '@shared/types';
import { clipEndFrame } from './timelineOps';

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
 * - nothing is ever placed on top of an existing clip: an asset that would
 *   overlap one is pushed to that clip's end. A drop that silently covered
 *   part of the edit would be a destructive edit nobody asked for.
 */

export interface DroppedAsset {
  id: string;
  kind: MediaKind;
  durationFrames: number;
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

interface Span {
  start: number;
  end: number;
}

/** First start at or after `from` where `[start, start + length)` is free. */
function firstFreeStart(spans: readonly Span[], from: number, length: number): number {
  let start = Math.max(0, Math.round(from));
  const sorted = [...spans].sort((a, b) => a.start - b.start);

  // Each pass can only move `start` forward, and never past the last span, so
  // this terminates after at most one pass per span.
  let moved = true;
  while (moved) {
    moved = false;
    for (const span of sorted) {
      if (start < span.end && span.start < start + length) {
        start = span.end;
        moved = true;
      }
    }
  }
  return start;
}

export function planDrop(
  project: ProjectState,
  assets: readonly DroppedAsset[],
  targetTrackId: string | null,
  frame: number,
): DropPlacement[] {
  const ordered = [...project.tracks].sort((a, b) => a.order - b.order);
  const target = ordered.find((track) => track.id === targetTrackId);

  const chooseTrack = (type: Track['type']): Track | null => {
    if (target && target.type === type && !target.locked) return target;
    return ordered.find((track) => track.type === type && !track.locked) ?? null;
  };

  // Occupied spans per track, including what this drop has already placed.
  const occupied = new Map<string, Span[]>();
  const spansFor = (key: string): Span[] => {
    let spans = occupied.get(key);
    if (!spans) {
      spans = Object.values(project.clips)
        .filter((clip) => clip.trackId === key)
        .map((clip) => ({ start: clip.startFrame, end: clipEndFrame(clip) }));
      occupied.set(key, spans);
    }
    return spans;
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
    const length = Math.max(1, Math.round(asset.durationFrames));

    const from = cursor.get(key) ?? frame;
    const spans = spansFor(key);
    const startFrame = firstFreeStart(spans, from, length);

    spans.push({ start: startFrame, end: startFrame + length });
    cursor.set(key, startFrame + length);

    return { assetId: asset.id, trackId: track?.id ?? null, trackType, startFrame, durationFrames: length };
  });
}

/**
 * Drag payload type for an asset dragged out of the media panel. A custom type
 * rather than text, so dropping it into an unrelated field does nothing and a
 * drop target can tell it apart from files coming from the OS.
 */
export const ASSET_DRAG_TYPE = 'application/x-filmora-asset';
