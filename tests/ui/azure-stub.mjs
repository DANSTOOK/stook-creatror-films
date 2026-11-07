import { createServer } from 'node:http';

/**
 * Azure AI Speech, stood in for on 127.0.0.1.
 *
 * Every voice the app has is Microsoft's now, spoken over the network, so a
 * test of the voice panel either needs a real key or needs the service stood
 * in for. This is the second: a tiny HTTP server that answers the two
 * requests the app makes - the voices list and one synthesis per piece of
 * speech - and records every one of them, so a test can read the request that
 * went out as well as judge the audio that came back.
 *
 * The audio is a tone, not speech. That is on purpose and it is the limit of
 * these tests: lengths, silences, trimming, joining, caption timings and the
 * SSML are all provable from a tone, and none of them is about the voice.
 * Whether the voice sounds right is a question only a real key answers, and
 * the panel's Check button is what asks it.
 *
 * The length is proportional to the text (`SECONDS_PER_CHAR`), the way real
 * speech is, so a long script makes a long clip and a test can say "as long
 * as the text" and mean it.
 */

/** Roughly the pace of Spanish narration: about 14 characters a second. */
export const SECONDS_PER_CHAR = 0.07;

/** The voices the stand-in says it has: the shortlist's Spanish and English ones. */
export const VOICES = [
  { ShortName: 'es-MX-DaliaNeural', DisplayName: 'Dalia', LocalName: 'Dalia', Name: 'x', Gender: 'Female', Locale: 'es-MX', LocaleName: 'Spanish (Mexico)', VoiceType: 'Neural', Status: 'GA', StyleList: ['cheerful', 'sad'] },
  { ShortName: 'es-MX-JorgeNeural', DisplayName: 'Jorge', LocalName: 'Jorge', Name: 'x', Gender: 'Male', Locale: 'es-MX', LocaleName: 'Spanish (Mexico)', VoiceType: 'Neural', Status: 'GA' },
  { ShortName: 'es-CO-SalomeNeural', DisplayName: 'Salome', LocalName: 'Salomé', Name: 'x', Gender: 'Female', Locale: 'es-CO', LocaleName: 'Spanish (Colombia)', VoiceType: 'Neural', Status: 'GA' },
  { ShortName: 'es-AR-ElenaNeural', DisplayName: 'Elena', LocalName: 'Elena', Name: 'x', Gender: 'Female', Locale: 'es-AR', LocaleName: 'Spanish (Argentina)', VoiceType: 'Neural', Status: 'GA' },
  { ShortName: 'es-ES-ElviraNeural', DisplayName: 'Elvira', LocalName: 'Elvira', Name: 'x', Gender: 'Female', Locale: 'es-ES', LocaleName: 'Spanish (Spain)', VoiceType: 'Neural', Status: 'GA', StyleList: ['cheerful'] },
  { ShortName: 'es-ES-AlvaroNeural', DisplayName: 'Alvaro', LocalName: 'Álvaro', Name: 'x', Gender: 'Male', Locale: 'es-ES', LocaleName: 'Spanish (Spain)', VoiceType: 'Neural', Status: 'GA' },
  { ShortName: 'en-US-AvaMultilingualNeural', DisplayName: 'Ava', LocalName: 'Ava', Name: 'x', Gender: 'Female', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'Neural', Status: 'GA' },
  { ShortName: 'en-US-AndrewMultilingualNeural', DisplayName: 'Andrew', LocalName: 'Andrew', Name: 'x', Gender: 'Male', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'Neural', Status: 'GA' },
  { ShortName: 'en-US-JennyNeural', DisplayName: 'Jenny', LocalName: 'Jenny', Name: 'x', Gender: 'Female', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'Neural', Status: 'GA', StyleList: ['newscast', 'cheerful'] },
  { ShortName: 'en-US-GuyNeural', DisplayName: 'Guy', LocalName: 'Guy', Name: 'x', Gender: 'Male', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'Neural', Status: 'GA' },
  { ShortName: 'en-US-AriaNeural', DisplayName: 'Aria', LocalName: 'Aria', Name: 'x', Gender: 'Female', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'Neural', Status: 'GA', StyleList: ['newscast'] },
  { ShortName: 'en-GB-RyanNeural', DisplayName: 'Ryan', LocalName: 'Ryan', Name: 'x', Gender: 'Male', Locale: 'en-GB', LocaleName: 'English (United Kingdom)', VoiceType: 'Neural', Status: 'GA' },
];

/**
 * A WAV of `seconds` of tone, 24 kHz mono 16-bit: the format the app asks
 * Azure for.
 *
 * Not a single sine: 36 harmonics over a 220 Hz fundamental, rolling off as
 * 1/sqrt(k), so there is real energy from 220 Hz to about 8 kHz. A voice has that too, and the
 * tests that measure what the finish does to a voice need it - a filter that
 * takes the top end off (the phone character, the megaphone) cannot be heard
 * in a pure sine, because a pure sine has no top end to take.
 */
export function wav(seconds) {
  const rate = 24_000;
  const samples = Math.max(1, Math.round(rate * seconds));
  const data = Buffer.alloc(samples * 2);
  const harmonics = 36;
  // The sum of the amplitudes, so it does not clip.
  let scale = 0;
  for (let k = 1; k <= harmonics; k += 1) scale += 1 / Math.sqrt(k);
  for (let i = 0; i < samples; i += 1) {
    let value = 0;
    for (let k = 1; k <= harmonics; k += 1) value += Math.sin((i / rate) * 2 * Math.PI * 220 * k) / Math.sqrt(k);
    // Loud enough not to be trimmed as silence at the ends.
    data.writeInt16LE(Math.round((value / scale) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** What the SSML of one request actually says, so a test does not have to parse it. */
export function spokenText(body) {
  const inner = /<voice[^>]*>([\s\S]*)<\/voice>/.exec(body)?.[1] ?? '';
  return inner.replace(/<[^>]+>/g, '').trim();
}

/**
 * The stand-in. `seen.voices` and `seen.synth` hold every request as
 * `{ url, headers, body }`, in the order they arrived.
 */
export function standIn(options = {}) {
  const voices = options.voices ?? VOICES;
  const seen = { voices: [], synth: [] };
  let refuseKey = false;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { url: request.url, headers: request.headers, body };
      if (refuseKey) {
        seen.voices.push(record);
        response.writeHead(401).end('Unauthorized');
        return;
      }
      if (request.url.includes('/voices/list')) {
        seen.voices.push(record);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(voices));
        return;
      }
      if (request.url.includes('/cognitiveservices/v1')) {
        seen.synth.push(record);
        // As long as what it was asked to say, so a clip is as long as its text.
        const said = spokenText(body);
        response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav(Math.max(0.35, said.length * SECONDS_PER_CHAR)));
        return;
      }
      response.writeHead(404).end();
    });
  });
  return {
    seen,
    refuse: (value) => {
      refuseKey = value;
    },
    listen: () =>
      new Promise((done) => {
        server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((done) => server.close(done)),
  };
}

/** A key the shape the app insists on, for the stand-in that accepts any. */
export const TEST_KEY = 'k'.repeat(32);

/**
 * Save a key in the running app, so the voices arrive.
 *
 * Done through the panel, the way a person does it, rather than by writing
 * the stored file: that way the test also proves the panel's own path works
 * from an app that has never had a key.
 */
export async function signIn(window, { key = TEST_KEY, region = 'eastus' } = {}) {
  await window.getByTestId('library-tab-voice').click();
  await window.getByTestId('tts-azure').waitFor({ state: 'visible', timeout: 20_000 });
  // The section is a <details>; it opens on a click of its summary.
  const open = await window.getByTestId('tts-azure-key').isVisible().catch(() => false);
  if (!open) await window.getByTestId('tts-azure').click();
  await window.getByTestId('tts-azure-key').fill(key);
  await window.getByTestId('tts-azure-region').fill(region);
  await window.getByTestId('tts-azure-save').click();
  // Saved and accepted: the panel offers to check again instead of to save.
  // Attached, not visible: the panel re-renders when the voices arrive and the
  // section folds itself, which is fine - a person would not be looking at it
  // any more either.
  await window.getByTestId('tts-azure-check').waitFor({ state: 'attached', timeout: 30_000 });
  await window.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 20_000 });
}

/** The environment an app under test needs to reach the stand-in and nothing else. */
export const azureEnv = (endpoint) => ({ SCF_AZURE_ENDPOINT: endpoint });
