import { open } from 'node:fs/promises';

/**
 * Subtitle tracks of an MP4 or MOV left switched off.
 *
 * The export asks ffmpeg for its timed-text tracks with no default
 * disposition, so a file that also has the captions burnt in does not show
 * them twice. ffmpeg's MOV/MP4 muxer overrides that: when no track of a kind
 * is marked default it enables the first one anyway, and has no option to
 * leave it be. A track's "enabled" is one bit of its track header (`tkhd`),
 * so once the file is written that bit is cleared on every subtitle track -
 * three bytes rewritten in place, nothing else moved or re-encoded.
 */

/** Handler types of timed text: `sbtl` in an MP4, `text` in a MOV, `subt` in either. */
const SUBTITLE_HANDLERS = new Set(['sbtl', 'text', 'subt']);
const TRACK_ENABLED = 0x000001;

interface Box {
  type: string;
  /** Offset of the box's first byte. */
  start: number;
  /** Offset of its payload. */
  body: number;
  end: number;
}

/** The boxes laid end to end in `buffer` between `from` and `to`. */
export function childBoxes(buffer: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(buffer.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    boxes.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

/**
 * Where, inside a `moov` box's bytes, the flags of each subtitle track's
 * header are, and what they should become: offsets of the three flag bytes.
 */
export function subtitleTrackFlags(moov: Buffer): { offset: number; flags: number }[] {
  const found: { offset: number; flags: number }[] = [];
  for (const trak of childBoxes(moov, 0, moov.length).filter((box) => box.type === 'trak')) {
    const parts = childBoxes(moov, trak.body, trak.end);
    const tkhd = parts.find((box) => box.type === 'tkhd');
    const mdia = parts.find((box) => box.type === 'mdia');
    const hdlr = mdia ? childBoxes(moov, mdia.body, mdia.end).find((box) => box.type === 'hdlr') : undefined;
    if (!tkhd || !hdlr || hdlr.body + 12 > hdlr.end || tkhd.body + 4 > tkhd.end) continue;
    // A full box: version and flags, then pre_defined, then the handler type.
    const handler = moov.toString('latin1', hdlr.body + 8, hdlr.body + 12);
    if (!SUBTITLE_HANDLERS.has(handler)) continue;
    const flags = moov.readUIntBE(tkhd.body + 1, 3);
    if (flags & TRACK_ENABLED) found.push({ offset: tkhd.body + 1, flags: flags & ~TRACK_ENABLED });
  }
  return found;
}

/** Clear "enabled" on every subtitle track of the MP4 or MOV at `path`. Returns how many it switched off. */
export async function switchOffSubtitleTracks(path: string): Promise<number> {
  const file = await open(path, 'r+');
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(16);
    let at = 0;
    while (at + 8 <= size) {
      await file.read(header, 0, 16, at);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - at;
      if (boxSize < 8 || at + boxSize > size) return 0;
      if (type === 'moov') {
        const moov = Buffer.alloc(boxSize);
        await file.read(moov, 0, boxSize, at);
        const body = childBoxes(moov, 0, boxSize)[0]?.body ?? 8;
        const tracks = subtitleTrackFlags(moov.subarray(body));
        for (const track of tracks) {
          const bytes = Buffer.alloc(3);
          bytes.writeUIntBE(track.flags, 0, 3);
          await file.write(bytes, 0, 3, at + body + track.offset);
        }
        return tracks.length;
      }
      at += boxSize;
    }
    return 0;
  } finally {
    await file.close();
  }
}
