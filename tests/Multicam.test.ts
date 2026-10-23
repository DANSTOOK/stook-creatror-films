import { describe, expect, it } from 'vitest';
import { createClip, createEmptyProject } from '../src/renderer/store/types';
import { canMulticam, masterOf, multicamAt, timelineSync, withAngle, withMulticam } from '../src/renderer/edit/multicam';
import { remapClipSources } from '../src/renderer/media/importMedia';
import type { ProjectState } from '../src/shared/types';

const kinds: Record<string, string> = { 'a.mp4': 'video', 'b.mp4': 'video', 'c.png': 'image' };
const kindOf = (uri: string) => kinds[uri];

function twoCameras(): { project: ProjectState; a: string; b: string } {
  const project = createEmptyProject(1280, 720, 30);
  const [lower, upper] = project.tracks;
  const a = createClip({ trackId: lower.id, name: 'a', sourceUri: 'a.mp4', startFrame: 10, durationFrames: 300, sourceOffsetFrames: 20 });
  const b = createClip({ trackId: upper.id, name: 'b', sourceUri: 'b.mp4', startFrame: 40, durationFrames: 250, sourceOffsetFrames: 5 });
  project.clips = { [a.id]: a, [b.id]: b };
  return { project, a: a.id, b: b.id };
}

describe('multicam clips', () => {
  it('takes two to nine pictures from video files', () => {
    const { project, a, b } = twoCameras();
    expect(canMulticam(project, [a, b], kindOf)).toBe(true);
    expect(canMulticam(project, [a], kindOf)).toBe(false);
    const still = createClip({ trackId: project.tracks[1].id, name: 'c', sourceUri: 'c.png', startFrame: 0, durationFrames: 30 });
    project.clips[still.id] = still;
    expect(canMulticam(project, [a, still.id], kindOf)).toBe(false);
  });

  it('starts from the angle on the lowest track', () => {
    const { project, a, b } = twoCameras();
    expect(masterOf(project, [b, a])?.id).toBe(a);
  });

  it('keeps what the timeline showed lined up, lined up', () => {
    const { project, a, b } = twoCameras();
    // At timeline frame 50: a shows its frame 60, b its frame 15 - 45 frames behind.
    expect(timelineSync(project, [a, b]).get(b)).toBe(-45);
  });

  it('becomes one clip in the master’s place, the other camera leaving the timeline', () => {
    const { project, a, b } = twoCameras();
    const { project: made, clipId } = withMulticam(project, [b, a], new Map([[b, -45]]), new Map([[a, 'Angle 1'], [b, 'Angle 2']]));
    expect(clipId).toBe(a);
    expect(Object.keys(made.clips)).toEqual([a]);
    expect(made.clips[a].multicam).toEqual({
      angles: [
        { name: 'Angle 1', sourceUri: 'a.mp4', syncFrames: 0, hasAlphaChannel: false },
        { name: 'Angle 2', sourceUri: 'b.mp4', syncFrames: -45, hasAlphaChannel: false },
      ],
      angle: 0,
    });
  });

  it('cuts at the playhead to the other camera, from the same moment', () => {
    const { project, a, b } = twoCameras();
    const { project: made } = withMulticam(project, [a, b], new Map([[b, -45]]), new Map());
    const { project: cut, clipId } = withAngle(made, a, 1, 110);
    const left = cut.clips[a];
    const right = cut.clips[clipId!];
    expect(left).toMatchObject({ startFrame: 10, durationFrames: 100, sourceUri: 'a.mp4', sourceOffsetFrames: 20 });
    // At 110 the master showed its frame 120; the second camera, 45 frames behind, its 75.
    expect(right).toMatchObject({ startFrame: 110, durationFrames: 200, sourceUri: 'b.mp4', sourceOffsetFrames: 75 });
    expect(right.multicam?.angle).toBe(1);
    // And back: the same moment of the first again.
    const back = withAngle(cut, clipId!, 0, 150);
    expect(back.project.clips[back.clipId!]).toMatchObject({ startFrame: 150, sourceUri: 'a.mp4', sourceOffsetFrames: 160 });
  });

  it('switches a whole piece with no frame, and does nothing for the angle it shows', () => {
    const { project, a, b } = twoCameras();
    const { project: made } = withMulticam(project, [a, b], new Map([[b, 30]]), new Map());
    const whole = withAngle(made, a, 1);
    expect(Object.keys(whole.project.clips)).toEqual([a]);
    expect(whole.project.clips[a]).toMatchObject({ sourceUri: 'b.mp4', sourceOffsetFrames: 50 });
    expect(withAngle(made, a, 0, 100).project).toBe(made);
  });

  it('shows a camera that had not started yet from its first frame', () => {
    const { project, a, b } = twoCameras();
    const { project: made } = withMulticam(project, [a, b], new Map([[b, -500]]), new Map());
    expect(withAngle(made, a, 1).project.clips[a].sourceOffsetFrames).toBe(0);
  });

  it('finds the one under the playhead', () => {
    const { project, a, b } = twoCameras();
    const { project: made } = withMulticam(project, [a, b], new Map(), new Map());
    expect(multicamAt(made, 100)?.id).toBe(a);
    expect(multicamAt(made, 5)).toBeUndefined();
  });

  it('follows its cameras’ files when a project is reopened', () => {
    const { project, a, b } = twoCameras();
    const { project: made } = withMulticam(project, [a, b], new Map(), new Map());
    const reopened = remapClipSources(made, new Map([['a.mp4', 'a2.mp4'], ['b.mp4', 'b2.mp4']]));
    expect(reopened.clips[a].sourceUri).toBe('a2.mp4');
    expect(reopened.clips[a].multicam?.angles.map((angle) => angle.sourceUri)).toEqual(['a2.mp4', 'b2.mp4']);
  });
});
