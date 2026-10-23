import type { Clip, Marker, ProjectState } from '@shared/types';
import { createMarker } from '@renderer/store/types';
import { speedOf } from '@renderer/timing/clipSpeed';
import { clipEndFrame } from '@renderer/components/Timeline/timelineOps';
import { clipSourceSeconds } from './silences';
import { splitAtFrames } from './scenes';

/**
 * Cutting to the music: the beats of a music clip (main/media/beats.ts) as
 * frames of the timeline - every beat, every second one, or every bar - put
 * down as markers, or the pictures cut there, so each shot lasts a beat. Pure:
 * the store runs each as one undo step.
 */

export type BeatEvery = 1 | 2 | 4;

/** The colour beat markers wear, so they read apart from one's own. */
export const BEAT_MARKER_COLOR = '#f59e0b';

/** The timeline frames inside `clip` where its beats fall (`every` beats; 4 starts each bar). */
export function beatTimelineFrames(clip: Clip, beats: readonly number[], downbeats: readonly number[], every: BeatEvery, fps: number): number[] {
  const span = clipSourceSeconds(clip, fps);
  const speed = speedOf(clip);
  const end = clipEndFrame(clip);
  const chosen = every === 4 ? downbeats : beats.filter((_, index) => index % every === 0);
  // The beats are counted from the start of the stretch analysed: the clip's own start in its file.
  const frames = chosen
    .map((at) => Math.round(clip.startFrame + (at * fps) / speed))
    .filter((frame) => frame >= clip.startFrame && frame < end && span.to > span.from);
  return [...new Set(frames)].sort((a, b) => a - b);
}

/** `project` with a beat marker at each of `frames`, none twice on a frame. */
export function withBeatMarkers(project: ProjectState, frames: readonly number[]): ProjectState {
  const taken = new Set(project.markers.map((marker) => marker.frame));
  const added: Marker[] = frames.filter((frame) => !taken.has(frame)).map((frame) => createMarker(frame, '♪', BEAT_MARKER_COLOR));
  if (added.length === 0) return project;
  return { ...project, markers: [...project.markers, ...added].sort((a, b) => a.frame - b.frame) };
}

/** `project` with its beat markers taken away (the ones withBeatMarkers put down). */
export function withoutBeatMarkers(project: ProjectState): ProjectState {
  const kept = project.markers.filter((marker) => !(marker.label === '♪' && marker.color === BEAT_MARKER_COLOR));
  return kept.length === project.markers.length ? project : { ...project, markers: kept };
}

/**
 * `project` with every picture clip (not on `exceptTrackId`, and not a title
 * or a caption) cut at each of `frames` inside it - with what is linked to it,
 * as a razor cut leaves them.
 */
export function withCutsAtBeats(project: ProjectState, frames: readonly number[], exceptTrackId: string): { project: ProjectState; cuts: number } {
  const types = new Map(project.tracks.map((track) => [track.id, track.type]));
  let clips = project.clips;
  let cuts = 0;
  const done = new Set<string>();
  for (const clip of Object.values(project.clips)) {
    if (done.has(clip.id) || clip.trackId === exceptTrackId || types.get(clip.trackId) !== 'video' || clip.title || clip.caption) continue;
    const group = clip.linkGroup ? Object.values(clips).filter((other) => other.linkGroup === clip.linkGroup).map((other) => other.id) : [clip.id];
    group.forEach((id) => done.add(id));
    const inside = frames.filter((frame) => frame > clip.startFrame && frame < clipEndFrame(clip));
    if (inside.length === 0) continue;
    const result = splitAtFrames(clips, group, inside);
    clips = result.clips;
    cuts += result.pieces - 1;
  }
  return { project: cuts > 0 ? { ...project, clips } : project, cuts };
}
