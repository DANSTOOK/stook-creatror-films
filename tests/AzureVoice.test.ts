import { describe, expect, it, vi } from 'vitest';
import { buildSsml, escapeSsml, localeOf, MAX_RATE, MAX_SEMITONES } from '../src/main/tts/azure/ssml';
import {
  AzureError,
  checkAccount,
  endpointFor,
  listVoices,
  looksLikeKey,
  looksLikeRegion,
  OUTPUT_FORMAT,
  synthesize,
  type AzureFetch,
  type AzureVoice,
} from '../src/main/tts/azure/client';
import { isOffered, offeredVoices, SHORTLIST } from '../src/main/tts/azure/voices';

/**
 * Azure's voices: the SSML that goes out and what is made of what comes back.
 *
 * None of this talks to Azure. A format a remote service parses can only be
 * checked by looking at the exact characters, and a failure can only be
 * checked by handing the code the failure - so the service is stood in for,
 * and the live tests (tests/ui/azure-voice.mjs) are what prove the real one
 * accepts it.
 */

const account = { key: 'k'.repeat(32), region: 'eastus' };

/** A stand-in for Azure that answers however a test needs, and records what it was asked. */
function server(answers: Array<{ status?: number; body?: string; audio?: Buffer; headers?: Record<string, string> }>): {
  fetch: AzureFetch;
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let next = 0;
  const fetch: AzureFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const answer = answers[Math.min(next++, answers.length - 1)];
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => answer.headers?.[name] ?? null },
      text: async () => answer.body ?? '',
      arrayBuffer: async () => {
        const audio = answer.audio ?? Buffer.alloc(0);
        return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
      },
    };
  };
  return { fetch, calls };
}

/** A believable WAV: the RIFF magic and enough bytes to be audio. */
const wav = (): Buffer => {
  const audio = Buffer.alloc(200);
  audio.write('RIFF', 0, 'ascii');
  audio.write('WAVE', 8, 'ascii');
  return audio;
};

const voice = (shortName: string, extra: Partial<AzureVoice> = {}): AzureVoice => ({
  Name: `Microsoft Server Speech Text to Speech Voice (${shortName})`,
  DisplayName: shortName.split('-')[2]?.replace('Neural', '') ?? 'X',
  LocalName: 'X',
  ShortName: shortName,
  Gender: 'Female',
  Locale: shortName.split('-').slice(0, 2).join('-'),
  LocaleName: 'X',
  VoiceType: 'Neural',
  Status: 'GA',
  ...extra,
});

/* The document that goes out ------------------------------------------------- */

describe('the SSML document', () => {
  it('is the minimum Azure documents, for a voice speaking as it is', () => {
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: 'Hola' })).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-MX">' +
        '<voice name="es-MX-DaliaNeural">Hola</voice>' +
        '</speak>',
    );
  });

  it('takes its language from the voice, so a clip never speaks Spanish with English rules', () => {
    expect(localeOf('es-MX-DaliaNeural')).toBe('es-MX');
    expect(localeOf('en-GB-SoniaNeural')).toBe('en-GB');
    expect(buildSsml({ voice: 'en-GB-SoniaNeural', text: 'Hi' })).toContain('xml:lang="en-GB"');
  });

  it('declares the mstts namespace only when a style actually uses it', () => {
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: 'Hola' })).not.toContain('mstts');
    const styled = buildSsml({ voice: 'es-MX-DaliaNeural', text: 'Hola', style: 'newscast' });
    expect(styled).toContain('xmlns:mstts="http://www.w3.org/2001/mstts"');
    expect(styled).toContain('<mstts:express-as style="newscast">Hola</mstts:express-as>');
  });

  it('writes a pitch change as a signed semitone offset, which is Azure\'s relative form', () => {
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: 'Hola', semitones: 3 })).toContain('<prosody pitch="+3st">');
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: 'Hola', semitones: -2.5 })).toContain('<prosody pitch="-2.5st">');
  });

  it('leaves prosody out entirely when there is nothing to change', () => {
    const plain = buildSsml({ voice: 'es-MX-DaliaNeural', text: 'Hola', rate: 1, semitones: 0 });
    expect(plain).not.toContain('prosody');
  });

  it('holds rate and pitch inside the range Azure says it supports', () => {
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: 'x', rate: 9 })).toContain(`rate="${MAX_RATE}"`);
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: 'x', rate: 0.01 })).toContain('rate="0.5"');
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: 'x', semitones: 99 })).toContain(`pitch="+${MAX_SEMITONES}st"`);
  });

  it('keeps a style degree, and drops the default one as noise', () => {
    expect(buildSsml({ voice: 'x-US-ANeural', text: 'x', style: 'sad', styleDegree: 2 })).toContain('styledegree="2"');
    expect(buildSsml({ voice: 'x-US-ANeural', text: 'x', style: 'sad', styleDegree: 1 })).not.toContain('styledegree');
  });

  it('ignores a style degree and a role when there is no style to apply them to', () => {
    const none = buildSsml({ voice: 'es-MX-DaliaNeural', text: 'x', styleDegree: 2, role: 'Girl' });
    expect(none).not.toContain('styledegree');
    expect(none).not.toContain('role');
  });

  /*
   * The one that matters most: a script is written by a person, so it will
   * contain ampersands and quotes, and an unescaped one of those does not
   * mispronounce a word - it makes Azure refuse the whole document.
   */
  it('escapes the characters that would otherwise break the document', () => {
    expect(escapeSsml(`Tom & Jerry <b> "x" 'y'`)).toBe('Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &apos;y&apos;');
  });

  it('escapes the ampersand first, so its own entity is not escaped again', () => {
    expect(escapeSsml('&lt;')).toBe('&amp;lt;');
  });

  it('cannot be closed early by the text it carries', () => {
    const attack = buildSsml({ voice: 'es-MX-DaliaNeural', text: '</voice></speak><voice name="other">hi' });
    expect(attack).not.toContain('<voice name="other">');
    expect([...attack.matchAll(/<voice /g)]).toHaveLength(1);
  });

  it('keeps the accents and punctuation Spanish needs', () => {
    expect(buildSsml({ voice: 'es-MX-DaliaNeural', text: '¿Qué tal, señor? ¡Año!' })).toContain('¿Qué tal, señor? ¡Año!');
  });
});

/* Where the request goes ---------------------------------------------------- */

describe('the endpoint', () => {
  it('is the regional host for a region', () => {
    expect(endpointFor({ key: 'k', region: 'eastus' })).toBe('https://eastus.tts.speech.microsoft.com');
    expect(endpointFor({ key: 'k', region: ' westeurope ' })).toBe('https://westeurope.tts.speech.microsoft.com');
  });

  it('is the resource itself when a whole endpoint was given, for a custom subdomain', () => {
    expect(endpointFor({ key: 'k', region: 'https://mine.cognitiveservices.azure.com/' })).toBe('https://mine.cognitiveservices.azure.com');
  });

  it('refuses to send a key over plain http', () => {
    expect(() => endpointFor({ key: 'k', region: 'http://mine.cognitiveservices.azure.com' })).toThrow(AzureError);
  });

  it('refuses a region that is not one, before any request is made', () => {
    expect(() => endpointFor({ key: 'k', region: 'East US' })).toThrow(AzureError);
    expect(looksLikeRegion('eastus2')).toBe(true);
    expect(looksLikeRegion('East US')).toBe(false);
  });

  it('knows a key that is obviously not one without asking Azure', () => {
    expect(looksLikeKey('k'.repeat(32))).toBe(true);
    expect(looksLikeKey('short')).toBe(false);
    expect(looksLikeKey('has spaces in it and is long enough to pass length')).toBe(false);
  });
});

describe('a synthesis request', () => {
  it('carries the key, the SSML content type and the output format Azure documents', async () => {
    const { fetch, calls } = server([{ audio: wav() }]);
    await synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'Hola' }, { fetch });
    expect(calls[0].url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Ocp-Apim-Subscription-Key']).toBe(account.key);
    expect(calls[0].headers['Content-Type']).toBe('application/ssml+xml');
    expect(calls[0].headers['X-Microsoft-OutputFormat']).toBe(OUTPUT_FORMAT);
    // Azure requires a User-Agent and refuses one of 255 characters or more.
    expect(calls[0].headers['User-Agent']).toBeTruthy();
    expect(calls[0].headers['User-Agent'].length).toBeLessThan(255);
  });

  it('sends the document built here, not anything the caller composed', async () => {
    const { fetch, calls } = server([{ audio: wav() }]);
    await synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'Tom & Jerry' }, { fetch });
    expect(calls[0].body).toContain('Tom &amp; Jerry');
  });

  it('gives back the audio', async () => {
    const { fetch } = server([{ audio: wav() }]);
    const audio = await synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'Hola' }, { fetch });
    expect(audio.toString('ascii', 0, 4)).toBe('RIFF');
  });

  /*
   * A 200 with a body that is not audio has happened to every service that
   * ever sat behind a proxy or a captive portal. Reading it as a WAV would
   * put noise on the timeline instead of saying what went wrong.
   */
  it('refuses a success that is not actually audio', async () => {
    const { fetch } = server([{ body: '<html>sign in</html>' }]);
    await expect(synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'Hola' }, { fetch })).rejects.toMatchObject({
      failure: { kind: 'rejected' },
    });
  });
});

/* What is made of a failure -------------------------------------------------- */

describe('when Azure says no', () => {
  const synth = (answers: Parameters<typeof server>[0], wait = vi.fn(async () => undefined)) =>
    synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'Hola' }, { fetch: server(answers).fetch, wait });

  it('a refused key is a refused key, not a network problem', async () => {
    await expect(synth([{ status: 401, body: 'Unauthorized' }])).rejects.toMatchObject({ failure: { kind: 'badKey' } });
  });

  it('a 404 on a regional host means the wrong region, which is the usual mistake', async () => {
    await expect(synth([{ status: 404 }])).rejects.toMatchObject({ failure: { kind: 'badRegion' } });
  });

  it('a 400 comes back with what Azure said, because that names the bad SSML', async () => {
    await expect(synth([{ status: 400, body: 'Invalid SSML: unexpected element' }])).rejects.toMatchObject({
      failure: { kind: 'rejected', detail: 'Invalid SSML: unexpected element' },
    });
  });

  it('a wrong content type is reported as a refusal, not retried', async () => {
    const { fetch, calls } = server([{ status: 415 }]);
    await expect(synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'x' }, { fetch })).rejects.toMatchObject({
      failure: { kind: 'rejected' },
    });
    expect(calls).toHaveLength(1);
  });

  it('being unable to reach Azure at all is said so, and not mistaken for a bad key', async () => {
    const fetch: AzureFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    await expect(synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'x' }, { fetch })).rejects.toMatchObject({
      failure: { kind: 'offline' },
    });
  });
});

describe('waiting out a rate limit', () => {
  it('retries after the delay Azure itself asked for', async () => {
    const waits: number[] = [];
    const { fetch, calls } = server([{ status: 429, headers: { 'Retry-After': '3' } }, { audio: wav() }]);
    const audio = await synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'x' }, {
      fetch,
      wait: async (ms) => void waits.push(ms),
    });
    expect(audio.length).toBeGreaterThan(44);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([3000]);
  });

  it('backs off on its own when Azure sends no Retry-After', async () => {
    const waits: number[] = [];
    const { fetch } = server([{ status: 503 }, { status: 503 }, { audio: wav() }]);
    await synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'x' }, { fetch, wait: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1000, 2000]);
  });

  it('gives up rather than retrying for ever, and says it was the rate limit', async () => {
    const { fetch, calls } = server([{ status: 429 }]);
    await expect(
      synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'x' }, { fetch, retries: 2, wait: async () => undefined }),
    ).rejects.toMatchObject({ failure: { kind: 'rateLimit' } });
    expect(calls).toHaveLength(3);
  });

  it('never waits longer than half a minute, whatever Azure asks for', async () => {
    const waits: number[] = [];
    const { fetch } = server([{ status: 429, headers: { 'Retry-After': '9999' } }, { audio: wav() }]);
    await synthesize(account, { voice: 'es-MX-DaliaNeural', text: 'x' }, { fetch, wait: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([30_000]);
  });
});

/* The voices ---------------------------------------------------------------- */

describe('the voices list', () => {
  it('is asked for with the key and nothing else', async () => {
    const { fetch, calls } = server([{ body: JSON.stringify([voice('es-MX-DaliaNeural')]) }]);
    await listVoices(account, { fetch });
    expect(calls[0].url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].body).toBeUndefined();
  });

  it('drops anything in it that is not a voice, rather than trusting the shape', async () => {
    const { fetch } = server([{ body: JSON.stringify([voice('es-MX-DaliaNeural'), { nonsense: true }, null]) }]);
    expect(await listVoices(account, { fetch })).toHaveLength(1);
  });

  it('says so when the answer is not JSON at all', async () => {
    const { fetch } = server([{ body: 'not json' }]);
    await expect(listVoices(account, { fetch })).rejects.toMatchObject({ failure: { kind: 'rejected' } });
  });

  it('checking an account does not retry: a person is waiting for the answer', async () => {
    const { fetch, calls } = server([{ status: 429 }]);
    await expect(checkAccount(account, { fetch, wait: async () => undefined })).rejects.toThrow(AzureError);
    expect(calls).toHaveLength(1);
  });

  it('checking an obviously wrong key does not ask Azure at all', async () => {
    const { fetch, calls } = server([{ body: '[]' }]);
    await expect(checkAccount({ key: 'no', region: 'eastus' }, { fetch })).rejects.toMatchObject({ failure: { kind: 'badKey' } });
    expect(calls).toHaveLength(0);
  });
});

describe('which voices the picker offers', () => {
  it('offers only what this key can actually speak', () => {
    const offered = offeredVoices([voice('es-MX-DaliaNeural'), voice('zz-ZZ-NobodyNeural')]);
    expect(offered.map((one) => one.shortName)).toEqual(['es-MX-DaliaNeural']);
  });

  it('keeps the shortlist\'s order, Spanish before English', () => {
    const live = SHORTLIST.map((choice) => voice(choice.shortName));
    const offered = offeredVoices(live);
    expect(offered[0].shortName).toBe('es-MX-DaliaNeural');
    const firstEnglish = offered.findIndex((one) => one.locale.startsWith('en-'));
    const lastSpanish = offered.map((one) => one.locale.startsWith('es-')).lastIndexOf(true);
    expect(lastSpanish).toBeLessThan(firstEnglish);
  });

  it('takes the styles from the live list, because only it knows which voice has any', () => {
    const offered = offeredVoices([voice('es-MX-DaliaNeural', { StyleList: ['cheerful', 'sad'] })]);
    expect(offered[0].styles).toEqual(['cheerful', 'sad']);
  });

  it('claims no style for a voice the live list gives none for', () => {
    expect(offeredVoices([voice('es-ES-ElviraNeural')])[0].styles).toEqual([]);
  });

  it('keeps the accented name the picker shows, which Azure\'s own DisplayName loses', () => {
    const offered = offeredVoices([voice('es-ES-AlvaroNeural', { DisplayName: 'Alvaro' })]);
    expect(offered[0].name).toBe('Álvaro');
  });

  it('knows which ids are its own, so a stale project cannot ask for anything else', () => {
    expect(isOffered('es-MX-DaliaNeural')).toBe(true);
    expect(isOffered('es-MX-SomethingElseNeural')).toBe(false);
    expect(isOffered(undefined)).toBe(false);
  });

  it('has every shortlist entry written the way Azure names a voice', () => {
    for (const choice of SHORTLIST) {
      expect(choice.shortName).toMatch(/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/);
      expect(localeOf(choice.shortName)).toBe(choice.locale);
    }
  });
});
