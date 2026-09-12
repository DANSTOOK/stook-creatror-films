import type { ByteReader } from './mp4';

/**
 * Reading a local media file by byte range, over `media://`.
 *
 * The MP4 readers work off byte ranges rather than whole files - that is the
 * point of them - and `media://` answers HTTP Range requests from a read
 * stream on disk. A server that ignored Range would send the whole file for
 * every read, so a non-206 answer is treated as "cannot stream this".
 */

/** A reader that fetches `length` bytes at `offset`. */
export function rangeReader(url: string): ByteReader {
  return async (offset, length) => {
    const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (response.status !== 206) throw new Error(`no range support (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/** The file's size, from the Content-Range of a one-byte request. */
export async function fileSize(url: string): Promise<number> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  await response.arrayBuffer();
  const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
  if (response.status !== 206 || !total) throw new Error('no range support');
  return Number(total[1]);
}
