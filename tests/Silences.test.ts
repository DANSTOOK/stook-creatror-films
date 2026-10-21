import { describe, expect, it } from 'vitest';
import type { Clip } from '@shared/types';
import { parseSilences, silenceArgs } from '../src/main/media/silence';
import { removeRanges, silenceRanges } from '@renderer/edit/silences';

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

describe('reading where ffmpeg heard silence', () => {
  const request = { noiseDb: -38, minSeconds: 0.5, fromSeconds: 10, toSeconds: 20 };

  it('asks for the stretch the clip uses, at the level and length chosen', () => {
    const args = silenceArgs('a.mp4', request);
    expect(args.join(' ')).toContain('-ss 10.000 -t 10.000 -i a.mp4');
    expect(args).toContain('silencedetect=noise=-38dB:d=0.5');
  });

  it('turns its lines into seconds of the file, and a silence running to the end lasts to the end', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 1.25',
      '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1.25',
      'size=N/A time=00:00:05.00',
      '[silencedetect @ 0x1] silence_start: 8.75',
    ].join('\n');
    expect(parseSilences(stderr, request)).toEqual([
      { start: 11.25, end: 12.5 },
      { start: 18.75, end: 20 },
    ]);
  });

  it('finds nothing in a file with no sound', () => {
    expect(parseSilences('', request)).toEqual([]);
  });
});

describe('the frames a silence takes out of a clip', () => {
  const c = clip('v', 't1', 100, 300, { sourceOffsetFrames: 60 }); // plays 2 s .. 12 s of its file

  it('keeps a little either side, so words are not clipped', () => {
    // A silence 4 s .. 6 s of the file: frames 160 .. 220 of the timeline, less 0.1 s each side.
    expect(silenceRanges(c, [{ start: 4, end: 6 }], FPS, 0.1)).toEqual([{ from: 163, to: 217 }]);
  });

  it('takes a silence at the clip\'s own start or end entirely', () => {
    expect(silenceRanges(c, [{ start: 1, end: 3 }, { start: 11, end: 13 }], FPS, 0.1)).toEqual([
      { from: 100, to: 127 },
      { from: 373, to: 400 },
    ]);
  });

  it('ignores a pause too short to cut once the margins are kept', () => {
    expect(silenceRanges(c, [{ start: 5, end: 5.2 }], FPS, 0.1)).toEqual([]);
  });
});

describe('cutting them out', () => {
  it('cuts a linked picture and sound alike, keeps them linked and in sync, and closes up what follows', () => {
    const clips: Record<string, Clip> = {
      v: clip('v', 'video', 0, 300, { linkGroup: 'g' }),
      a: clip('a', 'audio', 0, 300, { linkGroup: 'g', audioOnly: true }),
      after: clip('after', 'video', 300, 60),
      other: clip('other', 'music', 0, 600),
    };
    const { clips: out, removed } = removeRanges(clips, ['v', 'a'], [
      { from: 50, to: 80 },
      { from: 200, to: 230 },
    ]);
    expect(removed).toBe(60);
    const onTrack = (track: string) => Object.values(out).filter((c) => c.trackId === track).sort((x, y) => x.startFrame - y.startFrame);
    const video = onTrack('video');
    const audio = onTrack('audio');
    // Three pieces of the clip, end to end, then what came after, closed up.
    expect(video.map((c) => [c.startFrame, c.durationFrames, c.sourceOffsetFrames])).toEqual([
      [0, 50, 0],
      [50, 120, 80],
      [170, 70, 230],
      [240, 60, 0],
    ]);
    expect(audio.map((c) => [c.startFrame, c.durationFrames, c.sourceOffsetFrames])).toEqual([
      [0, 50, 0],
      [50, 120, 80],
      [170, 70, 230],
    ]);
    // Each picture piece linked to the sound piece beside it, and to no other.
    for (let i = 0; i < 3; i += 1) {
      expect(video[i].linkGroup).toBeTruthy();
      expect(video[i].linkGroup).toBe(audio[i].linkGroup);
    }
    expect(new Set(video.slice(0, 3).map((c) => c.linkGroup)).size).toBe(3);
    // A track with nothing of the clip on it is left alone.
    expect(out.other.startFrame).toBe(0);
    expect(out.other.durationFrames).toBe(600);
  });

  it('a range over a whole clip takes it out', () => {
    const clips = { v: clip('v', 'video', 0, 30) };
    const { clips: out } = removeRanges(clips, ['v'], [{ from: 0, to: 30 }]);
    expect(Object.keys(out)).toEqual([]);
  });
});
