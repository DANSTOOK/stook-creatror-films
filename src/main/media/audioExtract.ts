import { extname } from 'node:path';

const ISO_BMFF_EXTENSIONS = new Set(['.mp4', '.m4v', '.m4a', '.mov', '.3gp', '.3g2']);

/**
 * Input options that keep an ffmpeg read of `source` on the source's own clock.
 *
 * ffmpeg moves a whole file back by its start time unless told not to. That
 * start is zero for almost every file, but not for an MP4 whose tracks ALL
 * start late, each behind an empty edit. Chromium's <video> and the app's own
 * MP4 reader present such a picture at its stored time, so anything ffmpeg
 * reads of the sound has to stay at its stored time too; moved back, it came
 * out early by the picture's delay. For every other test file the result is
 * byte-identical with and without it.
 *
 * Only for ISO BMFF (MP4, MOV, M4A...): an MPEG-TS clock starts anywhere, and
 * nothing in the page reads those timestamps raw.
 */
export function sourceClockArgs(source: string): string[] {
  return ISO_BMFF_EXTENSIONS.has(extname(source).toLowerCase()) ? ['-copyts'] : [];
}

/**
 * ffmpeg's arguments for pulling the audio track out of a source.
 *
 * The extracted file is what every sound path of the page reads - playback,
 * scrubbing, the export mix - while the picture is read from the source
 * itself, so the extraction must not move the sound against it
 * (sourceClockArgs).
 *
 * `use_metadata_tags` lets an iTunes `iTunSMPB` encoder delay survive the
 * copy. A stream copy keeps the priming samples but drops the tag that says
 * to discard them; written as a keyed tag, the page's MP4 reader still can
 * (mp4.ts).
 */
export function audioExtractArgs(source: string, target: string, codec: readonly string[]): string[] {
  return [
    '-v', 'error', '-y',
    ...sourceClockArgs(source),
    '-i', source,
    '-vn', '-map', '0:a:0',
    ...codec,
    '-movflags', '+use_metadata_tags',
    target,
  ];
}
