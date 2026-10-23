import type { Clip, ProjectState } from '@shared/types';
import { createClip } from '@renderer/store/types';

/**
 * Compound clips: several clips - pictures, titles, stickers, their sound -
 * made one, to move, trim, cut and put effects on as one, as Final Cut's
 * compound clips and CapCut's are. The one clip plays a render of them
 * (edit/compoundRun.ts); the clips themselves are kept inside it, and
 * "Break apart" puts them back where they were - moved along with it if it
 * was moved. Pure: the store runs each as one undo step.
 */

export interface CompoundContent {
  /** The clips it was made of, as they were. */
  clips: Clip[];
  /** Where the first of them started then: they come back relative to it. */
  spanStart: number;
}

/** The clips that can go into a compound clip: none of them a caption, at least one a picture. */
export function canCompound(project: ProjectState, clipIds: readonly string[]): boolean {
  const clips = clipIds.map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip));
  if (clips.length < 2 || clips.some((clip) => clip.caption || clip.compound)) return false;
  const types = new Map(project.tracks.map((track) => [track.id, track.type]));
  return clips.some((clip) => types.get(clip.trackId) === 'video');
}

/** The span the clips cover on the timeline: from the first start to the last end. */
export function compoundSpan(clips: readonly Clip[]): { from: number; to: number } {
  return {
    from: Math.min(...clips.map((clip) => clip.startFrame)),
    to: Math.max(...clips.map((clip) => clip.startFrame + clip.durationFrames)),
  };
}

/** Just these clips, and the transitions between them: what the compound clip renders. */
export function subsetProject(project: ProjectState, clipIds: readonly string[]): ProjectState {
  const chosen = new Set(clipIds);
  const clips = Object.fromEntries(Object.entries(project.clips).filter(([id]) => chosen.has(id)));
  const transitions = Object.fromEntries(
    Object.entries(project.transitions ?? {}).filter(([, transition]) => chosen.has(transition.fromClipId) && chosen.has(transition.toClipId)),
  );
  return { ...project, clips, transitions, markers: [] };
}

/**
 * `project` with `clipIds` replaced by one clip playing `sourceUri` - on the
 * lowest picture track among them, over their whole span - which keeps them.
 */
export function withCompound(project: ProjectState, clipIds: readonly string[], sourceUri: string, name: string): { project: ProjectState; clipId: string | null } {
  const clips = clipIds.map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip));
  if (clips.length === 0) return { project, clipId: null };
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const pictures = clips.filter((clip) => tracks.get(clip.trackId)?.type === 'video');
  const lowest = [...pictures].sort((a, b) => (tracks.get(a.trackId)?.order ?? 0) - (tracks.get(b.trackId)?.order ?? 0))[0] ?? clips[0];
  const span = compoundSpan(clips);
  const made = createClip({ trackId: lowest.trackId, name, sourceUri, startFrame: span.from, durationFrames: span.to - span.from, hasAlphaChannel: true });
  const compound: CompoundContent = { clips: clips.map((clip) => structuredClone(clip)), spanStart: span.from };
  const remaining = Object.fromEntries(Object.entries(project.clips).filter(([id]) => !clipIds.includes(id)));
  const transitions = Object.fromEntries(
    Object.entries(project.transitions ?? {}).filter(([, transition]) => !clipIds.includes(transition.fromClipId) && !clipIds.includes(transition.toClipId)),
  );
  return {
    project: { ...project, clips: { ...remaining, [made.id]: { ...made, compound } }, transitions },
    clipId: made.id,
  };
}

/** `project` with compound clip `clipId` broken apart: its clips back, moved as far as it was moved. */
export function withoutCompound(project: ProjectState, clipId: string): ProjectState {
  const clip = project.clips[clipId];
  if (!clip?.compound) return project;
  const shift = clip.startFrame - clip.compound.spanStart;
  const known = new Set(project.tracks.map((track) => track.id));
  const clips: Record<string, Clip> = Object.fromEntries(Object.entries(project.clips).filter(([id]) => id !== clipId));
  for (const inner of clip.compound.clips) {
    clips[inner.id] = { ...inner, startFrame: Math.max(0, inner.startFrame + shift), trackId: known.has(inner.trackId) ? inner.trackId : clip.trackId };
  }
  return { ...project, clips };
}
