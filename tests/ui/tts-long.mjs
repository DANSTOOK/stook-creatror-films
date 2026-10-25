import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Long text to speech, in the running app: `node tests/ui/tts-long.mjs`
 *
 * What failed for the user: a long text, spoken by Kokoro, stopped at its
 * tenth piece with "Failed to create ...\9.wav" - another copy of the app had
 * started meanwhile, and on starting it emptied the shared temp folder, the
 * running job's folder with it.
 *
 *   1. a long Spanish text (about 1,800 characters) with Kokoro, and a second
 *      copy of the app started and closed halfway through: the clip still
 *      lands, as long as the text, with no error;
 *   2. a pasted paragraph of thousands of characters and no full stop, with a
 *      quick Piper voice: it lands too, and its first words are heard (the
 *      app's own captions engine reads them back);
 *   3. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build) and the
 * engines staged in build/. The windows are never shown.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tts-long');
const logs = join(work, 'logs');
const ttsDir = join(root, 'build', 'piper');
const voicesDir = join(root, 'build', 'tts-voices');
const whisperDir = join(root, 'build', 'whisper');
const bundledModels = join(root, 'build', 'whisper-models');
const whisperCli = join(whisperDir, 'whisper-cli.exe');
const captionsModel = join(bundledModels, 'ggml-small-q5_1.bin');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(Boolean(passed));
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const fold = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Seconds and peak of a 16-bit PCM WAV, read by its chunks. */
function wavInfo(path) {
  const buf = readFileSync(path);
  let offset = 12;
  let rate = 48000;
  let channels = 1;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
    }
    if (id === 'data') {
      let peak = 0;
      for (let at = offset + 8; at + 1 < offset + 8 + size && at + 1 < buf.length; at += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(at)));
      return { seconds: size / 2 / channels / rate, peak };
    }
    offset += 8 + size + (size % 2);
  }
  return { seconds: 0, peak: 0 };
}

const env = (profile) => ({
  ...process.env,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  ELECTRON_RUN_AS_NODE: undefined,
  SCF_BACKGROUND: '1',
  SCF_SKIP_HOME: '1',
  SCF_NO_CLOSE_PROMPT: '1',
  SCF_LOG_DIR: logs,
  SCF_TTS_DIR: ttsDir,
  SCF_TTS_BUNDLED_DIR: voicesDir,
  SCF_TTS_VOICES_DIR: join(profile, 'downloaded-voices'),
  SCF_WHISPER_DIR: whisperDir,
  SCF_WHISPER_BUNDLED_DIR: bundledModels,
  SCF_WHISPER_MODELS_DIR: join(profile, 'models'),
});

const launch = (name) => {
  const profile = join(work, name);
  return electron.launch({ args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')], cwd: root, env: env(profile) });
};

const kill = (pid) => {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // Already gone.
  }
};

const LONG_SPANISH = [
  'Hace muchos años, en un pueblo pequeño entre montañas, vivía una mujer que fabricaba relojes.',
  'Cada mañana abría su taller antes de que saliera el sol, encendía una lámpara de aceite y se sentaba frente a una mesa llena de engranajes diminutos.',
  'Los vecinos decían que sus relojes nunca se atrasaban, ni siquiera en el invierno más frío, cuando el hielo cubría los caminos y nadie salía de casa.',
  'Un día llegó un viajero con un reloj de bolsillo roto. Lo había heredado de su abuelo y quería saber si todavía tenía arreglo.',
  'La relojera lo abrió con cuidado, miró cada pieza con su lupa y sonrió: el mecanismo estaba intacto, solo faltaba un resorte.',
  'Durante tres días trabajó en él sin descanso. Probó resortes de distintos tamaños, ajustó el volante y limpió cada rueda con un pincel muy fino.',
  'Cuando por fin el reloj volvió a sonar, el viajero no pudo contener la emoción. Le preguntó cuánto le debía, y ella respondió que nada.',
  'Le pidió solamente que, cada vez que mirara la hora, recordara que las cosas que parecen perdidas a veces solo esperan a alguien con paciencia.',
  'El viajero siguió su camino, pero nunca olvidó aquel taller. Años después volvió al pueblo con sus hijos para mostrarles dónde había aprendido esa lección.',
  'El taller seguía abierto. Ahora lo atendía una joven aprendiz, que había heredado la misma paciencia y la misma lámpara de aceite.',
  'Y así, de generación en generación, el pueblo siguió midiendo su tiempo con relojes que nunca se atrasaban, hechos a mano, uno por uno.',
].join(' ');

async function appMenu(window, menu, item) {
  await window.getByTestId('app-menu-button').click();
  await window.getByRole('menuitem', { name: menu, exact: true }).click();
  await window.getByRole('menuitem', { name: item }).click();
  await window.waitForTimeout(250);
}

/** Write `text` in the Voice tab, pick `voice` and Generate; resolves when the clip lands (or with the error shown). */
async function startGenerate(window, { language, voice, text }) {
  await appMenu(window, 'Timeline', /Text to speech|Texto a voz/);
  await window.getByTestId('tts-dialog').waitFor({ state: 'visible', timeout: 15_000 });
  await window.getByTestId('tts-language').selectOption(language);
  await window.getByTestId(`tts-voice-${voice}`).click();
  await window.getByTestId('tts-text').fill(text);
  const before = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
  await window.getByTestId('tts-generate').click();
  await window.getByTestId('tts-cancel').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  return before;
}

/** Until the job ends - the clip in, or Generate back without one (a failure) - and whether the clip came. */
const finished = async (window, before, timeout) => {
  await window.waitForFunction(() => document.querySelector('[data-testid="tts-generate"]') !== null, null, { timeout }).catch(() => undefined);
  await sleep(500);
  return window.evaluate((n) => Object.keys(window.__scfStore.getState().project.clips).length > n, before);
};

/** The newest audio clip's file and length. */
const newestAudio = (window) =>
  window.evaluate(() => {
    const state = window.__scfStore.getState();
    const byUri = new Map(state.assets.map((asset) => [asset.uri, asset]));
    const audio = Object.values(state.project.clips).filter((clip) => byUri.get(clip.sourceUri)?.kind === 'audio');
    const clip = audio[audio.length - 1];
    const asset = clip ? byUri.get(clip.sourceUri) : null;
    return clip ? { path: asset?.sourcePath ?? '', frames: clip.durationFrames, fps: state.project.fps } : null;
  });

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  for (const need of [ttsDir, voicesDir, whisperCli, captionsModel]) if (!existsSync(need)) throw new Error(`Missing ${need} - stage build/ first.`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const app = await launch('profile');
  const pid = app.process().pid;
  const issues = [];
  let second = null;
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    /* 1. Kokoro, a long text, another copy of the app started halfway ---------------------------- */
    const started = Date.now();
    const before = await startGenerate(window, { language: 'es', voice: 'es-419-dora', text: LONG_SPANISH });
    // Halfway: once a few pieces are in (the Cancel button shows the share done).
    await window.waitForFunction(() => /\b([2-9]\d)%/.test(document.querySelector('[data-testid="tts-cancel"]')?.textContent ?? ''), null, { timeout: 240_000 }).catch(() => undefined);
    const shareAtSecond = (await window.getByTestId('tts-cancel').textContent().catch(() => '')) ?? '';
    second = await launch('second-profile');
    const secondWindow = await second.firstWindow();
    await secondWindow.waitForSelector('[data-testid="preview-panel"]', { timeout: 60_000 }).catch(() => undefined);
    await sleep(1500);
    const secondPid = second.process().pid;
    await second.close().catch(() => undefined);
    kill(secondPid);
    second = null;
    const done = await finished(window, before, 600_000);
    const seconds = (Date.now() - started) / 1000;
    const notices = await window.evaluate(() => [...document.querySelectorAll('[role="alert"], [role="status"]')].map((element) => element.textContent ?? '').join(' | '));
    const first = done ? await newestAudio(window) : null;
    const firstWav = first?.path && existsSync(first.path) ? wavInfo(first.path) : { seconds: 0, peak: 0 };
    check(`a long text (${LONG_SPANISH.length} characters) with Kokoro, another copy of the app started at ${shareAtSecond.replace(/\D+/g, ' ').trim() || '?'}%: the clip lands`,
      done && !/Failed|No se pudo|could not/i.test(notices), `${seconds.toFixed(0)} s; ${notices.slice(0, 200)}`);
    // About 13 characters a second, read at speed 1: well over a minute.
    check('as long as the text, and not silent', firstWav.seconds > 80 && firstWav.peak > 3000 && Math.abs(first.frames / first.fps - firstWav.seconds) < 0.2, `${firstWav.seconds.toFixed(1)} s, peak ${firstWav.peak}`);

    /* 2. Piper, thousands of characters and no full stop ----------------------------------------- */
    const words = 'esta frase sigue y sigue sin ningún punto porque la persona pegó un párrafo entero copiado de un documento';
    const run = Array.from({ length: 36 }, () => words).join(' ');
    const before2 = await startGenerate(window, { language: 'es', voice: 'es-MX-claude', text: run });
    const done2 = await finished(window, before2, 600_000);
    const second2 = done2 ? await newestAudio(window) : null;
    const wav2 = second2?.path && existsSync(second2.path) ? wavInfo(second2.path) : { seconds: 0, peak: 0 };
    check(`a paragraph of ${run.length} characters with no full stop, with Piper: the clip lands, long and not silent`, done2 && wav2.seconds > 120 && wav2.peak > 3000, `${wav2.seconds.toFixed(1)} s, peak ${wav2.peak}`);
    if (done2 && second2?.path) {
      const head = join(work, 'head.wav');
      await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', second2.path, '-t', '12', '-ar', '16000', '-ac', '1', head]);
      const { stdout } = await execFileAsync(whisperCli, ['-m', captionsModel, '-f', head, '-l', 'es', '-nt', '-np', '-ng'], { maxBuffer: 1 << 24 });
      const heard = fold(stdout);
      const expected = new Set(fold(words));
      const known = heard.filter((word) => expected.has(word)).length;
      check('its first words are heard: the captions engine reads them back', heard.length >= 8 && known / heard.length >= 0.7, `${known}/${heard.length}: ${stdout.trim().slice(0, 120)}`);
    } else {
      check('its first words are heard: the captions engine reads them back', false, 'no clip');
    }

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    if (second) {
      const secondPid = second.process().pid;
      await second.close().catch(() => undefined);
      kill(secondPid);
    }
    await app.close().catch(() => undefined);
    kill(pid);
  }
  const errors = existsSync(logs)
    ? readdirSync(logs).flatMap((name) => readFileSync(join(logs, name), 'utf8').split('\n')).filter((line) => / ERROR /.test(line))
    : [];
  check('nothing in the app\'s log', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
