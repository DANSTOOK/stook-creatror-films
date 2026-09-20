import type { Clip, MediaAsset, ProjectState, Track } from '@shared/types';
import { createId } from '@shared/utils/id';
import { clipEndFrame, moveClip } from './timelineOps';
import { regroupCopies } from './linkGroups';
import { insertIntoTrack } from './trackPacking';
import { trackAccepts } from './trackRows';

/**
 * Point 10: Ctrl+C, Ctrl+X, Ctrl+V for clips.
 *
 * A copy is a snapshot: later edits to the originals do not change what gets
 * pasted, and deleting them (Ctrl+X) does not empty the clipboard. A paste
 * lands at the playhead, keeps the timing between the copied clips and their
 * tracks, and is INSERTED like any other placement - what it would cover
 * moves along (point 8).
 *
 * Pure: the store holds the clipboard and applies the result.
 */

export interface ClipboardContent {
  /** Deep copies, in timeline order. */
  clips: Clip[];
  /** Type of each copied clip's track, to find a home if that track is gone. */
  trackTypes: Record<string, Track['type']>;
}

export function copyClips(project: ProjectState, ids: readonly string[]): ClipboardContent | null {
  const clips = ids
    .map((id) => project.clips[id])
    .filter((clip): clip is Clip => Boolean(clip))
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((clip) => structuredClone(clip));
  if (clips.length === 0) return null;

  const trackTypes: Record<string, Track['type']> = {};
  for (const clip of clips) {
    const track = project.tracks.find((candidate) => candidate.id === clip.trackId);
    if (track) trackTypes[clip.trackId] = track.type;
  }
  return { clips, trackTypes };
}

export interface PasteResult {
  /** Every clip after the paste: the new ones, and any that moved along. */
  clips: Record<string, Clip>;
  pastedIds: string[];
  /** Last frame the pasted clips cover, for the playhead to go to. */
  endFrame: number;
}

/**
 * Paste `content` with its earliest clip at `atFrame`.
 *
 * Each clip goes back on the track it was copied from when that track is
 * still there, unlocked and of the right kind; otherwise on the first track
 * that can take it. A clip with nowhere to go is left out.
 */
export function pasteClips(
  project: ProjectState,
  content: ClipboardContent,
  atFrame: number,
  assets: readonly MediaAsset[],
): PasteResult {
  const clips = { ...project.clips };
  const pastedIds: string[] = [];
  const earliest = Math.min(...content.clips.map((clip) => clip.startFrame));
  const ordered = [...project.tracks].sort((a, b) => a.order - b.order);
  let endFrame = atFrame;

  for (const original of content.clips) {
    const kind = assets.find((asset) => asset.uri === original.sourceUri)?.kind;
    const usable = (track: Track): boolean => !track.locked && trackAccepts(track, kind);

    const home = ordered.find((track) => track.id === original.trackId);
    const wantedType = content.trackTypes[original.trackId];
    const track =
      (home && usable(home) ? home : undefined) ??
      ordered.find((candidate) => usable(candidate) && (!wantedType || candidate.type === wantedType)) ??
      ordered.find(usable);
    if (!track) continue;

    const desired = Math.max(0, Math.round(atFrame + original.startFrame - earliest));
    const insertion = insertIntoTrack(
      Object.values(clips).filter((clip) => clip.trackId === track.id),
      desired,
      original.durationFrames,
    );
    for (const [id, start] of insertion.shifts) clips[id] = moveClip(clips[id], start);

    // A fresh copy each paste, so pasting twice gives two independent clips.
    const pasted = moveClip({ ...structuredClone(original), id: createId('clip') }, insertion.startFrame, track.id);
    clips[pasted.id] = pasted;
    pastedIds.push(pasted.id);
    endFrame = Math.max(endFrame, clipEndFrame(pasted));
  }

  // Pasted clips are linked to each other when they came over linked, and
  // never to the clips they were copied from.
  for (const pasted of regroupCopies(pastedIds.map((id) => clips[id]))) clips[pasted.id] = pasted;

  return { clips, pastedIds, endFrame };
}
