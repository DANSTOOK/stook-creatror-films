import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { signIn, standIn, spokenText } from './azure-stub.mjs';

/**
 * Every voice the app offers, end to end in the running app:
 * `node tests/ui/tts.mjs`
 *
 * For each one: it is offered in the Voice tab, it speaks, the clip lands as
 * an audio clip at the playhead with a length that matches its audio, the WAV
 * is on disk and is not silence - and the request that made it named that
 * voice and its own locale.
 *
 * Azure is stood in for on 127.0.0.1 (SCF_AZURE_ENDPOINT), so this runs with
 * no key and no network.
 *
 * This test used to generate with the eight Piper and Kokoro voices in the
 * installer and then read each one back with the app's own captions engine, a
 * word-error rate per voice. That check is gone with those engines, and it is
 * worth being plain about what went with it: nothing here listens to a voice
 * any more. What replaced it is narrower and certain - the voice asked for is
 * the voice in the request - and the one thing it cannot tell you is how
 * Microsoft's voice sounds. A real key says that, through the panel's Check
 * button and a sentence of Dalia.
 */

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'tts');

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(Boolean(passed));
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Peak absolute amplitude of a mono 16-bit WAV: proves it is not silence. */
function wavPeak(path) {
  const buf = readFileSync(path);
  let peak = 0;
  for (let o = 44; o + 1 < buf.length; o += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(o)));
  const seconds = (buf.length - 44) / 2 / buf.readUInt32LE(24);
  return { peak, seconds };
}

async function appMenu(window, menu, item) {
  await window.getByTestId('app-menu-button').click();
  await window.getByRole('menuitem', { name: menu, exact: true }).click();
  await window.getByRole('menuitem', { name: item }).click();
  await window.waitForTimeout(250);
}

/**
 * Text to speech is the library's Voice tab (components/TextToSpeech/VoicePanel);
 * the Timeline menu brings it forward.
 */
async function generate(window, { language, voice, text }) {
  await appMenu(window, 'Timeline', /Text to speech|Texto a voz/);
  const tts = window.getByTestId('tts-dialog');
  await tts.waitFor({ state: 'visible', timeout: 15_000 });
  // The script comes first: step two is folded until there is something to
  // say, and folds itself again once a voice is chosen - so it is opened the
  // way a person opens it, by its heading.
  // Step one folds once something has been made, so on a second pass it is
  // reopened before the next script is typed.
  if (!(await window.getByTestId('tts-text').isVisible().catch(() => false))) {
    await window.getByTestId('tts-step-1').click();
    await window.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 10_000 });
  }
  await window.getByTestId('tts-text').fill(text);
  await window.getByTestId('tts-step-2').click();
  await window.getByTestId('tts-more-voices').waitFor({ state: 'visible', timeout: 10_000 });
  await window.getByTestId('tts-more-voices').click();
  await window.getByTestId('tts-language').selectOption(language);
  const card = window.getByTestId(`tts-voice-${voice}`);
  const present = await card.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (!present) return { present: false };
  await card.click();
  const before = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
  const started = Date.now();
  await window.getByTestId('tts-generate').click();
  // The clip landing is the signal; the tab stays for the next line.
  await window.waitForFunction((n) => Object.keys(window.__scfStore.getState().project.clips).length > n, before, { timeout: 120_000 });
  const seconds = (Date.now() - started) / 1000;
  await window.waitForFunction(() => document.querySelector('[data-testid="tts-generate"]') !== null, null, { timeout: 30_000 });
  return { present: true, seconds, stays: (await tts.count()) === 1 };
}

/** The newest audio clip and its asset's file on disk. */
const newestAudioClip = (window) =>
  window.evaluate(() => {
    const state = window.__scfStore.getState();
    const assetsByUri = new Map(state.assets.map((a) => [a.uri, a]));
    const clips = Object.values(state.project.clips);
    const audio = clips.filter((c) => assetsByUri.get(c.sourceUri)?.kind === 'audio');
    if (audio.length === 0) return null;
    const clip = audio[audio.length - 1];
    const asset = assetsByUri.get(clip.sourceUri);
    const track = state.project.tracks.find((t) => t.id === clip.trackId);
    return { start: clip.startFrame, duration: clip.durationFrames, playhead: state.project.currentFrame, trackType: track?.type, sourcePath: asset?.sourcePath ?? '', assetSeconds: asset?.durationSeconds ?? 0 };
  });

async function main() {
  if (!existsSync(join(projectRoot, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const azure = standIn();
  const endpoint = await azure.listen();

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_AZURE_ENDPOINT: endpoint,
    },
  });
  const window = await app.firstWindow();
  const pid = await app.evaluate(() => process.pid);
  const issues = [];
  window.on('console', (m) => m.type() === 'error' && issues.push(m.text()));
  window.on('pageerror', (e) => issues.push(`pageerror ${e.message}`));
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
  // A key first: there are no voices without one.
  await signIn(window);

  const es = { language: 'es', text: 'Hola, esto es una prueba de la voz en español. El resultado debería ser claro.' };
  const en = { language: 'en', text: 'Hello, this is a test of the English voice. The result should be clear.' };
  const cases = [
    ...['es-MX-DaliaNeural', 'es-MX-JorgeNeural', 'es-CO-SalomeNeural', 'es-AR-ElenaNeural', 'es-ES-ElviraNeural', 'es-ES-AlvaroNeural'].map((voice) => ({ ...es, voice })),
    ...['en-US-AvaMultilingualNeural', 'en-US-AndrewMultilingualNeural', 'en-US-JennyNeural', 'en-US-GuyNeural', 'en-US-AriaNeural', 'en-GB-RyanNeural'].map((voice) => ({ ...en, voice })),
  ];

  for (const c of cases) {
    const askedBefore = azure.seen.synth.length;
    const made = await generate(window, c);
    const label = `${c.voice}`;
    check(`${label}: the voice is offered in the Voice tab`, made.present);
    if (!made.present) continue;
    const info = await newestAudioClip(window);
    check(`${label}: a clip landed on an audio track, the tab still there`, info && info.trackType === 'audio' && made.stays, `${made.seconds.toFixed(1)} s to make`);
    check(`${label}: the clip is at the playhead`, info && Math.abs(info.start - info.playhead) <= 1, info ? `start ${info.start} vs playhead ${info.playhead}` : 'no clip');
    const fpsGuess = info ? info.duration / Math.max(0.01, info.assetSeconds) : 0;
    check(`${label}: the clip's length matches the audio`, info && info.duration > 0 && Math.abs(fpsGuess - Math.round(fpsGuess)) < 0.2, info ? `${info.duration}f for ${info.assetSeconds.toFixed(2)}s` : '');

    const wav = info?.sourcePath;
    const onDisk = wav && existsSync(wav);
    check(`${label}: the generated WAV exists`, onDisk, wav);
    if (onDisk) {
      const { peak, seconds } = wavPeak(wav);
      check(`${label}: the audio is not silent`, peak > 1000, `peak ${peak}`);
      check(`${label}: the audio is at least a couple of seconds`, seconds > 2, `${seconds.toFixed(2)}s`);
    }

    // What was actually asked for: this voice, its own locale, and the words
    // of the script - nothing of the panel's own leaking into the speech.
    const sent = azure.seen.synth.slice(askedBefore);
    const locale = c.voice.slice(0, 5);
    check(
      `${label}: the request named this voice and spoke ${locale}`,
      sent.length > 0 && sent.every((one) => one.body.includes(`<voice name="${c.voice}">`) && one.body.includes(`xml:lang="${locale}"`)),
      `${sent.length} requests`,
    );
    const said = sent.map((one) => spokenText(one.body)).join(' ');
    check(`${label}: it was asked to say the script, and only that`, said.replace(/\s+/g, ' ').length > 20 && !/\[pausa|\[pause|<|>/.test(said), said.slice(0, 60));
  }

  check('no console errors', issues.length === 0, issues.slice(0, 2).join(' | '));

  await app.close().catch(() => undefined);
  await azure.close().catch(() => undefined);
  try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* already gone */ }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
