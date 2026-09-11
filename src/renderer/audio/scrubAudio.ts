import type { ProjectState } from '@shared/types';
import { hasSoloedTrack, isTrackAudible } from './mixRouting';

/**
 * Audio while the playhead is dragged.
 *
 * Every editor plays the sound under a dragged playhead: short grains of what
 * is there, one per movement, so a word or a beat can be found by ear. This
 * plans those grains - which clips sound at a frame, from where in their
 * source and for how long - and the engine plays them through the same clip
 * and track strips as playback, so volume, pan, EQ and mute all apply.
 *
 * Pure and exported for tests.
 */

/** Length of one grain. Long enough to recognise a syllable. */
export const GRAIN_SECONDS = 0.085;

/** Minimum gap between grains; faster drags only move the next grain. */
export const GRAIN_INTERVAL_MS = 45;

export interface ScrubGrain {
  clipId: string;
  trackId: string;
  sourceUri: string;
  /** Where in the source the grain starts, seconds. */
  offsetSeconds: number;
  durationSeconds: number;
}

/**
 * The grains to play for the playhead at `frame`: one per audible clip under
 * it, cut short at the clip's end. `hasAudio` says whether a source has
 * decoded audio at all (a still, or a video without sound, has none).
 */
export function planScrubGrains(
  project: ProjectState,
  frame: number,
  hasAudio: (uri: string) => boolean,
): ScrubGrain[] {
  const { fps } = project;
  const anySolo = hasSoloedTrack(project);
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const grains: ScrubGrain[] = [];

  for (const clip of Object.values(project.clips)) {
    const track = tracks.get(clip.trackId);
    // Mute and solo hold for scrubbing exactly as for playback.
    if (!track || !isTrackAudible(track, anySolo)) continue;
    if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
    if (!hasAudio(clip.sourceUri)) continue;

    const intoClipSeconds = (frame - clip.startFrame) / fps;
    const remainingSeconds = (clip.startFrame + clip.durationFrames - frame) / fps;
    grains.push({
      clipId: clip.id,
      trackId: track.id,
      sourceUri: clip.sourceUri,
      offsetSeconds: clip.sourceOffsetFrames / fps + intoClipSeconds,
      durationSeconds: Math.min(GRAIN_SECONDS, remainingSeconds),
    });
  }

  return grains;
}

type ScrubListener = (frame: number) => void;
const listeners = new Set<ScrubListener>();

/**
 * Say that the user moved the playhead by hand - a drag on the ruler or the
 * preview bar, or a frame step - as opposed to playback moving it.
 */
export function emitScrub(frame: number): void {
  for (const listener of listeners) listener(frame);
}

export function onScrub(listener: ScrubListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
