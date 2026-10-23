import { describe, expect, it } from 'vitest';
import { createClip, createEmptyProject } from '../src/renderer/store/types';
import { canCompound, compoundSpan, subsetProject, withCompound, withoutCompound } from '../src/renderer/edit/compound';
import type { ProjectState } from '../src/shared/types';

function threeClips(): { project: ProjectState; ids: string[] } {
  const project = createEmptyProject(1280, 720, 30);
  const [lower, upper, sound] = project.tracks;
  const a = createClip({ trackId: lower.id, name: 'a', sourceUri: 'a.mp4', startFrame: 30, durationFrames: 60 });
  const b = createClip({ trackId: upper.id, name: 'b', sourceUri: 'b.png', startFrame: 60, durationFrames: 60 });
  const c = createClip({ trackId: sound.id, name: 'c', sourceUri: 'c.wav', startFrame: 20, durationFrames: 40 });
  const other = createClip({ trackId: lower.id, name: 'other', sourceUri: 'o.mp4', startFrame: 200, durationFrames: 30 });
  project.clips = { [a.id]: a, [b.id]: b, [c.id]: c, [other.id]: other };
  project.transitions = {
    t1: { id: 't1', fromClipId: a.id, toClipId: b.id } as never,
    t2: { id: 't2', fromClipId: a.id, toClipId: other.id } as never,
  };
  return { project, ids: [a.id, b.id, c.id, other.id] };
}

describe('compound clips', () => {
  it('needs two clips, one of them a picture', () => {
    const { project, ids } = threeClips();
    expect(canCompound(project, [ids[0]])).toBe(false);
    expect(canCompound(project, [ids[0], ids[1]])).toBe(true);
    expect(canCompound(project, [ids[2], ids[2]])).toBe(false);
  });

  it('covers the whole span of the clips', () => {
    const { project, ids } = threeClips();
    expect(compoundSpan(ids.slice(0, 3).map((id) => project.clips[id]))).toEqual({ from: 20, to: 120 });
  });

  it('renders just the chosen clips and the transitions between them', () => {
    const { project, ids } = threeClips();
    const subset = subsetProject(project, ids.slice(0, 3));
    expect(Object.keys(subset.clips).sort()).toEqual(ids.slice(0, 3).sort());
    expect(Object.keys(subset.transitions ?? {})).toEqual(['t1']);
  });

  it('replaces them with one clip on the lowest picture track, which keeps them', () => {
    const { project, ids } = threeClips();
    const { project: made, clipId } = withCompound(project, ids.slice(0, 3), 'compound.webm', 'Compound clip 1');
    expect(clipId).not.toBeNull();
    const compound = made.clips[clipId!];
    expect(compound.trackId).toBe(project.tracks[0].id);
    expect(compound.startFrame).toBe(20);
    expect(compound.durationFrames).toBe(100);
    expect(compound.compound?.clips.map((clip) => clip.id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(Object.keys(made.clips).sort()).toEqual([clipId!, ids[3]].sort());
    // A transition into a clip that went inside has nothing to join any more.
    expect(Object.keys(made.transitions ?? {})).toEqual([]);
  });

  it('breaks apart into the clips as they were, moved as far as it was', () => {
    const { project, ids } = threeClips();
    const { project: made, clipId } = withCompound(project, ids.slice(0, 3), 'compound.webm', 'Compound clip 1');
    const moved = { ...made, clips: { ...made.clips, [clipId!]: { ...made.clips[clipId!], startFrame: 50 } } };
    const apart = withoutCompound(moved, clipId!);
    expect(apart.clips[clipId!]).toBeUndefined();
    expect(apart.clips[ids[0]]).toEqual({ ...project.clips[ids[0]], startFrame: 60 });
    expect(apart.clips[ids[1]].startFrame).toBe(90);
    expect(apart.clips[ids[2]].startFrame).toBe(50);
    expect(apart.clips[ids[2]].trackId).toBe(project.clips[ids[2]].trackId);
  });

  it('leaves a clip that is not compound alone', () => {
    const { project, ids } = threeClips();
    expect(withoutCompound(project, ids[0])).toBe(project);
  });
});
