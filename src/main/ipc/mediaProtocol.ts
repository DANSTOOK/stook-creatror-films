import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';

/**
 * `media://` - local media streamed from disk, a byte range at a time.
 *
 * Importing used to read the whole file into memory, send it across IPC and
 * wrap it in a Blob. Measured with a 45-minute 1.9 GB recording: the main
 * process and the page each grew to ~6 GB during the import and settled at
 * ~2 GB and ~1.2 GB - for ONE clip. Real footage is 40-50 minutes, often 4K,
 * often several files; that path does not survive it.
 *
 * Here a `<video>` element asks for the bytes it needs, when it needs them,
 * with HTTP Range requests, the same way it would stream from a server. The
 * file never has to fit in memory.
 *
 * The page never sees a path. Each allowlisted file gets an opaque random
 * token, `media://file/<token>`, and only registered tokens resolve - so this
 * cannot be used to read anything the user did not open.
 */

export const MEDIA_SCHEME = 'media';

/** Must run before `app.ready`: privileges are fixed at startup. */
export function registerMediaSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        // `<video>` and `<audio>` expect streamed responses from a protocol
        // unless told otherwise; this is the flag that tells them.
        stream: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

const tokens = new Map<string, string>();
const tokensByPath = new Map<string, string>();

/** The `media://` URL for an allowlisted path, stable for the session. */
export function mediaUrlFor(path: string): string {
  let token = tokensByPath.get(path);
  if (!token) {
    token = randomUUID();
    tokens.set(token, path);
    tokensByPath.set(path, token);
  }
  return `${MEDIA_SCHEME}://file/${token}`;
}

/**
 * True when this path is already open in the page as source media.
 *
 * An export writes with `-y`, and the export name defaults to the first
 * video's name: choose the folder the footage came from and the destination
 * resolves onto the footage itself. Cancel that export and the source is a
 * headless MP4 - video data, no index, unopenable. It happened to two of the
 * user's files before anything stopped it, so the export path asks here first.
 *
 * Compared case-insensitively on Windows, where the two spellings are one file.
 */
export function isOpenMediaPath(path: string): boolean {
  const key = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const wanted = key(resolve(path));
  for (const known of tokensByPath.keys()) {
    if (key(resolve(known)) === wanted) return true;
  }
  return false;
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * Parse a single-range `Range` header against a file of `size` bytes.
 *
 * Exported for tests. Returns null for anything that is not one satisfiable
 * range - the caller then answers 416 or serves the whole file.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;

  let start: number;
  let end: number;
  if (match[1] === '') {
    // "bytes=-500": the last 500 bytes.
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (start > end || start >= size) return null;
  return { start, end };
}

export function registerMediaProtocolHandler(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const token = url.pathname.replace(/^\//, '');
    const path = url.hostname === 'file' ? tokens.get(token) : undefined;
    if (!path) return new Response('Not found', { status: 404 });

    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return new Response('Not found', { status: 404 });

    const size = info.size;
    const headers: Record<string, string> = {
      'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };

    const rangeHeader = request.headers.get('Range');
    const range = parseRange(rangeHeader, size);

    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;

    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  });
}
