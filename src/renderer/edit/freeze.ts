import type { Clip, ProjectState } from '@shared/types';
import { splitAtFrames } from './scenes';

/**
 * Freeze frame: the picture of a clip at the playhead held for a moment, the
 * clip cut there and everything after it moved along to make room - as
 * CapCut's Freeze and Premiere's Insert Frame Hold Segment do. The sound
 * linked to the clip is cut and moved with it, so it stays in sync; clips on
 * other tracks that run across the playhead (music under it) carry on.
 *
 * Pure: the store runs it as one undo step, with the still already made.
 */

/** The clip a freeze is taken from: the selected one under the playhead, else the topmost picture there. */
export function freezeSourceAt(project: ProjectState, selected: readonly string[], frame: number, canFreeze: (clip: Clip) => boolean): Clip | null {
  const under = (clip: Clip): boolean => frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames && canFreeze(clip);
  const chosen = selected.map((id) => project.clips[id]).find((clip) => clip && under(clip));
  if (chosen) return chosen;
  const order = new Map(project.tracks.map((track) => [track.id, track]));
  return (
    Object.values(project.clips)
      .filter((clip) => order.get(clip.trackId)?.type === 'video' && under(clip))
      .sort((a, b) => (order.get(b.trackId)?.order ?? 0) - (order.get(a.trackId)?.order ?? 0))[0] ?? null
  );
}

/**
 * `project` with `still` held at `frame` for its length, on `clipId`'s track:
 * the clip and its linked clips cut at `frame`, and every clip that starts
 * there or later moved along by the still's length - markers too.
 */
export function withFreeze(project: ProjectState, clipId: string, frame: number, still: Clip): ProjectState {
  const clip = project.clips[clipId];
  if (!clip) return project;
  const group = clip.linkGroup ? Object.values(project.clips).filter((other) => other.linkGroup === clip.linkGroup).map((other) => other.id) : [clip.id];
  const { clips: cut } = frame > clip.startFrame ? splitAtFrames(project.clips, group, [frame]) : { clips: project.clips };
  const length = still.durationFrames;
  const clips: Record<string, Clip> = {};
  for (const [id, other] of Object.entries(cut)) {
    clips[id] = other.startFrame >= frame ? { ...other, startFrame: other.startFrame + length } : other;
  }
  clips[still.id] = { ...still, trackId: clip.trackId, startFrame: frame };
  return {
    ...project,
    clips,
    markers: project.markers.map((marker) => (marker.frame >= frame ? { ...marker, frame: marker.frame + length } : marker)),
  };
}
