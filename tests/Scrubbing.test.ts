import { describe, expect, it } from 'vitest';
import { GRAIN_SECONDS, planScrubGrains } from '@renderer/audio/scrubAudio';
import { createClip, createEmptyProject } from '@renderer/store/types';

/**
 * Point 5: the sound under a dragged playhead. Which clips sound, from where
 * in their file, and for how long.
 */

function setup() {
  const project = createEmptyProject();
  const [video, , audio] = project.tracks;
  const music = createClip({ trackId: audio.id, name: 'music', sourceUri: 'media://music', startFrame: 30, durationFrames: 90 });
  // Trimmed: the clip starts 2 s into its file.
  music.sourceOffsetFrames = 60;
  const film = createClip({ trackId: video.id, name: 'film', sourceUri: 'media://film', startFrame: 0, durationFrames: 300 });
  project.clips = { [music.id]: music, [film.id]: film };
  return { project, music, film, audio };
}

const everything = () => true;

describe('planScrubGrains', () => {
  it('plays every clip under the playhead, video sound included', () => {
    const { project } = setup();
    const grains = planScrubGrains(project, 45, everything);
    expect(grains.map((g) => g.sourceUri).sort()).toEqual(['media://film', 'media://music']);
  });

  it('reads the file from where the clip really is, trim included', () => {
    const { project, music } = setup();
    const grain = planScrubGrains(project, 45, everything).find((g) => g.clipId === music.id);
    // 60 frames of trim + 15 frames into the clip, at 30 fps.
    expect(grain?.offsetSeconds).toBeCloseTo(75 / 30, 6);
    expect(grain?.durationSeconds).toBeCloseTo(GRAIN_SECONDS, 6);
  });

  it('stops a grain at the end of its clip, never playing what was cut off', () => {
    const { project, music } = setup();
    // One frame before the music clip ends.
    const grain = planScrubGrains(project, 30 + 90 - 1, everything).find((g) => g.clipId === music.id);
    expect(grain?.durationSeconds).toBeCloseTo(1 / 30, 6);
    expect(planScrubGrains(project, 120, everything).some((g) => g.clipId === music.id)).toBe(false);
  });

  it('is silent where nothing is under the playhead', () => {
    const { project } = setup();
    expect(planScrubGrains(project, 400, everything)).toEqual([]);
  });

  it('respects mute and solo, like playback', () => {
    const { project, audio, film } = setup();
    audio.muted = true;
    expect(planScrubGrains(project, 45, everything).map((g) => g.clipId)).toEqual([film.id]);

    audio.muted = false;
    audio.solo = true;
    expect(planScrubGrains(project, 45, everything).map((g) => g.clipId)).not.toContain(film.id);
  });

  it('skips sources with no sound, such as stills or silent videos', () => {
    const { project, music } = setup();
    const grains = planScrubGrains(project, 45, (uri) => uri === 'media://music');
    expect(grains.map((g) => g.clipId)).toEqual([music.id]);
  });
});
