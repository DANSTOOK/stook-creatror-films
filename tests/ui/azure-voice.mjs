import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Azure's voices, in the running app: `node tests/ui/azure-voice.mjs`
 *
 * Azure is stood in for on 127.0.0.1 (SCF_AZURE_ENDPOINT), so this runs with
 * no key, no account and no network - and so that the request the app sends
 * can be read. That is the point of it: the SSML and the headers are checked
 * against what Microsoft's documentation says they must be, which is the one
 * thing no unit test of ours can prove about a format a remote service
 * parses.
 *
 * What it does NOT prove is that the real Azure accepts the document. Only
 * a real key does that, and the panel's Check button is what a person uses
 * for it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'azure-voice');
const ttsDir = join(root, 'build', 'piper');
const voicesDir = join(root, 'build', 'tts-voices');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** The two Spanish voices the shortlist starts with, as Azure's list describes them. */
const VOICES = [
  { ShortName: 'es-MX-DaliaNeural', DisplayName: 'Dalia', LocalName: 'Dalia', Name: 'x', Gender: 'Female', Locale: 'es-MX', LocaleName: 'Spanish (Mexico)', VoiceType: 'Neural', Status: 'GA', StyleList: ['cheerful', 'sad'] },
  { ShortName: 'es-MX-JorgeNeural', DisplayName: 'Jorge', LocalName: 'Jorge', Name: 'x', Gender: 'Male', Locale: 'es-MX', LocaleName: 'Spanish (Mexico)', VoiceType: 'Neural', Status: 'GA' },
];

/** A WAV of `seconds` of a quiet tone, 24 kHz mono 16-bit: what Azure returns. */
function wav(seconds) {
  const rate = 24_000;
  const samples = Math.round(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // Audible enough not to be trimmed as silence at the ends.
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 12000), i * 2);
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

/** Azure's stand-in: records every request and answers as the service does. */
function standIn() {
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
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(VOICES));
        return;
      }
      if (request.url.includes('/cognitiveservices/v1')) {
        seen.synth.push(record);
        // A second of audio per piece, so the finished length is countable.
        response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav(1));
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

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const azure = standIn();
  const endpoint = await azure.listen();
  console.log(`   Azure stood in for at ${endpoint}`);

  /*
   * First, with no local engine at all - which is what a build without Piper
   * and Kokoro looks like. The panel has nothing to offer from this computer,
   * and the one thing it must still do is let a person reach Azure. It used
   * not to: it showed an empty state and stopped there.
   */
  console.log('0. with no voice on this computer, Azure is still reachable');
  const bare = await electron.launch({
    args: [`--user-data-dir=${join(work, `bare-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_AZURE_ENDPOINT: endpoint,
      // Pointed at a folder with no engine in it, so none is found.
      SCF_TTS_DIR: join(work, 'nothing'),
    },
  });
  const barePid = bare.process().pid;
  try {
    const bareWindow = await bare.firstWindow();
    await bareWindow.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await bareWindow.getByTestId('library-tab-voice').click();
    await bareWindow.getByTestId('tts-unavailable').waitFor({ state: 'visible', timeout: 15_000 });
    const reachable = await bareWindow
      .getByTestId('tts-azure')
      .isVisible()
      .catch(() => false);
    check('the Azure section is there even with no engine installed', reachable);
    if (reachable) {
      await bareWindow.getByTestId('tts-azure').click();
      check('and its key box can be typed into', await bareWindow.getByTestId('tts-azure-key').isVisible());
    }
  } finally {
    await bare.close().catch(() => undefined);
    try { execFileSync('taskkill', ['/pid', String(barePid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_AZURE_ENDPOINT: endpoint,
      SCF_TTS_DIR: ttsDir,
      SCF_TTS_BUNDLED_DIR: voicesDir,
      SCF_TTS_VOICES_DIR: join(work, 'voices'),
    },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.getByTestId('library-tab-voice').click();
    await window.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 15_000 });

    console.log('1. with no key, the app says so and asks for nothing else');
    await window.getByTestId('tts-azure').click();
    await window.getByTestId('tts-azure-state').waitFor({ state: 'visible', timeout: 5_000 });
    check('it says there is no key', (await window.getByTestId('tts-azure-state').textContent()).length > 0);
    check('saving is refused until both boxes are filled', await window.getByTestId('tts-azure-save').isDisabled());
    const azureVoicesBefore = await window.evaluate(() =>
      document.querySelectorAll('[data-testid^="tts-voice-es-MX-"][data-testid$="Neural"]').length,
    );
    check('and no Azure voice is in the list', azureVoicesBefore === 0, `${azureVoicesBefore} shown`);

    console.log('2. a key Azure refuses is not kept');
    azure.refuse(true);
    await window.getByTestId('tts-azure-key').fill('k'.repeat(32));
    await window.getByTestId('tts-azure-region').fill('eastus');
    await window.getByTestId('tts-azure-save').click();
    await sleep(1200);
    const stillAsking = await window.getByTestId('tts-azure-key').isVisible().catch(() => false);
    check('the key box is still there, so the key was not stored', stillAsking);

    console.log('3. a key that works brings the voices in');
    azure.refuse(false);
    await window.getByTestId('tts-azure-key').fill('k'.repeat(32));
    await window.getByTestId('tts-azure-region').fill('eastus');
    await window.getByTestId('tts-azure-save').click();
    await window.getByTestId('tts-azure-check').waitFor({ state: 'visible', timeout: 10_000 });
    check('the key was asked about with the header Azure documents', azure.seen.voices.some((one) => one.headers['ocp-apim-subscription-key'] === 'k'.repeat(32)));
    check('the voices list was asked for by GET with no body', azure.seen.voices.every((one) => one.body === ''));

    // The voice step folds away until there is something to say, so the script
    // is written first - which is the order a person works in anyway.
    await window.getByTestId('tts-text').fill('Primera frase. [pausa 2s] Segunda frase.');
    // Step two folds itself once a voice is chosen, which happens on its own,
    // so it is opened the way a person opens it: by its heading.
    await window.getByTestId('tts-step-2').click();
    await window.getByTestId('tts-more-voices').waitFor({ state: 'visible', timeout: 10_000 });
    await window.getByTestId('tts-more-voices').click();
    // A fresh profile may be in English, which lists the English voices; the
    // Azure voices under test are the Spanish ones.
    await window.getByTestId('tts-language').selectOption('es');
    await window.getByTestId('tts-voice-es-MX-DaliaNeural').waitFor({ state: 'visible', timeout: 10_000 });
    check('Dalia is offered', true);
    const jorge = await window.getByTestId('tts-voice-es-MX-JorgeNeural').isVisible();
    check('and Jorge', jorge);

    console.log('4. only the voice that has styles offers them');
    await window.getByTestId('tts-voice-es-MX-DaliaNeural').click();
    await sleep(300);
    const daliaStyles = await window.getByTestId('tts-azure-style').isVisible().catch(() => false);
    check('Dalia, which Azure says has styles, shows them', daliaStyles);
    await window.getByTestId('tts-voice-es-MX-JorgeNeural').click();
    await sleep(300);
    const jorgeStyles = await window.getByTestId('tts-azure-style').isVisible().catch(() => false);
    check('Jorge, which has none, shows no style list', !jorgeStyles);

    console.log('5. it speaks a script, and the pause in it is real silence');
    await window.getByTestId('tts-voice-es-MX-DaliaNeural').click();
    await window.getByTestId('tts-azure-style').selectOption('cheerful');
    const before = azure.seen.synth.length;
    await window.getByTestId('tts-generate').click();
    const spoke = await window
      .waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length > 0, null, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    check('a clip reached the timeline', spoke);
    if (!spoke) throw new Error('nothing was made');

    const sent = azure.seen.synth.slice(before);
    check('it asked Azure once per piece of speech, not once for the whole script', sent.length >= 2, `${sent.length} requests`);

    console.log('6. the request is exactly what the documentation says');
    const one = sent[0];
    check('POST to /cognitiveservices/v1', one.url.includes('/cognitiveservices/v1'));
    check('Content-Type is application/ssml+xml', one.headers['content-type'] === 'application/ssml+xml');
    check('the output format is a RIFF WAV', one.headers['x-microsoft-outputformat'] === 'riff-24khz-16bit-mono-pcm');
    check('a User-Agent is sent, under 255 characters', Boolean(one.headers['user-agent']) && one.headers['user-agent'].length < 255);
    check('the key is in Ocp-Apim-Subscription-Key', one.headers['ocp-apim-subscription-key'] === 'k'.repeat(32));

    check('the document declares the synthesis namespace', one.body.includes('xmlns="http://www.w3.org/2001/10/synthesis"'));
    check('it speaks Spanish, from the voice', one.body.includes('xml:lang="es-MX"'));
    check('it names the voice chosen', one.body.includes('<voice name="es-MX-DaliaNeural">'));
    check('the style is applied, with the mstts namespace it needs', one.body.includes('xmlns:mstts="http://www.w3.org/2001/mstts"') && one.body.includes('<mstts:express-as style="cheerful">'));
    // The pause is the app's own silence, not a <break>: that is a deliberate
    // choice, because a measured length beats a reported one.
    check('the pause is NOT sent to Azure as a break', !sent.some((request) => request.body.includes('<break')));
    check('no mark from the script was read aloud', !sent.some((request) => request.body.includes('[pausa')));

    console.log('7. the finished clip is as long as the pieces plus the pause');
    const made = await window.evaluate(() => {
      const state = window.__scfStore.getState();
      const clip = Object.values(state.project.clips)[0];
      return { seconds: clip.durationFrames / state.project.fps, fps: state.project.fps };
    });
    // Two pieces of a second each, plus the two-second pause written in the
    // script: about four seconds, less whatever the ends were trimmed by.
    check('about four seconds of audio', made.seconds > 3.4 && made.seconds < 4.6, `${made.seconds.toFixed(2)}s`);

    console.log('8. an escaped script is not refused');
    // The script step folds once something has been made, so it is reopened
    // by its heading to type the next line.
    await window.getByTestId('tts-step-1').click();
    await window.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 10_000 });
    await window.getByTestId('tts-text').fill('Tom & Jerry dijo "hola" <ahora>');
    const beforeEscape = azure.seen.synth.length;
    await window.getByTestId('tts-generate').click();
    await sleep(4000);
    const escaped = azure.seen.synth.slice(beforeEscape);
    check('the ampersand and the brackets went out as entities', escaped.some((one) => one.body.includes('Tom &amp; Jerry') && one.body.includes('&lt;ahora&gt;')), `${escaped.length} requests`);
    check('and nothing closed the document early', escaped.every((one) => [...one.body.matchAll(/<voice /g)].length === 1));

    console.log('9. forgetting the key takes the voices away again');
    await window.getByTestId('tts-azure-forget').click();
    await window.getByTestId('tts-azure-key').waitFor({ state: 'visible', timeout: 10_000 });
    const gone = await window.getByTestId('tts-voice-es-MX-DaliaNeural').isVisible().catch(() => false);
    check('Dalia is no longer offered', !gone);

    check('nothing in the console', issues.length === 0, issues.slice(0, 2).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    await azure.close().catch(() => undefined);
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
