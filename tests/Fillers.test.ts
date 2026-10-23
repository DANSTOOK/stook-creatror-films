import { describe, expect, it } from 'vitest';
import { createClip, createEmptyProject } from '../src/renderer/store/types';
import { fillerPlan, isFiller } from '../src/renderer/edit/fillers';

describe('filler words', () => {
  it('knows the sounds that are never words, and leaves the ones that can be', () => {
    for (const word of ['eh', 'Eh,', 'emm...', 'um', 'Uh!', 'mmm']) expect(isFiller(word)).toBe(true);
    for (const word of ['este', 'like', 'so', 'bueno', 'pues', 'hola']) expect(isFiller(word)).toBe(false);
  });

  it('finds them in the captions that follow a clip, as timeline frames, and takes them out of the text', () => {
    const project = createEmptyProject(1280, 720, 30);
    const clip = createClip({ trackId: project.tracks[0].id, name: 'talk', sourceUri: 'talk.mp4', startFrame: 0, durationFrames: 300 });
    const caption = createClip({ trackId: project.tracks[1].id, name: 'c', sourceUri: '', startFrame: 0, durationFrames: 120 });
    caption.caption = {
      text: 'Hola eh a todos, um bienvenidos.',
      words: [
        { text: 'Hola', start: 0.2, end: 0.6 },
        { text: 'eh', start: 0.7, end: 1.0 },
        { text: 'a', start: 1.1, end: 1.2 },
        { text: 'todos,', start: 1.2, end: 1.7 },
        { text: 'um', start: 1.8, end: 2.1 },
        { text: 'bienvenidos.', start: 2.2, end: 3.0 },
      ],
      link: { clipId: clip.id, sourceUri: 'talk.mp4', from: 0, to: 120, origin: 0 },
    };
    project.clips = { [clip.id]: clip, [caption.id]: caption };
    const plan = fillerPlan(project, clip.id);
    expect(plan.count).toBe(2);
    // 0.7-1.0 s and 1.8-2.1 s at 30 fps, a frame either side.
    expect(plan.ranges).toEqual([{ from: 20, to: 31 }, { from: 53, to: 64 }]);
    expect(plan.captions.get(caption.id)?.text).toBe('Hola a todos, bienvenidos.');
    expect(plan.captions.get(caption.id)?.words?.map((word) => word.text)).toEqual(['Hola', 'a', 'todos,', 'bienvenidos.']);
  });

  it('finds nothing in a clip no caption follows', () => {
    const project = createEmptyProject(1280, 720, 30);
    const clip = createClip({ trackId: project.tracks[0].id, name: 'talk', sourceUri: 'talk.mp4', startFrame: 0, durationFrames: 300 });
    project.clips = { [clip.id]: clip };
    expect(fillerPlan(project, clip.id).count).toBe(0);
  });
});
