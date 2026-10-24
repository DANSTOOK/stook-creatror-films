import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Text to speech, end to end in the running app, and the round trip that
 * proves both new features at once: generate Spanish and English with the
 * bundled voices, confirm each lands as an audio clip at the playhead on a new
 * track with the right duration and real (non-silent) sound, then run the
 * app's own engine (whisper-cli with the bundled captions model) over the
 * generated audio and check the words come back.
 *
 * Launch env and the blank-project start follow tests/ui/captions.mjs. The
 * engine and voices are the ones staged in build/ (SCF_TTS_DIR,
 * SCF_TTS_BUNDLED_DIR); the captions engine and bundled model likewise.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'tts');
const ttsDir = join(projectRoot, 'build', 'piper');
const voicesDir = join(projectRoot, 'build', 'tts-voices');
const whisperDir = join(projectRoot, 'build', 'whisper');
const bundledModels = join(projectRoot, 'build', 'whisper-models');
const whisperCli = join(whisperDir, 'whisper-cli.exe');
const captionsModel = join(bundledModels, 'ggml-small-q5_1.bin');

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(Boolean(passed));
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const fold = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...new Array(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= ref.length; i += 1) for (let j = 1; j <= hyp.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  return d[ref.length][hyp.length] / Math.max(1, ref.length);
}

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

async function transcribe(wav, lang) {
  const pcm = `${wav}.16k.wav`;
  await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-ar', '16000', '-ac', '1', pcm]);
  const { stdout } = await execFileAsync(whisperCli, ['-m', captionsModel, '-f', pcm, '-l', lang, '-nt', '-np', '-ng'], { maxBuffer: 1 << 24 });
  return stdout.trim();
}

/**
 * Text to speech is the library's Voice tab (components/TextToSpeech/VoicePanel);
 * the Timeline menu brings it forward.
 */
async function generate(app, window, { language, voice, text }) {
  await appMenu(window, 'Timeline', /Text to speech|Texto a voz/);
  const tts = window.getByTestId('tts-dialog');
  await tts.waitFor({ state: 'visible', timeout: 15_000 });
  await window.getByTestId('tts-language').selectOption(language);
  const card = window.getByTestId(`tts-voice-${voice}`);
  const present = await card.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (!present) return { present: false };
  await card.click();
  await window.getByTestId('tts-text').fill(text);
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
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  for (const need of [[ttsDir, 'piper'], [voicesDir, 'voices'], [whisperCli, 'whisper-cli'], [captionsModel, 'bundled captions model']]) {
    if (!existsSync(need[0])) {
      console.error(`Missing ${need[1]} at ${need[0]} - stage build/ first.`);
      process.exit(2);
    }
  }

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
      SCF_TTS_DIR: ttsDir,
      SCF_TTS_BUNDLED_DIR: voicesDir,
      SCF_TTS_VOICES_DIR: join(workDir, 'downloaded-voices'),
      SCF_WHISPER_DIR: whisperDir,
      SCF_WHISPER_BUNDLED_DIR: bundledModels,
      SCF_WHISPER_MODELS_DIR: join(workDir, 'models'),
    },
  });
  const window = await app.firstWindow();
  const pid = await app.evaluate(() => process.pid);
  const issues = [];
  window.on('console', (m) => m.type() === 'error' && issues.push(m.text()));
  window.on('pageerror', (e) => issues.push(`pageerror ${e.message}`));
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

  // Every voice the installer ships, each read back by the captions engine.
  const es = { language: 'es', text: 'Hola, esto es una prueba de la voz en español. El resultado debería ser claro.', ref: 'hola esto es una prueba de la voz en espanol el resultado deberia ser claro' };
  const en = { language: 'en', text: 'Hello, this is a test of the English voice. The result should be clear.', ref: 'hello this is a test of the english voice the result should be clear' };
  const cases = [
    ...['es-419-dora', 'es-419-alex', 'es-MX-ald', 'es-MX-claude', 'es-AR-daniela', 'es-419-santa', 'es-ES-davefx', 'es-ES-sharvard'].map((voice) => ({ ...es, voice })),
    ...['en-US-kristin', 'en-US-norman'].map((voice) => ({ ...en, voice })),
  ];

  for (const c of cases) {
    const made = await generate(app, window, c);
    const label = `${c.voice}`;
    check(`${label}: the voice is offered in the Voice tab`, made.present);
    if (!made.present) continue;
    const info = await newestAudioClip(window);
    check(`${label}: a clip landed on an audio track, the tab still there`, info && info.trackType === 'audio' && made.stays, `${made.seconds.toFixed(1)} s to make`);
    const picked = label;
    void picked;
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
      const heard = await transcribe(wav, c.language);
      const rate = wer(fold(c.ref), fold(heard));
      check(`${label}: the app's captions read the speech back (WER ${(rate * 100).toFixed(0)}%)`, rate <= 0.25, heard.slice(0, 120));
    }
  }

  check('no console errors', issues.length === 0, issues.slice(0, 2).join(' | '));

  await app.close().catch(() => undefined);
  try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* already gone */ }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
