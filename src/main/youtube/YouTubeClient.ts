import { createHash, randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname } from 'node:path';
import type { YouTubePrivacy, YouTubeUploadMeta, YouTubeUploadResult } from '@shared/types/ipc';

/**
 * Upload to YouTube with the account's own permission, never its password.
 *
 * This is Google's flow for desktop apps, as its "OAuth 2.0 for Mobile & Desktop
 * Apps" guide lays it out:
 *
 *  - Sign-in happens in the user's own browser, on accounts.google.com. The
 *    app never sees the password and never shows a Google page itself -
 *    Google refuses sign-in inside embedded web views.
 *  - Google sends the answer back to a one-off server on 127.0.0.1 (the
 *    "loopback" redirect; custom URL schemes are deprecated).
 *  - PKCE ties that answer to this app: only the process that made the
 *    random verifier can trade the code for a token.
 *  - The only scope asked for is `youtube.upload`: it can add videos, not
 *    read, change or delete anything on the channel.
 *
 * The tokens live in this object and nowhere else. Nothing about the account
 * is written to disk; closing the app or signing out forgets it, and signing
 * out also revokes the token at Google.
 *
 * Nothing here imports Electron: the browser is opened through a callback, so
 * the whole exchange can be tested against a stand-in for Google.
 */

export interface YouTubeEndpoints {
  auth: string;
  token: string;
  revoke: string;
  /** Base for the resumable upload: `${upload}/upload/youtube/v3/videos`. */
  upload: string;
}

export const GOOGLE_ENDPOINTS: YouTubeEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  upload: 'https://www.googleapis.com',
};

export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

/** Google wants chunks in multiples of 256 KiB; 8 MiB keeps a retry cheap. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const MAX_RETRIES = 6;

export interface OAuthClient {
  clientId: string;
  /**
   * Google issues one to desktop clients and asks for it at the token
   * endpoint, but says outright that an installed app cannot keep it secret -
   * it names the app, not the user.
   */
  clientSecret: string;
}

/* Pure helpers ---------------------------------------------------------------- */

const base64Url = (bytes: Buffer): string =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7636: the S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function authorizationUrl(
  endpoints: YouTubeEndpoints,
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const url = new URL(endpoints.auth);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: UPLOAD_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return url.toString();
}

/**
 * Where to carry on from, after a 308. Google's `Range: bytes=0-N` says what
 * it holds; no header means it holds nothing.
 */
export function nextOffsetFromRange(range: string | null): number {
  const match = range ? /bytes=0-(\d+)/.exec(range) : null;
  return match ? Number(match[1]) + 1 : 0;
}

/** YouTube takes these; a PNG sequence is a folder and is not offered. */
export function uploadContentType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      return null;
  }
}

/** Titles cannot hold < or > and stop at 100 characters. */
export function cleanTitle(title: string): string {
  const cleaned = title.replace(/[<>]/g, '').trim().slice(0, 100);
  return cleaned || 'Untitled';
}

/** Descriptions stop at 5000 bytes and cannot hold < or >. */
export function cleanDescription(description: string): string {
  let cleaned = description.replace(/[<>]/g, '');
  while (Buffer.byteLength(cleaned, 'utf8') > 5000) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

const PRIVACY = new Set<YouTubePrivacy>(['private', 'unlisted', 'public']);

/* The page the browser lands on ------------------------------------------------ */

const landingPage = (heading: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${heading}</title>` +
  '<body style="font:15px system-ui;background:#16181d;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0">' +
  `<div style="max-width:420px;text-align:center"><h1 style="font-size:20px">${heading}</h1><p>${body}</p></div>`;

/* The client ------------------------------------------------------------------ */

interface Tokens {
  access: string;
  refresh: string | null;
  expiresAt: number;
}

export class YouTubeClient {
  private tokens: Tokens | null = null;
  /** Who signed in, kept for refreshing; forgotten with the tokens. */
  private client: OAuthClient | null = null;
  private pendingServer: Server | null = null;
  private upload: AbortController | null = null;

  constructor(
    private readonly openBrowser: (url: string) => Promise<void> | void,
    private readonly endpoints: YouTubeEndpoints = GOOGLE_ENDPOINTS,
  ) {}

  get signedIn(): boolean {
    return this.tokens !== null;
  }

  /**
   * Open Google's sign-in in the browser and wait for it to come back.
   * Resolves once there is a token; rejects if the user says no, closes the
   * tab and five minutes pass, or `cancelSignIn` is called.
   */
  async signIn(client: OAuthClient): Promise<void> {
    this.cancelSignIn();
    const { verifier, challenge } = createPkce();
    const state = base64Url(randomBytes(16));

    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = '';
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        // Browsers also ask for /favicon.ico; only the redirect counts.
        if (url.pathname !== '/') {
          response.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get('error');
        const returned = url.searchParams.get('code');
        if (url.searchParams.get('state') !== state || (!returned && !error)) {
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(landingPage('Not recognised', 'This link did not come from the sign-in the editor started.'));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (error) {
          response.end(landingPage('Not connected', 'Nothing was shared. You can close this tab.'));
          finish(() => reject(new Error(error === 'access_denied' ? 'Sign-in was declined.' : `Google said: ${error}`)));
        } else {
          response.end(landingPage('Connected', 'You can close this tab and go back to the editor.'));
          finish(() => resolve({ code: returned as string, redirectUri }));
        }
      });

      const timer = setTimeout(
        () => finish(() => reject(new Error('Sign-in timed out. Try again.'))),
        SIGN_IN_TIMEOUT_MS,
      );
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        server.close();
        if (this.pendingServer === server) this.pendingServer = null;
        settle();
      };
      server.on('close', () => {
        clearTimeout(timer);
        // Closed by cancelSignIn: the promise must not hang.
        reject(new Error('Sign-in was cancelled.'));
      });

      this.pendingServer = server;
      // Port 0: the OS picks a free one. 127.0.0.1, not "localhost", as
      // Google recommends - it cannot be resolved to anything else.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(() => reject(new Error('Could not open the sign-in return port.')));
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}`;
        Promise.resolve(this.openBrowser(authorizationUrl(this.endpoints, client.clientId, redirectUri, challenge, state)))
          .catch((error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
      });
    });

    const response = await fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code.code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: code.redirectUri,
      }),
    });
    this.tokens = await this.readTokens(response, null);
    this.client = client;
  }

  cancelSignIn(): void {
    this.pendingServer?.close();
    this.pendingServer = null;
  }

  /** Forget the tokens here and revoke them at Google. */
  async signOut(): Promise<void> {
    const tokens = this.tokens;
    this.tokens = null;
    this.client = null;
    if (!tokens) return;
    await fetch(this.endpoints.revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh ?? tokens.access }),
    }).catch(() => undefined);
  }

  private async readTokens(response: Response, previousRefresh: string | null): Promise<Tokens> {
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(`Google did not grant access: ${body.error_description ?? body.error ?? response.status}`);
    }
    return {
      access: body.access_token,
      refresh: body.refresh_token ?? previousRefresh,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  }

  /** A token good for at least another minute, refreshed if needed. */
  private async accessToken(force = false): Promise<string> {
    const tokens = this.tokens;
    if (!tokens || !this.client) throw new Error('Not signed in to YouTube.');
    if (!force && tokens.expiresAt - Date.now() > 60_000) return tokens.access;
    if (!tokens.refresh) throw new Error('The YouTube sign-in expired. Sign in again.');

    const response = await fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        refresh_token: tokens.refresh,
        grant_type: 'refresh_token',
      }),
    });
    this.tokens = await this.readTokens(response, tokens.refresh);
    return this.tokens.access;
  }

  cancelUpload(): void {
    this.upload?.abort();
  }

  /**
   * Resumable upload, as the YouTube Data API documents it: one request opens
   * a session, then the file goes up in chunks. A dropped connection or a 5xx
   * asks Google how much it holds and carries on from there, so an hour-long
   * upload does not restart from zero over one bad minute.
   */
  async uploadVideo(
    path: string,
    meta: YouTubeUploadMeta,
    onProgress: (sent: number, total: number) => void,
  ): Promise<YouTubeUploadResult> {
    const contentType = uploadContentType(path);
    if (!contentType) throw new Error('YouTube takes MP4, MOV or WebM files.');
    if (!PRIVACY.has(meta.privacy)) throw new Error('Unknown privacy setting.');
    const total = (await stat(path)).size;
    if (total === 0) throw new Error('The file is empty.');

    const controller = new AbortController();
    this.upload = controller;
    const signal = controller.signal;

    try {
      const session = await this.withAuth((token) =>
        fetch(`${this.endpoints.upload}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(total),
            'X-Upload-Content-Type': contentType,
          },
          body: JSON.stringify({
            snippet: {
              title: cleanTitle(meta.title),
              description: cleanDescription(meta.description),
              // People & Blogs, the category Google's own upload sample uses.
              categoryId: '22',
            },
            status: {
              privacyStatus: meta.privacy,
              selfDeclaredMadeForKids: meta.madeForKids,
            },
          }),
        }),
      );
      const location = session.headers.get('location');
      if (!session.ok || !location) throw new Error(await describeFailure(session, 'YouTube did not open the upload'));

      const file = await open(path, 'r');
      try {
        let offset = 0;
        let failures = 0;
        onProgress(0, total);

        for (;;) {
          const end = Math.min(offset + CHUNK_BYTES, total);
          const chunk = Buffer.alloc(end - offset);
          await file.read(chunk, 0, chunk.length, offset);

          let response: Response;
          try {
            response = await this.withAuth((token) =>
              fetch(location, {
                method: 'PUT',
                signal,
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': contentType,
                  'Content-Range': `bytes ${offset}-${end - 1}/${total}`,
                },
                body: chunk,
              }),
            );
          } catch (error) {
            if (signal.aborted) throw error;
            response = new Response(null, { status: 599 });
          }

          if (response.status === 200 || response.status === 201) {
            onProgress(total, total);
            const video = (await response.json()) as { id?: string; status?: { privacyStatus?: YouTubePrivacy } };
            if (!video.id) throw new Error('YouTube finished the upload without naming the video.');
            return {
              videoId: video.id,
              url: `https://youtu.be/${video.id}`,
              privacy: video.status?.privacyStatus ?? meta.privacy,
              requestedPrivacy: meta.privacy,
            };
          }

          if (response.status === 308) {
            offset = nextOffsetFromRange(response.headers.get('range'));
            failures = 0;
            onProgress(offset, total);
            continue;
          }

          if (response.status >= 500) {
            failures += 1;
            if (failures > MAX_RETRIES) throw new Error(await describeFailure(response, 'YouTube kept failing'));
            // Exponential back-off with jitter, as the API guide asks.
            await delay(Math.min(32_000, 2 ** failures * 500) + Math.random() * 500, signal);
            offset = await this.uploadedSoFar(location, total, signal);
            onProgress(offset, total);
            continue;
          }

          throw new Error(await describeFailure(response, 'YouTube refused the upload'));
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      if (signal.aborted) throw new Error('Upload cancelled.');
      throw error;
    } finally {
      if (this.upload === controller) this.upload = null;
    }
  }

  /** Ask the session how much it holds: an empty PUT with `bytes *\/total`. */
  private async uploadedSoFar(location: string, total: number, signal: AbortSignal): Promise<number> {
    const response = await this.withAuth((token) =>
      fetch(location, {
        method: 'PUT',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${total}` },
      }),
    ).catch(() => null);
    if (response?.status === 308) return nextOffsetFromRange(response.headers.get('range'));
    // Could not ask: start again from zero - the session keeps what it has
    // and will answer the next chunk with its real range.
    return 0;
  }

  /** Run a request; on a 401, refresh the token once and run it again. */
  private async withAuth(request: (token: string) => Promise<Response>): Promise<Response> {
    const response = await request(await this.accessToken());
    if (response.status !== 401) return response;
    return request(await this.accessToken(true));
  }
}

async function describeFailure(response: Response, what: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; errors?: { reason?: string }[] };
  } | null;
  const reason = body?.error?.errors?.[0]?.reason;
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') {
    return `${what}: the daily upload limit for this Google project is used up. Try again tomorrow.`;
  }
  return `${what} (${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}).`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
