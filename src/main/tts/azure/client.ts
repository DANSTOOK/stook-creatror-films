import { buildSsml, type SsmlRequest } from './ssml';

/**
 * Talking to Azure AI Speech's text-to-speech REST endpoint.
 *
 * Two calls, both documented at
 * learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech:
 *
 *  - `GET  {endpoint}/tts/cognitiveservices/voices/list` - the voices this
 *    key can use, which is the truth about what exists; the catalogue in
 *    `catalog.ts` is only a fallback for before a key is set.
 *  - `POST {endpoint}/cognitiveservices/v1` - one SSML document in, one
 *    audio file out.
 *
 * The key travels in `Ocp-Apim-Subscription-Key`. Azure also accepts a
 * ten-minute bearer token from its `issueToken` endpoint, which is NOT used
 * here: it would be a second request before every synthesis and a second
 * thing to expire halfway through a job, and Microsoft's own note says the
 * key "works with all endpoint formats" while a bearer token may not.
 *
 * `fetch` is injected so the main process can pass Electron's `net.fetch`
 * (which follows the system proxy) and the tests can pass a stand-in. This
 * file never imports Electron.
 */

/** What the service is asked for: a RIFF/WAV the rest of the pipeline can read as-is. */
export const OUTPUT_FORMAT = 'riff-24khz-16bit-mono-pcm';
export const OUTPUT_SAMPLE_RATE = 24_000;

/** Azure requires a `User-Agent` and refuses one of 255 characters or more. */
const USER_AGENT = 'StookCreatorFilms';

/** One request's ceiling. Azure truncates the audio at ten minutes; a piece of speech is a sentence. */
export const MAX_SSML_CHARS = 8_000;

export type AzureFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface AzureAccount {
  /** The resource key. Never logged, never sent anywhere but the endpoint below. */
  key: string;
  /** A region such as `eastus`, or a whole endpoint URL for a resource with a custom subdomain. */
  region: string;
}

/** Why a call failed, in terms the panel can turn into one sentence a person can act on. */
export type AzureFailure =
  | { kind: 'badKey' }
  | { kind: 'badRegion' }
  | { kind: 'rejected'; detail: string }
  | { kind: 'rateLimit'; retryAfterSeconds: number | null }
  | { kind: 'service'; status: number }
  | { kind: 'offline'; detail: string };

export class AzureError extends Error {
  constructor(readonly failure: AzureFailure, message: string) {
    super(message);
    this.name = 'AzureError';
  }
}

/** A region name as Azure writes them: lowercase letters and digits, e.g. `eastus2`. */
export const looksLikeRegion = (value: string): boolean => /^[a-z]{2,}[a-z0-9]*$/.test(value.trim());

/**
 * A Speech key is 32 hexadecimal characters, or - for a resource created
 * with the newer key format - a longer opaque string. Only the obviously
 * wrong is refused here, so the panel can say "that is not a key" without
 * a round trip; anything else is settled by asking Azure.
 */
export const looksLikeKey = (value: string): boolean => /^[A-Za-z0-9+/=_-]{20,200}$/.test(value.trim());

/**
 * The base URL for an account.
 *
 * A region becomes Azure's regional host. A value that is already a URL is
 * used as it stands, for a resource with a custom subdomain - its path is
 * dropped, because the paths are appended below. Only https is accepted: a
 * key must never go out in the clear.
 */
export function endpointFor(account: AzureAccount): string {
  // The tests stand in for Azure on 127.0.0.1, the way they already do for
  // Google (main/youtube/youtubeIpc). Nothing else is accepted, so this
  // variable cannot send a key anywhere but this machine, and it is the only
  // thing in here that is not https.
  const standIn = process.env.SCF_AZURE_ENDPOINT;
  if (standIn && /^http:\/\/127\.0\.0\.1:\d+$/.test(standIn)) return standIn;

  const region = account.region.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(region)) {
    const url = new URL(region);
    if (url.protocol !== 'https:') throw new AzureError({ kind: 'badRegion' }, 'The endpoint must be https');
    return `https://${url.host}`;
  }
  if (!looksLikeRegion(region)) throw new AzureError({ kind: 'badRegion' }, `Not a region: ${region}`);
  return `https://${region}.tts.speech.microsoft.com`;
}

/** The voices list is on the resource host; the regional host serves it under the same path. */
const voicesUrl = (account: AzureAccount): string => `${endpointFor(account)}/cognitiveservices/voices/list`;
const synthesisUrl = (account: AzureAccount): string => `${endpointFor(account)}/cognitiveservices/v1`;

/**
 * One entry of the voices list, with the field names Azure uses. Only the
 * fields the app reads are declared; the response carries more.
 */
export interface AzureVoice {
  Name: string;
  DisplayName: string;
  LocalName: string;
  ShortName: string;
  Gender: 'Female' | 'Male' | string;
  Locale: string;
  LocaleName: string;
  StyleList?: string[];
  RolePlayList?: string[];
  SampleRateHertz?: string;
  VoiceType?: string;
  Status?: string;
  WordsPerMinute?: string;
}

/**
 * What a status code means.
 *
 * The mapping is Microsoft's own table. 403 is NOT in it - it appears for a
 * key that is valid but whose resource is disabled or out of quota - so it
 * is reported as a refusal with whatever the body says rather than guessed
 * at.
 */
function failureFor(status: number, body: string, retryAfter: string | null): AzureFailure {
  const detail = body.trim().slice(0, 300);
  if (status === 401) return { kind: 'badKey' };
  if (status === 403) return { kind: 'rejected', detail: detail || 'forbidden' };
  if (status === 429) {
    const seconds = Number(retryAfter);
    return { kind: 'rateLimit', retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
  }
  if (status === 400 || status === 415) return { kind: 'rejected', detail: detail || `HTTP ${status}` };
  // 404 on the regional host means the region exists but the path does not:
  // almost always a region the resource is not in.
  if (status === 404) return { kind: 'badRegion' };
  return { kind: 'service', status };
}

const describe = (failure: AzureFailure): string => {
  switch (failure.kind) {
    case 'badKey': return 'Azure refused the key';
    case 'badRegion': return 'Wrong region for this resource';
    case 'rejected': return `Azure refused the request: ${failure.detail}`;
    case 'rateLimit': return 'Azure is rate limiting this resource';
    case 'service': return `Azure returned HTTP ${failure.status}`;
    case 'offline': return `Could not reach Azure: ${failure.detail}`;
  }
};

const fail = (failure: AzureFailure): never => {
  throw new AzureError(failure, describe(failure));
};

export interface CallOptions {
  fetch: AzureFetch;
  signal?: AbortSignal;
  /** How many times a rate limit or a server-side fault is waited out. */
  retries?: number;
  /** Injected in the tests so they do not actually wait. */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * A call, retried only where retrying is the documented answer: 429 (the
 * quota or rate was exceeded) and 502/503 (a server-side problem). A refused
 * key or a malformed document is never retried - it would fail identically
 * and only delay the message the person needs to see.
 */
async function call<T>(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  options: CallOptions,
  read: (response: Awaited<ReturnType<AzureFetch>>) => Promise<T>,
): Promise<T> {
  const retries = options.retries ?? 2;
  const wait = options.wait ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    let response: Awaited<ReturnType<AzureFetch>>;
    try {
      response = await options.fetch(url, { ...init, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return fail({ kind: 'offline', detail: error instanceof Error ? error.message : String(error) });
    }
    if (response.ok) return read(response);

    const body = await response.text().catch(() => '');
    const failure = failureFor(response.status, body, response.headers.get('Retry-After'));
    const worthRetrying = failure.kind === 'rateLimit' || failure.kind === 'service';
    if (!worthRetrying || attempt >= retries) return fail(failure);
    // Azure's own Retry-After when it sends one; otherwise back off.
    const seconds = failure.kind === 'rateLimit' && failure.retryAfterSeconds ? failure.retryAfterSeconds : 2 ** attempt;
    await wait(Math.min(30, seconds) * 1000);
  }
}

/** The voices this key can use. */
export async function listVoices(account: AzureAccount, options: CallOptions): Promise<AzureVoice[]> {
  return call(
    voicesUrl(account),
    { method: 'GET', headers: { 'Ocp-Apim-Subscription-Key': account.key, 'User-Agent': USER_AGENT } },
    options,
    async (response) => {
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fail({ kind: 'rejected', detail: 'The voices list was not JSON' });
      }
      if (!Array.isArray(parsed)) return fail({ kind: 'rejected', detail: 'The voices list was not a list' });
      return parsed.filter((voice): voice is AzureVoice => typeof (voice as AzureVoice)?.ShortName === 'string');
    },
  );
}

/**
 * One piece of speech as a RIFF/WAV.
 *
 * The SSML is built here rather than taken from the caller, so nothing can
 * reach the wire without having been escaped.
 */
export async function synthesize(account: AzureAccount, request: SsmlRequest, options: CallOptions): Promise<Buffer> {
  const ssml = buildSsml(request);
  if (ssml.length > MAX_SSML_CHARS) return fail({ kind: 'rejected', detail: `The text is too long for one request (${ssml.length} characters)` });
  return call(
    synthesisUrl(account),
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': account.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
        'User-Agent': USER_AGENT,
      },
      body: ssml,
    },
    options,
    async (response) => {
      const audio = Buffer.from(await response.arrayBuffer());
      // A RIFF/WAV header is 44 bytes; anything shorter is not audio, whatever
      // the status said.
      if (audio.length < 45 || audio.toString('ascii', 0, 4) !== 'RIFF') {
        return fail({ kind: 'rejected', detail: 'Azure returned something that is not audio' });
      }
      return audio;
    },
  );
}

/** Whether a key and region work at all, and what they can speak. Used by the panel's Check button. */
export async function checkAccount(account: AzureAccount, options: CallOptions): Promise<AzureVoice[]> {
  if (!looksLikeKey(account.key)) return fail({ kind: 'badKey' });
  return listVoices(account, { ...options, retries: 0 });
}
