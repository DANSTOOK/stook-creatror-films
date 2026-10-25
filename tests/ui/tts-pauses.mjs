import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Pauses in text to speech, and the new voices: `node tests/ui/tts-pauses.mjs`
 *
 *   1. the Voice tab's pause buttons write [pausa 2s] where the caret is, the
 *      mark is drawn as a chip behind its text (the copy wraps as the box
 *      does and scrolls with it), the count leaves it out and the total says
 *      how many pauses and how long;
 *   2. generated, the voice is silent there for those two seconds (measured in
 *      the WAV), and its captions follow the voice: the line after the pause
 *      starts after it;
 *   3. a pause first is silence at the clip's start; a pasted SSML
 *      <break time="1.5s"/> is a pause too;
 *   4. the new English voice Heart speaks, and the app's captions engine reads
 *      it back; a character picked for an English script takes its English
 *      voice;
 *   5. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build) and the
 * engines staged in build/. The window is never shown.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tts-pauses');
const logs = join(work, 'logs');
const shots = process.env.TTS_SHOTS ?? '';
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

/** The samples of a 16-bit PCM WAV (first channel) and its rate. */
function pcm(path) {
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
      const count = Math.floor(Math.min(size, buf.length - offset - 8) / 2 / channels);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) samples[i] = buf.readInt16LE(offset + 8 + i * 2 * channels) / 32768;
      return { samples, rate };
    }
    offset += 8 + size + (size % 2);
  }
  return { samples: new Float32Array(0), rate };
}

/** The silent stretches of a voice (RMS over 20 ms under -45 dBFS), seconds: [start, end]. */
function silences({ samples, rate }) {
  const hop = Math.round(rate * 0.02);
  const quiet = [];
  for (let at = 0; at + hop <= samples.length; at += hop) {
    let sum = 0;
    for (let i = at; i < at + hop; i += 1) sum += samples[i] * samples[i];
    quiet.push(Math.sqrt(sum / hop) < 10 ** (-45 / 20));
  }
  const spans = [];
  let start = -1;
  quiet.forEach((still, index) => {
    if (still && start < 0) start = index;
    if ((!still || index === quiet.length - 1) && start >= 0) {
      spans.push([(start * hop) / rate, ((still ? index + 1 : index) * hop) / rate]);
      start = -1;
    }
  });
  return spans;
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

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  for (const need of [ttsDir, voicesDir, whisperCli, captionsModel]) if (!existsSync(need)) throw new Error(`Missing ${need} - stage build/ first.`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const profile = join(work, 'profile');
  const app = await electron.launch({ args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')], cwd: root, env: env(profile) });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.getByTestId('app-menu-button').click();
    await window.getByRole('menuitem', { name: 'Timeline', exact: true }).click();
    await window.getByRole('menuitem', { name: /Text to speech/ }).click();
    await window.getByTestId('tts-dialog').waitFor({ state: 'visible', timeout: 15_000 });
    await window.getByTestId('tts-language').selectOption('es');
    await window.getByTestId('tts-voice-es-419-dora').click();
    const box = window.getByTestId('tts-text');

    /* 1. the pause buttons ---------------------------------------------------------------------- */
    await box.fill('Hola a todos. Empezamos ahora.');
    // The caret after "todos.", then the 2 s button.
    await box.evaluate((element) => {
      element.focus();
      element.setSelectionRange(13, 13);
    });
    await window.getByTestId('tts-pause-2').click();
    const after = await box.evaluate((element) => ({ value: element.value, caret: element.selectionStart, focused: document.activeElement === element }));
    check('the 2 s button writes [pausa 2s] at the caret, spaced from the words, the caret after it and the box still in focus',
      after.value === 'Hola a todos. [pausa 2s] Empezamos ahora.' && after.caret === 'Hola a todos. [pausa 2s] '.length && after.focused, JSON.stringify(after));
    const drawn = await window.evaluate(() => {
      const mirror = document.querySelector('[data-testid="tts-text-marks"]');
      const area = document.querySelector('[data-testid="tts-text"]');
      const marks = [...mirror.querySelectorAll('mark')].map((mark) => mark.textContent);
      const a = getComputedStyle(area);
      const m = getComputedStyle(mirror);
      const same = ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingTop', 'whiteSpace', 'overflowWrap'].every((key) => a[key] === m[key]);
      return { marks, same, widths: [area.clientWidth, mirror.clientWidth], count: document.querySelector('[data-testid="tts-text-count"]').textContent, total: document.querySelector('[data-testid="tts-pause-total"]')?.textContent ?? '' };
    });
    if (shots) await window.getByTestId('tts-dialog').screenshot({ path: join(shots, 'voz-pausas.png') });
    check('the mark is drawn as a chip behind it, in a copy that wraps exactly as the box does',
      drawn.marks.length === 1 && drawn.marks[0] === '[pausa 2s]' && drawn.same && drawn.widths[0] === drawn.widths[1], JSON.stringify(drawn));
    check('the count leaves the mark out, and the total says one pause of 2 s',
      Number(drawn.count) === 'Hola a todos. Empezamos ahora.'.length && /1 pause · 2 s/.test(drawn.total), `${drawn.count}; ${drawn.total}`);
    // A long script: the copy scrolls with the box.
    await box.fill(`${'Una línea más del guion, para que el cuadro tenga que desplazarse. [pausa 1s] '.repeat(14)}Fin.`);
    await box.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await sleep(200);
    const scrolled = await window.evaluate(() => {
      const area = document.querySelector('[data-testid="tts-text"]');
      const mirror = document.querySelector('[data-testid="tts-text-marks"]');
      return { area: area.scrollTop, mirror: mirror.scrollTop, overflow: area.scrollHeight > area.clientHeight, widths: [area.clientWidth, mirror.clientWidth], marks: mirror.querySelectorAll('mark').length };
    });
    if (shots) await window.getByTestId('tts-dialog').screenshot({ path: join(shots, 'voz-pausas-largo.png') });
    check('with a long script the copy scrolls with the box, the same width, every mark a chip', scrolled.overflow && scrolled.area > 0 && Math.abs(scrolled.area - scrolled.mirror) <= 1 && scrolled.widths[0] === scrolled.widths[1] && scrolled.marks === 14, JSON.stringify(scrolled));

    /* 2. generated: silent for those two seconds, captions after it ----------------------------- */
    const generate = async (text, { captions = false } = {}) => {
      await box.fill(text);
      const wantCaptions = await window.getByTestId('tts-captions').isChecked();
      if (wantCaptions !== captions) await window.getByTestId('tts-captions').click();
      const before = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
      await window.getByTestId('tts-generate').click();
      await window.getByTestId('tts-cancel').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
      await window.waitForFunction(() => document.querySelector('[data-testid="tts-generate"]') !== null, null, { timeout: 300_000 });
      await sleep(500);
      return window.evaluate(([n]) => {
        const state = window.__scfStore.getState();
        if (Object.keys(state.project.clips).length <= n) return null;
        const byUri = new Map(state.assets.map((asset) => [asset.uri, asset]));
        const clips = Object.values(state.project.clips);
        const audio = clips.filter((clip) => byUri.get(clip.sourceUri)?.kind === 'audio').sort((a, b) => a.id.localeCompare(b.id));
        const newest = state.ui.selectedClipIds.map((id) => state.project.clips[id]).find(Boolean) ?? audio[audio.length - 1];
        const captionsTrack = state.project.tracks.filter((track) => track.type === 'captions').pop();
        const lines = clips.filter((clip) => clip.trackId === captionsTrack?.id && clip.caption).sort((a, b) => a.startFrame - b.startFrame).map((clip) => ({ start: clip.startFrame / state.project.fps, end: (clip.startFrame + clip.durationFrames) / state.project.fps, text: clip.caption.text }));
        return { path: byUri.get(newest.sourceUri)?.sourcePath ?? '', start: newest.startFrame / state.project.fps, name: byUri.get(newest.sourceUri)?.name ?? '', lines };
      }, [before]);
    };
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(0));
    const spoken = await generate('Hola a todos. [pausa 2s] Empezamos ahora.', { captions: true });
    const gaps = spoken?.path ? silences(pcm(spoken.path)) : [];
    const inner = gaps.filter(([start, end]) => start > 0.2 && end < (spoken ? pcm(spoken.path).samples.length / pcm(spoken.path).rate - 0.2 : 0));
    const longest = inner.reduce((best, span) => (span[1] - span[0] > best[1] - best[0] ? span : best), [0, 0]);
    check('generated, the voice is silent there for the two seconds asked (within a tenth)', spoken !== null && Math.abs(longest[1] - longest[0] - 2) <= 0.12, `${(longest[1] - longest[0]).toFixed(2)} s, from ${longest[0].toFixed(2)} s`);
    check('and the clip is named by its words, not the mark', spoken !== null && !/pausa/.test(spoken.name) && /Hola a todos/.test(spoken.name), spoken?.name ?? '');
    const lines = spoken?.lines ?? [];
    check('its captions follow the voice: the line after the pause starts after it, the one before ends before it',
      lines.length === 2 && lines[0].end <= spoken.start + longest[0] + 0.15 && lines[1].start >= spoken.start + longest[1] - 0.15 && /Empezamos/.test(lines[1].text) && !/pausa/.test(lines.map((line) => line.text).join(' ')),
      lines.map((line) => `${line.start.toFixed(2)}-${line.end.toFixed(2)} ${line.text}`).join(' | '));

    /* 3. a pause first; an SSML break --------------------------------------------------------- */
    const first = await generate('[pausa 1s] Hola otra vez.');
    const firstGaps = first?.path ? silences(pcm(first.path)) : [];
    check('a pause first is a second of silence at the clip’s start', firstGaps.length > 0 && firstGaps[0][0] === 0 && Math.abs(firstGaps[0][1] - 1) <= 0.1, firstGaps[0] ? `${firstGaps[0][1].toFixed(2)} s` : 'none');
    const ssml = await generate('Uno, dos y tres. <break time="1.5s"/> Cuatro, cinco y seis.');
    const ssmlGaps = ssml?.path ? silences(pcm(ssml.path)).filter(([start]) => start > 0.2) : [];
    const ssmlLongest = ssmlGaps.reduce((best, span) => Math.max(best, span[1] - span[0]), 0);
    check('a pasted <break time="1.5s"/> is a pause of a second and a half', Math.abs(ssmlLongest - 1.5) <= 0.12, `${ssmlLongest.toFixed(2)} s`);

    /* 4. the new English voices ----------------------------------------------------------------- */
    await window.getByTestId('tts-language').selectOption('en');
    const offered = await window.evaluate(() => ['en-US-heart', 'en-US-bella', 'en-US-michael', 'en-US-fenrir', 'en-GB-emma', 'en-GB-george'].filter((id) => document.querySelector(`[data-testid="tts-voice-${id}"]`)));
    check('six natural English voices are offered: Heart, Bella, Michael, Fenrir, Emma and George', offered.length === 6, offered.join(', '));
    await window.getByTestId('tts-voice-en-US-heart').click();
    const heart = await generate('Hello there. [pause 1s] This is Heart, the new English voice.');
    let heard = '';
    if (heart?.path) {
      const mono = join(work, 'heart.16k.wav');
      await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', heart.path, '-ar', '16000', '-ac', '1', mono]);
      heard = (await execFileAsync(whisperCli, ['-m', captionsModel, '-f', mono, '-l', 'en', '-nt', '-np', '-ng'], { maxBuffer: 1 << 24 })).stdout.trim();
    }
    check('Heart speaks it, and the captions engine reads it back', /hello there/i.test(heard) && /new english voice/i.test(heard), heard.slice(0, 120));
    await window.getByTestId('tts-character-narrator').click();
    const narrator = await window.evaluate(() => document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('data-testid') ?? '');
    check('with the script in English, the narrator character takes its English voice (Michael)', narrator === 'tts-voice-en-US-michael', narrator);

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
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
