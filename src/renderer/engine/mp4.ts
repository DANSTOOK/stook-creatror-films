/**
 * Minimal MP4 / MOV (ISO BMFF) sample-table reader.
 *
 * WebCodecs decodes but does not demux: to feed a `VideoDecoder` the encoded
 * samples of a file, something has to read the container. This reads exactly
 * what that needs from the first video track - codec string and decoder
 * description, and per sample its byte range, decode and presentation times,
 * and whether it is a sync (key) sample - and nothing else.
 *
 * It exists because export used to seek an HTMLVideoElement once per frame,
 * and each seek re-decodes from the previous keyframe: ~50 ms a frame, so a
 * short video exported at 10-17 fps with the GPU idle. Decoding in order, the
 * way the file is laid out, is a different order of magnitude.
 *
 * Pure (bytes in, tables out), so it is unit tested against files ffmpeg makes.
 */

export interface Mp4Sample {
  offset: number;
  size: number;
  /** Presentation time, in seconds, with the edit list applied. */
  time: number;
  /** Seconds this sample is shown for. */
  duration: number;
  /** Decode time, in the track timescale. Samples are stored in this order. */
  dts: number;
  isSync: boolean;
}

export interface Mp4VideoTrack {
  /** WebCodecs codec string, e.g. "avc1.640028". */
  codec: string;
  /** avcC / hvcC payload - the `description` a VideoDecoder needs. */
  description: Uint8Array;
  width: number;
  height: number;
  timescale: number;
  /** In decode order, as stored. */
  samples: Mp4Sample[];
}

/** Read `length` bytes at `offset` - backed by a Range fetch in the app. */
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

interface Box {
  type: string;
  /** Offset of the box payload inside the buffer being walked. */
  start: number;
  end: number;
}

const fourCC = (view: DataView, at: number): string =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function readUint64(view: DataView, at: number): number {
  return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
}

/** The boxes directly inside `[start, end)`. */
function childBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = fourCC(view, at + 4);
    let header = 8;
    if (size === 1) {
      size = readUint64(view, at + 8);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    boxes.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

const child = (view: DataView, box: Box, type: string): Box | undefined =>
  childBoxes(view, box.start, box.end).find((candidate) => candidate.type === type);

function path(view: DataView, box: Box, ...types: string[]): Box | undefined {
  let current: Box | undefined = box;
  for (const type of types) {
    if (!current) return undefined;
    current = child(view, current, type);
  }
  return current;
}

const hex2 = (value: number): string => value.toString(16).padStart(2, '0');

/** "avc1.PPCCLL" from an avcC record. */
function avcCodec(sampleType: string, avcC: Uint8Array): string {
  return `${sampleType}.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`.toLowerCase();
}

/**
 * "hvc1.1.6.L93.B0"-style string from an hvcC record (ISO/IEC 14496-15 E.3).
 */
function hevcCodec(sampleType: string, hvcC: Uint8Array): string {
  const view = new DataView(hvcC.buffer, hvcC.byteOffset, hvcC.byteLength);
  const byte1 = hvcC[1];
  const profileSpace = ['', 'A', 'B', 'C'][byte1 >> 6];
  const tier = (byte1 >> 5) & 1 ? 'H' : 'L';
  const profile = byte1 & 0x1f;

  // The compatibility flags are written bit-reversed.
  const flags = view.getUint32(2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit += 1) if (flags & (1 << bit)) reversed |= 1 << (31 - bit);
  const compat = (reversed >>> 0).toString(16).toUpperCase();

  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = hvcC[12];

  return [
    sampleType,
    `${profileSpace}${profile}`,
    compat,
    `${tier}${level}`,
    ...constraints.map((value) => value.toString(16).toUpperCase()),
  ].join('.');
}

/**
 * Parse the sample table of the first video track in a `moov` payload.
 *
 * `moov` is the box's full bytes (header included). Returns null for a file
 * this reader does not handle - no video track, a codec other than H.264 /
 * HEVC - so the caller can fall back to seeking.
 */
export function parseMoov(moov: Uint8Array): Mp4VideoTrack | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const [root] = childBoxes(view, 0, moov.byteLength);
  if (!root || root.type !== 'moov') return null;

  for (const trak of childBoxes(view, root.start, root.end).filter((box) => box.type === 'trak')) {
    const hdlr = path(view, trak, 'mdia', 'hdlr');
    if (!hdlr || fourCC(view, hdlr.start + 8) !== 'vide') continue;

    const mdhd = path(view, trak, 'mdia', 'mdhd');
    const stbl = path(view, trak, 'mdia', 'minf', 'stbl');
    if (!mdhd || !stbl) return null;

    const timescale = view.getUint8(mdhd.start) === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12);

    // stsd: the first sample entry names the codec and holds its config box.
    const stsd = child(view, stbl, 'stsd');
    if (!stsd) return null;
    const [entry] = childBoxes(view, stsd.start + 8, stsd.end);
    if (!entry || !['avc1', 'avc3', 'hvc1', 'hev1'].includes(entry.type)) return null;
    const width = view.getUint16(entry.start + 24);
    const height = view.getUint16(entry.start + 26);
    // 78 bytes of VisualSampleEntry fields come before the child boxes.
    const configType = entry.type.startsWith('avc') ? 'avcC' : 'hvcC';
    const config = childBoxes(view, entry.start + 78, entry.end).find((box) => box.type === configType);
    if (!config) return null;
    const description = moov.slice(config.start, config.end);
    const codec = configType === 'avcC' ? avcCodec(entry.type, description) : hevcCodec(entry.type, description);

    // stts: decode-time deltas.
    const stts = child(view, stbl, 'stts');
    const stsz = child(view, stbl, 'stsz');
    const stsc = child(view, stbl, 'stsc');
    const stco = child(view, stbl, 'stco') ?? child(view, stbl, 'co64');
    if (!stts || !stsz || !stsc || !stco) return null;

    const sampleSize = view.getUint32(stsz.start + 4);
    const count = view.getUint32(stsz.start + 8);
    const sizes = new Array<number>(count);
    for (let i = 0; i < count; i += 1) {
      sizes[i] = sampleSize !== 0 ? sampleSize : view.getUint32(stsz.start + 12 + i * 4);
    }

    const dts = new Array<number>(count);
    const deltas = new Array<number>(count);
    {
      let at = stts.start + 8;
      let index = 0;
      let time = 0;
      for (let e = view.getUint32(stts.start + 4); e > 0 && index < count; e -= 1, at += 8) {
        const run = view.getUint32(at);
        const delta = view.getUint32(at + 4);
        for (let r = 0; r < run && index < count; r += 1, index += 1) {
          dts[index] = time;
          deltas[index] = delta;
          time += delta;
        }
      }
    }

    // ctts: composition offsets (B-frames). Signed in version 1.
    const ctts = child(view, stbl, 'ctts');
    const offsets = new Array<number>(count).fill(0);
    if (ctts) {
      const signed = view.getUint8(ctts.start) === 1;
      let at = ctts.start + 8;
      let index = 0;
      for (let e = view.getUint32(ctts.start + 4); e > 0 && index < count; e -= 1, at += 8) {
        const run = view.getUint32(at);
        const offset = signed ? view.getInt32(at + 4) : view.getUint32(at + 4);
        for (let r = 0; r < run && index < count; r += 1, index += 1) offsets[index] = offset;
      }
    }

    // stss: sync samples. Absent means every sample is a keyframe.
    const stss = child(view, stbl, 'stss');
    const sync = new Array<boolean>(count).fill(!stss);
    if (stss) {
      for (let e = 0, n = view.getUint32(stss.start + 4); e < n; e += 1) {
        const sample = view.getUint32(stss.start + 8 + e * 4) - 1;
        if (sample >= 0 && sample < count) sync[sample] = true;
      }
    }

    // Chunk offsets and the sample-to-chunk runs give each sample's offset.
    const chunkCount = view.getUint32(stco.start + 4);
    const chunkOffsets = new Array<number>(chunkCount);
    for (let c = 0; c < chunkCount; c += 1) {
      chunkOffsets[c] =
        stco.type === 'co64' ? readUint64(view, stco.start + 8 + c * 8) : view.getUint32(stco.start + 8 + c * 4);
    }
    const runs: { firstChunk: number; perChunk: number }[] = [];
    for (let e = 0, n = view.getUint32(stsc.start + 4); e < n; e += 1) {
      const at = stsc.start + 8 + e * 12;
      runs.push({ firstChunk: view.getUint32(at) - 1, perChunk: view.getUint32(at + 4) });
    }
    const sampleOffsets = new Array<number>(count);
    {
      let index = 0;
      for (let r = 0; r < runs.length; r += 1) {
        const lastChunk = r + 1 < runs.length ? runs[r + 1].firstChunk : chunkCount;
        for (let c = runs[r].firstChunk; c < lastChunk && index < count; c += 1) {
          let at = chunkOffsets[c];
          for (let s = 0; s < runs[r].perChunk && index < count; s += 1, index += 1) {
            sampleOffsets[index] = at;
            at += sizes[index];
          }
        }
      }
    }

    // Edit list: the presentation starts at media_time, not at zero. ffmpeg
    // writes one whenever B-frames shift composition times.
    let mediaStart = 0;
    const elst = path(view, trak, 'edts', 'elst');
    if (elst) {
      const version = view.getUint8(elst.start);
      const entries = view.getUint32(elst.start + 4);
      for (let e = 0; e < entries; e += 1) {
        const at = elst.start + 8 + e * (version === 1 ? 20 : 12);
        const mediaTime = version === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
        if (mediaTime >= 0) {
          mediaStart = mediaTime;
          break;
        }
      }
    }

    const samples: Mp4Sample[] = new Array(count);
    for (let i = 0; i < count; i += 1) {
      samples[i] = {
        offset: sampleOffsets[i],
        size: sizes[i],
        dts: dts[i],
        time: (dts[i] + offsets[i] - mediaStart) / timescale,
        duration: deltas[i] / timescale,
        isSync: sync[i],
      };
    }

    return { codec, description, width, height, timescale, samples };
  }

  return null;
}

/**
 * Find and read the `moov` box of a file through a byte reader, walking the
 * top-level boxes by their headers. `moov` is often at the END of a camera or
 * phone recording, so nothing assumes it comes first; only headers and the
 * moov itself are read, never the media data.
 */
export async function readMoov(read: ByteReader, fileSize: number): Promise<Uint8Array | null> {
  let at = 0;
  while (at + 8 <= fileSize) {
    const header = await read(at, 16);
    if (header.byteLength < 8) return null;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0);
    const type = fourCC(view, 4);
    if (size === 1) size = readUint64(view, 8);
    else if (size === 0) size = fileSize - at;
    if (size < 8) return null;

    if (type === 'moov') return read(at, size);
    at += size;
  }
  return null;
}
