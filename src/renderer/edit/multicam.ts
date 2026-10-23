import type { Clip, MulticamAngle, ProjectState } from '@shared/types';
import { splitClip } from '@renderer/components/Timeline/timelineOps';

/**
 * Multicam: one take filmed by several cameras, edited as one clip that
 * shows one camera at a time - Final Cut's and Premiere's multicam clips.
 * The angles are lined up once (by their sound, edit/multicamRun.ts, or as
 * they sat on the timeline); after that, switching angle at the playhead
 * cuts the clip there and shows the other camera from the same moment.
 * Its sound stays the first angle's, on a clip of its own, so cutting
 * between cameras never cuts the sound. Pure: the store runs each as one
 * undo step.
 */

/** Up to nine angles: one a number key. */
export const MAX_ANGLES = 9;

/** Clips that can be the angles of a multicam clip: two to nine pictures from video files. */
export function canMulticam(project: ProjectState, clipIds: readonly string[], kindOf: (uri: string) => string | undefined): boolean {
  const clips = [...new Set(clipIds)].map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip));
  if (clips.length < 2 || clips.length > MAX_ANGLES) return false;
  const types = new Map(project.tracks.map((track) => [track.id, track.type]));
  return clips.every(
    (clip) => types.get(clip.trackId) === 'video' && kindOf(clip.sourceUri) === 'video' && !clip.audioOnly && !clip.title && !clip.caption && !clip.compound && !clip.multicam && !clip.adjustment,
  );
}

/** The angle the clips start from: the one on the lowest track, then the earliest. */
export function masterOf(project: ProjectState, clipIds: readonly string[]): Clip | undefined {
  const order = new Map(project.tracks.map((track) => [track.id, track.order]));
  return clipIds
    .map((id) => project.clips[id])
    .filter((clip): clip is Clip => Boolean(clip))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.startFrame - b.startFrame)[0];
}

/**
 * Each clip's sync as it sits on the timeline: how many frames further into
 * its file than the master's any moment is. What the timeline shows lined
 * up, stays lined up.
 */
export function timelineSync(project: ProjectState, clipIds: readonly string[]): Map<string, number> {
  const master = masterOf(project, clipIds);
  const sync = new Map<string, number>();
  if (!master) return sync;
  const zero = master.sourceOffsetFrames - master.startFrame;
  for (const id of clipIds) {
    const clip = project.clips[id];
    if (clip) sync.set(id, clip.sourceOffsetFrames - clip.startFrame - zero);
  }
  return sync;
}

/**
 * `project` with `clipIds` made one multicam clip, in the master's place and
 * showing it; the others leave the timeline (they are its angles now).
 * `sync`: each clip's frames into its file past the master's (timelineSync,
 * or found by sound).
 */
export function withMulticam(
  project: ProjectState,
  clipIds: readonly string[],
  sync: ReadonlyMap<string, number>,
  names: ReadonlyMap<string, string>,
): { project: ProjectState; clipId: string | null } {
  const master = masterOf(project, clipIds);
  if (!master) return { project, clipId: null };
  const ids = [master.id, ...clipIds.filter((id) => id !== master.id && project.clips[id])];
  const angles: MulticamAngle[] = ids.map((id) => {
    const clip = project.clips[id];
    return { name: names.get(id) ?? clip.name, sourceUri: clip.sourceUri, syncFrames: id === master.id ? 0 : Math.round(sync.get(id) ?? 0), hasAlphaChannel: clip.hasAlphaChannel };
  });
  const clips = Object.fromEntries(Object.entries(project.clips).filter(([id]) => !ids.includes(id) || id === master.id));
  clips[master.id] = { ...master, name: angles[0].name, multicam: { angles, angle: 0 } };
  const transitions = Object.fromEntries(
    Object.entries(project.transitions ?? {}).filter(([, transition]) => {
      const gone = (id: string) => ids.includes(id) && id !== master.id;
      return !gone(transition.fromClipId) && !gone(transition.toClipId);
    }),
  );
  return { project: { ...project, clips, transitions }, clipId: master.id };
}

/** `clip` showing `angle` instead, from the same moment. */
export function showingAngle(clip: Clip, angle: number): Clip {
  const multicam = clip.multicam;
  const next = multicam?.angles[angle];
  if (!multicam || !next || angle === multicam.angle) return clip;
  const shown = multicam.angles[multicam.angle];
  return {
    ...clip,
    name: next.name,
    sourceUri: next.sourceUri,
    hasAlphaChannel: next.hasAlphaChannel ?? false,
    // A camera that had not started yet shows its first frame.
    sourceOffsetFrames: Math.max(0, clip.sourceOffsetFrames - shown.syncFrames + next.syncFrames),
    multicam: { ...multicam, angle },
  };
}

/**
 * `project` with multicam clip `clipId` cut at `atFrame` and showing `angle`
 * from there to the next cut - or, with no frame (or one at its start),
 * showing it all through. The piece that shows it, and its id.
 */
export function withAngle(project: ProjectState, clipId: string, angle: number, atFrame?: number): { project: ProjectState; clipId: string | null } {
  const clip = project.clips[clipId];
  if (!clip?.multicam || !clip.multicam.angles[angle]) return { project, clipId: null };
  if (clip.multicam.angle === angle) return { project, clipId };
  const pieces = atFrame === undefined ? null : splitClip(clip, atFrame);
  if (!pieces) return { project: { ...project, clips: { ...project.clips, [clipId]: showingAngle(clip, angle) } }, clipId };
  const [left, right] = pieces;
  const switched = showingAngle(right, angle);
  return { project: { ...project, clips: { ...project.clips, [left.id]: left, [switched.id]: switched } }, clipId: switched.id };
}

/** The multicam clip the playhead is over: the one on the highest track. */
export function multicamAt(project: ProjectState, frame: number): Clip | undefined {
  const order = new Map(project.tracks.map((track) => [track.id, track.order]));
  return Object.values(project.clips)
    .filter((clip) => clip.multicam && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames)
    .sort((a, b) => (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0))[0];
}
