import { describe, expect, it } from 'vitest';
import type { Clip } from '@shared/types';
import { parseScenes, sceneArgs } from '../src/main/media/scenes';
import { sceneCutFrames, splitAtFrames } from '@renderer/edit/scenes';

const FPS = 30;

function clip(id: string, trackId: string, startFrame: number, durationFrames: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId,
    name: id,
    sourceUri: 'blob:x',
    startFrame,
    durationFrames,
    sourceOffsetFrames: 0,
    transform: { position: [], scale: [], rotation: [], opacity: [], anchorPoint: { x: 0.5, y: 0.5 } },
    volume: 1,
    pan: 0,
    ...extra,
  } as Clip;
}

describe('reading where ffmpeg saw the shot change', () => {
  const request = { threshold: 0.3, fromSeconds: 10, toSeconds: 20 };

  it('asks for the stretch the clip uses, on small frames, at the threshold chosen', () => {
    const args = sceneArgs('a.mp4', request).join(' ');
    expect(args).toContain('-ss 10.000 -t 10.000 -i a.mp4');
    expect(args).toContain("scale=320:-2,select='gt(scene,0.300)',showinfo");
  });

  it('turns showinfo lines into seconds of the file, in order, once each', () => {
    const stderr = [
      '[Parsed_showinfo_2 @ 0x1] n:   0 pts:  45000 pts_time:3.5 duration: 1',
      '[Parsed_showinfo_2 @ 0x1] n:   1 pts:  19500 pts_time:1.5 duration: 1',
      '[Parsed_showinfo_2 @ 0x1] n:   2 pts:  19500 pts_time:1.5 duration: 1',
    ].join('\n');
    expect(parseScenes(stderr, request)).toEqual([11.5, 13.5]);
  });
});

describe('the frames a clip is cut at', () => {
  const c = clip('v', 't', 100, 300, { sourceOffsetFrames: 60 }); // plays 2 s .. 12 s of its file

  it('puts each change of shot on its frame of the timeline', () => {
    expect(sceneCutFrames(c, [4, 8], FPS)).toEqual([160, 280]);
  });

  it('leaves out changes outside the clip or on its very ends', () => {
    expect(sceneCutFrames(c, [1, 2.01, 11.99, 13], FPS)).toEqual([]);
  });
});

describe('cutting', () => {
  it('cuts a picture and its linked sound alike, and links each piece to its partner', () => {
    const clips = {
      v: clip('v', 'video', 0, 180, { linkGroup: 'g' }),
      a: clip('a', 'audio', 0, 180, { linkGroup: 'g', audioOnly: true }),
    };
    const { clips: out, pieces } = splitAtFrames(clips, ['v', 'a'], [60, 120]);
    expect(pieces).toBe(3);
    const on = (track: string) => Object.values(out).filter((c) => c.trackId === track).sort((x, y) => x.startFrame - y.startFrame);
    const video = on('video');
    const audio = on('audio');
    expect(video.map((c) => [c.startFrame, c.durationFrames, c.sourceOffsetFrames])).toEqual([[0, 60, 0], [60, 60, 60], [120, 60, 120]]);
    expect(audio.map((c) => [c.startFrame, c.durationFrames])).toEqual([[0, 60], [60, 60], [120, 60]]);
    for (let i = 0; i < 3; i += 1) expect(video[i].linkGroup).toBe(audio[i].linkGroup);
    expect(new Set(video.map((c) => c.linkGroup)).size).toBe(3);
  });
});
