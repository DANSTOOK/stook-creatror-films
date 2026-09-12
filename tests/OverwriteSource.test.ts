import { describe, expect, it } from 'vitest';
import { EncoderPipeline } from '@main/exporter/EncoderPipeline';
import type { ExportSettings } from '@shared/types';
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';
import { walkTopLevelBoxes, explainDiagnosis } from '@renderer/engine/diagnoseContainer';
import type { ByteReader } from '@renderer/engine/mp4';

/**
 * The bug that ate two of the user's recordings.
 *
 * The export name defaults to the first video's name and the folder is
 * whichever the user last picked - so "export" resolved onto the footage
 * itself, ffmpeg opened it with `-y`, and cancelling left an MP4 holding video
 * data and no index. The user saw only the aftermath: "no me deja importar los
 * mp4". Both files were ours, identifiable by ffmpeg's own brand set, a
 * zero-length `mdat`, and `Lavc` in the bitstream.
 *
 * Three things had to change, and each is pinned here: the encode no longer
 * writes to the destination, a destination that is open footage is refused, and
 * a file with no index says so instead of blaming the decoder.
 */

const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  outputPath: 'C:\\Users\\me\\Downloads\\holiday.mp4',
  endFrame: 100,
  ...overrides,
});

describe('an export in progress never holds the destination open', () => {
  it('hands ffmpeg a sidecar, not the file the user chose', () => {
    const chosen = settings();
    const partial = EncoderPipeline.partialPathFor(chosen.outputPath);
    const args = EncoderPipeline.buildArgs(chosen, partial);

    expect(args.at(-1)).toBe(partial);
    expect(args).not.toContain(chosen.outputPath);
  });

  it('keeps the extension, so ffmpeg still picks the right muxer', () => {
    expect(EncoderPipeline.partialPathFor('a\\b\\clip.mp4').endsWith('.mp4')).toBe(true);
    expect(EncoderPipeline.partialPathFor('a\\b\\clip.mov').endsWith('.mov')).toBe(true);
    expect(EncoderPipeline.partialPathFor('a\\b\\clip.webm').endsWith('.webm')).toBe(true);
  });

  it('puts the sidecar beside the destination, so publishing is a rename', () => {
    const partial = EncoderPipeline.partialPathFor('C:\\Users\\me\\Downloads\\holiday.mp4');
    expect(partial.startsWith('C:\\Users\\me\\Downloads\\')).toBe(true);
    expect(partial).not.toBe('C:\\Users\\me\\Downloads\\holiday.mp4');
  });

  it('still writes a PNG sequence into the chosen folder', () => {
    const args = EncoderPipeline.buildArgs(settings({ format: 'png-sequence' }));
    expect(args.at(-1)).toContain('frame_%05d.png');
  });
});

/* -------------------------------------------------------------------------- */
/* Recognising what a killed export left behind                               */
/* -------------------------------------------------------------------------- */

/** A reader over bytes held in memory, the way `media://` would serve them. */
const readerFor = (bytes: Uint8Array): ByteReader => async (offset, length) =>
  bytes.subarray(offset, offset + length);

function box(type: string, payloadBytes: number, size = 8 + payloadBytes): Uint8Array {
  const bytes = new Uint8Array(8 + payloadBytes);
  new DataView(bytes.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  return bytes;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

describe('reading the top-level structure of a file that will not open', () => {
  it('lists the boxes of a complete file', async () => {
    const bytes = concat(box('ftyp', 24), box('mdat', 512), box('moov', 300));
    expect(await walkTopLevelBoxes(readerFor(bytes), bytes.byteLength)).toEqual([
      'ftyp',
      'mdat',
      'moov',
    ]);
  });

  it('stops at the zero-length mdat a killed ffmpeg leaves', async () => {
    // Exactly the shape of both damaged files: ftyp, an empty free, then an
    // mdat whose size was never patched in - and nothing after it.
    const bytes = concat(box('ftyp', 24), box('free', 0), box('mdat', 4096, 0));
    const types = await walkTopLevelBoxes(readerFor(bytes), bytes.byteLength);
    expect(types).toEqual(['ftyp', 'free', 'mdat']);
    expect(types).not.toContain('moov');
  });

  it('does not loop forever on a box that claims to be smaller than its header', async () => {
    const bytes = concat(box('ftyp', 0, 4), box('moov', 64));
    await expect(walkTopLevelBoxes(readerFor(bytes), bytes.byteLength)).resolves.toEqual(['ftyp']);
  });

  it('gives up on bytes that are not boxes at all', async () => {
    const bytes = new Uint8Array(64).fill(0xff);
    expect(await walkTopLevelBoxes(readerFor(bytes), bytes.byteLength)).toEqual([]);
  });
});

describe('what the user is told', () => {
  it('says the file is incomplete when there is data but no index', () => {
    const reason = explainDiagnosis({ isIsoBmff: true, hasMoov: false, hasMdat: true });
    expect(reason).toMatch(/incomplete/i);
    expect(reason).toMatch(/never finished/i);
  });

  it('says nothing extra about a file whose index is present', () => {
    // Then the problem is the codec or the content, and the decoder's own
    // message is the better one.
    expect(explainDiagnosis({ isIsoBmff: true, hasMoov: true, hasMdat: true })).toBeNull();
  });

  it('says nothing extra about a file that is not MP4 at all', () => {
    expect(explainDiagnosis({ isIsoBmff: false, hasMoov: false, hasMdat: false })).toBeNull();
  });
});
