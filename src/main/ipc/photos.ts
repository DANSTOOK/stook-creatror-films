import { writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, net } from 'electron';
import { IPC, type PhotoSearchReply } from '@shared/types/ipc';

/**
 * Openverse, from the main process.
 *
 * The renderer may not reach outside - its Content-Security-Policy says so,
 * and in an app that opens other people's media files that rule earns its
 * keep. So the search and the picture are fetched here and handed back.
 *
 * Electron's own `net` is used rather than `fetch` because it goes through
 * Chromium's stack, and so through whatever proxy the machine is set up with.
 * A user behind a company proxy is exactly the user who would otherwise be
 * told "check the connection" about a connection that is perfectly fine.
 */

const ENDPOINT = 'https://api.openverse.org/v1/images/';
/** Named so Openverse can see who is calling, which their terms ask for. */
const AGENT = 'StookCreatorFilms/3.0 (video editor; openverse background search)';

/** Licences that let a video be published: public domain, or credit only. */
const LICENCES = 'cc0,pdm,by,by-sa';

/**
 * Openverse is slow when it is cold. Measured here against the live service:
 * a first search took over twenty seconds and came back fine at forty-five,
 * and a couple of attempts returned a gateway error before succeeding. So the
 * wait is generous and a failure is tried again rather than reported.
 */
const SEARCH_TIMEOUT_MS = 45_000;
/** A picture is bigger than a page of JSON, and worth waiting longer for. */
const FETCH_TIMEOUT_MS = 60_000;
const RETRIES = 2;

/** The biggest picture worth pulling down: past this it is a download, not a background. */
const MAX_BYTES = 25 * 1024 * 1024;

function request(url: string, accept: string, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const call = net.request({ method: 'GET', url });
    call.setHeader('User-Agent', AGENT);
    call.setHeader('Accept', accept);
    const timer = setTimeout(() => {
      call.abort();
      reject(new Error('timeout'));
    }, timeoutMs);

    call.on('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        // Stop reading rather than fill memory with something enormous.
        if (size > MAX_BYTES) {
          clearTimeout(timer);
          call.abort();
          reject(new Error('too big'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
      response.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    call.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    call.end();
  });
}

/** A URL this is willing to fetch: Openverse's own, or a picture it pointed at. */
function allowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    // https only, so a result cannot talk us into a plain-text or local request.
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function registerPhotoIpc(): void {
  ipcMain.handle(IPC.photosSearch, async (_event, query: string, page: number): Promise<PhotoSearchReply> => {
    const wanted = String(query ?? '').trim();
    const empty: PhotoSearchReply = { results: [], resultCount: 0, pageCount: 0 };
    if (!wanted) return empty;

    const url = new URL(ENDPOINT);
    url.searchParams.set('q', wanted);
    url.searchParams.set('license', LICENCES);
    url.searchParams.set('page', String(Math.max(1, Math.floor(Number(page) || 1))));
    // Twenty is the most an anonymous request may ask for. Twenty-four came
    // back as a 401 with the reason in the body, which this code was throwing
    // away as a plain failure - hence the message about the connection on a
    // connection that was fine.
    url.searchParams.set('page_size', '20');
    // No aspect_ratio or size filter. Measured against the live service:
    // adding either made the same query time out at forty-five seconds,
    // while without them it answers in a moment. The shape and the size are
    // sorted out here instead - cropped to fill, and small ones left out.

    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const { status, body } = await request(url.toString(), 'application/json', SEARCH_TIMEOUT_MS);
        // The daily allowance, which is a thing the user can be told plainly.
        if (status === 429) return { ...empty, error: 'rate' };
        if (status >= 500) {
          // A gateway error is usually momentary; the last one gives up.
          if (attempt < RETRIES) continue;
          return { ...empty, error: 'failed' };
        }
        if (status !== 200) {
          // Keep what it said: the body carries the reason, and a silent
          // failure here cost an hour once already.
          console.warn(`[photos] Openverse ${status}: ${body.toString('utf8').slice(0, 200)}`);
          return { ...empty, error: 'failed' };
        }
        const parsed = JSON.parse(body.toString('utf8')) as { results?: unknown[]; result_count?: number; page_count?: number };
        return {
          results: Array.isArray(parsed.results) ? parsed.results : [],
          resultCount: Number(parsed.result_count) || 0,
          pageCount: Number(parsed.page_count) || 0,
        };
      } catch {
        if (attempt < RETRIES) continue;
        return { ...empty, error: 'failed' };
      }
    }
    return { ...empty, error: 'failed' };
  });

  ipcMain.handle(IPC.photosFetch, async (_event, url: string): Promise<ArrayBuffer | null> => {
    if (!allowed(String(url ?? ''))) return null;
    try {
      const { status, body } = await request(String(url), 'image/*', FETCH_TIMEOUT_MS);
      if (status !== 200 || body.length === 0) return null;
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    } catch {
      return null;
    }
  });

  /**
   * A drawn animation written out as Lottie.
   *
   * Through a save dialog, so the page never names a path of its own: the
   * user chooses where it goes, which is the only place this is allowed to
   * write.
   */
  ipcMain.handle(IPC.animSaveLottie, async (_event, suggestedName: unknown, json: unknown): Promise<string | null> => {
    if (typeof json !== 'string' || json.length === 0) return null;
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!window) return null;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: typeof suggestedName === 'string' && suggestedName ? suggestedName : 'animation.json',
      filters: [{ name: 'Lottie (.json)', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, json, 'utf8');
    return result.filePath;
  });
}
