import { describe, expect, it } from 'vitest';
import type { ExportSettings, ProjectState, Track } from '@shared/types';
import { captionTracksToDeliver, createCaptionClip, sidecarTags } from '@renderer/captions/captionClips';
import { withoutCaptions } from '@renderer/captions/captionRender';
import { createTrack } from '@renderer/store/types';
import { EncoderPipeline } from '@main/exporter/EncoderPipeline';
import { subtitleCodecFor, subtitleLanguageCode } from '@shared/utils/subtitleStream';
import { contrastOf } from '@shared/utils/contrast';
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';
import { CAPTION_WARNING, TRACK_TYPE_COLORS } from '@renderer/components/Timeline/TimelineCanvas';

/**
 * Captions inside the exported file, as a track the viewer switches on: the
 * ffmpeg arguments. That the file really carries the stream is checked with
 * ffmpeg itself in tests/ui/captions-f2.mjs.
 */

const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  outputPath: '/tmp/out.mp4',
  startFrame: 0,
  endFrame: 60,
  ...overrides,
});

const subtitles = { path: '/tmp/captions.srt', language: 'spa' as const };
const argOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const maps = (args: string[]): string[] => args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : []));
const inputs = (args: string[]): string[] => args.flatMap((arg, index) => (arg === '-i' ? [args[index + 1]] : []));

describe('a subtitle track inside the export', () => {
  it('which containers take one, and as what', () => {
    expect(subtitleCodecFor('mp4-h264')).toBe('mov_text');
    expect(subtitleCodecFor('mp4-h265')).toBe('mov_text');
    expect(subtitleCodecFor('prores4444')).toBe('mov_text');
    expect(subtitleCodecFor('webm-vp9')).toBe('webvtt');
    expect(subtitleCodecFor('png-sequence')).toBeNull();
    expect(subtitleLanguageCode('es')).toBe('spa');
    expect(subtitleLanguageCode('en')).toBe('eng');
  });

  it('with sound: the .srt is the third input, mapped after picture and sound, as mov_text with its language', () => {
    for (const pipeMode of ['annexb-h264', 'rawvideo'] as const) {
      const args = EncoderPipeline.buildArgs(settings({ pipeMode, audioPath: '/tmp/mix.wav', subtitles }));
      expect(inputs(args)).toEqual(['pipe:0', '/tmp/mix.wav', '/tmp/captions.srt']);
      expect(maps(args)).toEqual(['0:v:0', '1:a:0', '2:0']);
      expect(argOf(args, '-c:s')).toBe('mov_text');
      expect(argOf(args, '-metadata:s:s:0')).toBe('language=spa');
      // Off until the viewer switches it on: burnt-in captions are not doubled unasked.
      expect(argOf(args, '-disposition:s:0')).toBe('0');
      expect(argOf(args, '-c:a')).toBe('aac');
      // Every input comes before the first output option: an -i after one would take it for its own.
      expect(args.lastIndexOf('-i')).toBeLessThan(args.indexOf('-map'));
    }
  });

  it('without sound: the second input, and the picture still mapped', () => {
    const args = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264', subtitles: { ...subtitles, language: 'eng' } }));
    expect(inputs(args)).toEqual(['pipe:0', '/tmp/captions.srt']);
    expect(maps(args)).toEqual(['0:v:0', '1:0']);
    expect(argOf(args, '-metadata:s:s:0')).toBe('language=eng');
    expect(args).not.toContain('-c:a');
  });

  it('WebM takes WebVTT; a PNG sequence takes nothing, and is not handed the file', () => {
    const webm = EncoderPipeline.buildArgs(settings({ format: 'webm-vp9', outputPath: '/tmp/out.webm', pipeMode: 'rawvideo', subtitles }));
    expect(argOf(webm, '-c:s')).toBe('webvtt');
    const png = EncoderPipeline.buildArgs(settings({ format: 'png-sequence', outputPath: '/tmp/frames', pipeMode: 'rawvideo', subtitles }));
    expect(png).not.toContain('/tmp/captions.srt');
    expect(png).not.toContain('-c:s');
  });

  it('without subtitles the arguments are exactly what they were', () => {
    const before = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264', audioPath: '/tmp/mix.wav' }));
    expect(maps(before)).toEqual(['0:v:0', '1:a:0']);
    expect(before).not.toContain('-c:s');
    expect(EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264' }))).not.toContain('-map');
  });

  it('several tracks: one input and one stream each, in order, each with its language and its name', () => {
    const subtitleStreams = [
      { path: '/tmp/es.srt', language: 'spa' as const, title: 'Subtítulos 1' },
      { path: '/tmp/en.srt', language: 'eng' as const, title: 'English' },
    ];
    const args = EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264', audioPath: '/tmp/mix.wav', subtitleStreams }));
    expect(inputs(args)).toEqual(['pipe:0', '/tmp/mix.wav', '/tmp/es.srt', '/tmp/en.srt']);
    expect(maps(args)).toEqual(['0:v:0', '1:a:0', '2:0', '3:0']);
    expect(argOf(args, '-c:s')).toBe('mov_text');
    const pairs = args.flatMap((arg, index) => (arg.startsWith('-metadata:s:s:') || arg.startsWith('-disposition:s:') ? [`${arg} ${args[index + 1]}`] : []));
    expect(pairs).toEqual([
      '-metadata:s:s:0 language=spa',
      '-metadata:s:s:0 title=Subtítulos 1',
      '-disposition:s:0 0',
      '-metadata:s:s:1 language=eng',
      '-metadata:s:s:1 title=English',
      '-disposition:s:1 0',
    ]);
    expect(args.lastIndexOf('-i')).toBeLessThan(args.indexOf('-map'));
    // Without sound, the first subtitle is the second input.
    expect(maps(EncoderPipeline.buildArgs(settings({ pipeMode: 'annexb-h264', subtitleStreams })))).toEqual(['0:v:0', '1:0', '2:0']);
  });

  it('the cover-art pass copies every stream, the subtitle track with them', () => {
    const args = EncoderPipeline.coverArtArgs('in.mp4', 'thumb.png', 'out.mp4');
    expect(maps(args)[0]).toBe('0');
    expect(argOf(args, '-c')).toBe('copy');
  });
});

describe('several captions tracks out of one export', () => {
  const track = (id: string, order: number, language: 'es' | 'en', visible = true): Track => ({ ...createTrack('captions', order, id), id, visible, captions: { preset: 'classic', language } });
  const project = (): ProjectState =>
    ({
      fps: 30,
      width: 1920,
      height: 1080,
      tracks: [track('es1', 3, 'es'), track('en1', 4, 'en', false), track('es2', 2, 'es'), track('empty', 5, 'en')],
      clips: Object.fromEntries(
        [createCaptionClip('es1', 0, 30, 'Hola'), createCaptionClip('en1', 0, 30, 'Hello'), createCaptionClip('en1', 40, 60, 'again'), createCaptionClip('es2', 0, 30, 'Otra')].map((clip) => [clip.id, clip]),
      ),
    }) as unknown as ProjectState;

  it('delivers the tracks that have captions, top first, hidden ones too', () => {
    expect(captionTracksToDeliver(project())).toEqual([
      { id: 'en1', name: 'en1', language: 'en', visible: false, count: 2 },
      { id: 'es1', name: 'es1', language: 'es', visible: true, count: 1 },
      { id: 'es2', name: 'es2', language: 'es', visible: true, count: 1 },
    ]);
  });

  it('names each file with its language, numbering a second in the same one', () => {
    expect([...sidecarTags(captionTracksToDeliver(project()))]).toEqual([
      ['en1', 'en'],
      ['es1', 'es'],
      ['es2', 'es-2'],
    ]);
  });

  it('burns in only the tracks asked for', () => {
    const drawn = withoutCaptions(project(), new Set(['es2']));
    expect(drawn.tracks.filter((candidate) => candidate.visible).map((candidate) => candidate.id)).toEqual(['es2']);
    expect(withoutCaptions(project()).tracks.every((candidate) => !candidate.visible)).toBe(true);
  });
});

describe('the warning corner on a caption', () => {
  it('stands out from the captions colour (3:1 for a graphic)', () => {
    expect(contrastOf(CAPTION_WARNING, TRACK_TYPE_COLORS.captions)).toBeGreaterThanOrEqual(3);
  });
});
