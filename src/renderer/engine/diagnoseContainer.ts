import type { ByteReader } from './mp4';
import { fileSize, rangeReader } from './rangeFetch';

/**
 * Why a file would not open.
 *
 * "The browser could not decode this file" is true of an unsupported codec, a
 * file that is not video at all, and a file that simply stops halfway - and it
 * sends the user looking in the wrong place. An MP4 that was cut off before it
 * finished being written has video data but no `moov`, the index every player
 * needs; that is a fact about the bytes on disk, cheap to establish with a few
 * range reads, and worth saying out loud.
 */

export interface ContainerDiagnosis {
  /** The file begins with an ISO-BMFF box (MP4, M4V, MOV). */
  isIsoBmff: boolean;
  /** The movie index. Without it nothing can open the file. */
  hasMoov: boolean;
  /** Media payload, so writing had begun. */
  hasMdat: boolean;
}

const BOX_HEADER_BYTES = 16;

/** Top-level box types, in order, as far as the file actually goes. */
export async function walkTopLevelBoxes(
  read: ByteReader,
  size: number,
  maxBoxes = 128,
): Promise<string[]> {
  const types: string[] = [];
  let offset = 0;

  for (let seen = 0; seen < maxBoxes && offset + 8 <= size; seen += 1) {
    const header = await read(offset, Math.min(BOX_HEADER_BYTES, size - offset));
    if (header.byteLength < 8) break;

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const type = String.fromCharCode(...header.subarray(4, 8));
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    types.push(type);

    let boxSize = view.getUint32(0);
    if (boxSize === 1) {
      // 64-bit size, in the eight bytes after the type.
      if (header.byteLength < 16) break;
      const high = view.getUint32(8);
      const low = view.getUint32(12);
      boxSize = high * 2 ** 32 + low;
    } else if (boxSize === 0) {
      // "Runs to the end of the file" - which is also what ffmpeg writes into
      // an mdat it has not finished, so there is nothing after this to read.
      break;
    }

    if (boxSize < 8) break;
    offset += boxSize;
  }

  return types;
}

/** Read the top-level structure of a file already open as `media://`. */
export async function diagnoseContainer(url: string): Promise<ContainerDiagnosis> {
  const size = await fileSize(url);
  const read = rangeReader(url);
  const types = await walkTopLevelBoxes(read, size);

  return {
    isIsoBmff: types[0] === 'ftyp' || types[0] === 'moov' || types[0] === 'mdat',
    hasMoov: types.includes('moov'),
    hasMdat: types.includes('mdat'),
  };
}

/**
 * Turn a diagnosis into the sentence shown next to the file's name.
 *
 * Returns null when the bytes say nothing more useful than the original error,
 * so the caller keeps whatever the decoder reported.
 */
export function explainDiagnosis(diagnosis: ContainerDiagnosis): string | null {
  if (!diagnosis.isIsoBmff || diagnosis.hasMoov) return null;
  return diagnosis.hasMdat
    ? 'the file is incomplete - it holds video data but no index, so writing or copying it never finished'
    : 'the file is incomplete - its index is missing';
}

/** Best available reason a `media://` source would not open. */
export async function explainImportFailure(url: string, fallback: string): Promise<string> {
  try {
    return explainDiagnosis(await diagnoseContainer(url)) ?? fallback;
  } catch {
    return fallback;
  }
}
