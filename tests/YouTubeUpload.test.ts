import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  YouTubeClient,
  nextOffsetFromRange,
  pkceChallenge,
  type YouTubeEndpoints,
} from '@main/youtube/YouTubeClient';

/**
 * The YouTube sign-in and upload, against a stand-in for Google on 127.0.0.1.
 *
 * The stand-in behaves the way the real endpoints are documented to: it
 * redirects the "browser" back to the loopback address with a code, checks the
 * PKCE verifier against the challenge, and on the upload takes only part of a
 * chunk, fails once with a 503 and once with a 401 - so the resume, the
 * retry and the token refresh are all exercised, not just the happy path.
 */

interface Fake {
  base: string;
  server: Server;
  received: Buffer;
  metadata: unknown;
  revoked: string[];
  refreshes: number;
  /** What to say to the sign-in: a code, or Google's "access_denied". */
  decline: boolean;
}

function body(request: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => resolve(Buffer.concat(parts)));
  });
}

async function startFake(): Promise<Fake> {
  let challenge = '';
  let total = 0;
  let puts = 0;
  const fake = { received: Buffer.alloc(0), metadata: null, revoked: [], refreshes: 0, decline: false } as unknown as Fake;

  fake.server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const payload = await body(request);

    if (url.pathname === '/auth') {
      challenge = url.searchParams.get('code_challenge') ?? '';
      expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      expect(back.hostname).toBe('127.0.0.1');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set(fake.decline ? 'error' : 'code', fake.decline ? 'access_denied' : 'the-code');
      response.writeHead(302, { Location: back.toString() }).end();
      return;
    }

    if (url.pathname === '/token') {
      const form = new URLSearchParams(payload.toString());
      response.setHeader('Content-Type', 'application/json');
      if (form.get('grant_type') === 'refresh_token') {
        fake.refreshes += 1;
        response.end(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }));
        return;
      }
      const verified =
        form.get('code') === 'the-code' &&
        form.get('client_secret') === 'secret' &&
        createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
      if (!verified) {
        response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      response.end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }));
      return;
    }

    if (url.pathname === '/revoke') {
      fake.revoked.push(new URLSearchParams(payload.toString()).get('token') ?? '');
      response.end();
      return;
    }

    if (url.pathname === '/upload/youtube/v3/videos') {
      expect(url.searchParams.get('uploadType')).toBe('resumable');
      expect(request.headers.authorization).toBe('Bearer access-1');
      total = Number(request.headers['x-upload-content-length']);
      fake.metadata = JSON.parse(payload.toString());
      response.writeHead(200, { Location: `${fake.base}/session` }).end();
      return;
    }

    if (url.pathname === '/session') {
      const range = String(request.headers['content-range'] ?? '');
      const held = (): Record<string, string> =>
        fake.received.length > 0 ? { Range: `bytes=0-${fake.received.length - 1}` } : {};

      if (range === `bytes */${total}`) {
        response.writeHead(308, held()).end();
        return;
      }
      puts += 1;
      // Second chunk request: a server error. Third: an expired token.
      if (puts === 2) {
        response.writeHead(503).end();
        return;
      }
      if (puts === 3) {
        response.writeHead(401).end();
        return;
      }
      if (puts > 3) expect(request.headers.authorization).toBe('Bearer access-2');

      const start = Number(/bytes (\d+)-/.exec(range)?.[1]);
      expect(start).toBe(fake.received.length);
      // The first time, keep only 256 KiB of what was sent.
      const kept = puts === 1 ? payload.subarray(0, 256 * 1024) : payload;
      fake.received = Buffer.concat([fake.received, kept]);

      if (fake.received.length < total) {
        response.writeHead(308, held()).end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      // An unaudited project: YouTube makes it private whatever was asked.
      response.end(JSON.stringify({ id: 'video-123', status: { privacyStatus: 'private' } }));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address();
  fake.base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return fake;
}

const endpointsFor = (base: string): YouTubeEndpoints => ({
  auth: `${base}/auth`,
  token: `${base}/token`,
  revoke: `${base}/revoke`,
  upload: base,
});

/** The "browser": follows Google's redirect back to the editor. */
const browser = (url: string): void => {
  void fetch(url).catch(() => undefined);
};

describe('YouTube upload', () => {
  let fake: Fake;
  let folder: string;

  beforeEach(async () => {
    fake = await startFake();
    folder = mkdtempSync(join(tmpdir(), 'scf-youtube-'));
  });

  afterEach(() => {
    fake.server.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('computes the PKCE challenge the way RFC 7636 does', () => {
    // The worked example in RFC 7636, appendix B.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(nextOffsetFromRange('bytes=0-262143')).toBe(262144);
    expect(nextOffsetFromRange(null)).toBe(0);
  });

  it('signs in through the browser, uploads through a resume, a 503 and a 401, and signs out', async () => {
    const file = join(folder, 'clip.mp4');
    const bytes = randomBytes(700_000);
    writeFileSync(file, bytes);

    const client = new YouTubeClient(browser, endpointsFor(fake.base));
    await client.signIn({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' });
    expect(client.signedIn).toBe(true);

    const seen: number[] = [];
    const result = await client.uploadVideo(
      file,
      { title: '  <My> clip ', description: 'A <b>test</b>', privacy: 'public', madeForKids: false },
      (sent) => seen.push(sent),
    );

    expect(fake.received.equals(bytes)).toBe(true);
    expect(fake.refreshes).toBe(1);
    expect(seen).toContain(256 * 1024);
    expect(seen.at(-1)).toBe(bytes.length);
    expect(fake.metadata).toEqual({
      snippet: { title: 'My clip', description: 'A btest/b', categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    });
    expect(result).toEqual({
      videoId: 'video-123',
      url: 'https://youtu.be/video-123',
      privacy: 'private',
      requestedPrivacy: 'public',
    });

    await client.signOut();
    expect(client.signedIn).toBe(false);
    expect(fake.revoked).toEqual(['refresh-1']);
  }, 20_000);

  it('says so when the user declines, and holds no token', async () => {
    fake.decline = true;
    const client = new YouTubeClient(browser, endpointsFor(fake.base));
    await expect(
      client.signIn({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' }),
    ).rejects.toThrow('Sign-in was declined.');
    expect(client.signedIn).toBe(false);
  });
});
