import { execFile } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Captions, phase 1, in the running app: `npm run test:captions:ui`
 *
 * A Spanish recording with a known text and known word times (made on this
 * computer by tests/bench/captions-tts.ps1, with a Windows voice - so it is
 * synthetic: clean, no noise, one voice) is put on the timeline and
 * transcribed by the real engine, with both models. Then:
 *
 *   1. the dialog: its fields, its defaults, what it says about privacy;
 *   2. the job: progress, the editor usable meanwhile, one undo step, and
 *      nothing left behind - no process, no temporary sound;
 *   3. accuracy: word error rate against the known text, and caption starts
 *      against the known word times;
 *   4. the rules: 42 characters, two lines, 5/6 s to 7 s, 2-frame gaps,
 *      17 characters a second, no line ending on an article;
 *   5. cancelling;
 *   6. the picture: the caption is drawn, where captions go, and the viewer
 *      and the export's frame are identical;
 *   7. editing: the Caption tab, the razor between words, trim, move, undo;
 *   8. files: .srt and .vtt out, in again, out again - identical;
 *   9. export: burnt in or not, and the file beside the video;
 *  10. the same in Spanish;
 *  11. models: the permission prompt, declining, import from a file, a
 *      wrong file, delete, and a download - with its redirect, progress,
 *      checksum and cancel - from a server on this computer that serves the
 *      model files already here (CAPTIONS_DOWNLOAD=1 downloads the Fast
 *      model, 190 MB, from Hugging Face instead);
 *   and the network is cut for all of it but that download.
 *
 * Needs the engine and both models where the bench keeps them:
 *   .stress-tmp/whisper-bin/b5130-cpu/Release   (CAPTIONS_WHISPER_DIR)
 *   .stress-tmp/whisper-models                  (CAPTIONS_MODELS_DIR)
 * CAPTIONS_PACKAGED=1 runs the packaged app (release/win-unpacked) with the
 * engine it carries in resources/whisper, as an installed copy would; there
 * the download step is left out, since an installed app only downloads from
 * Hugging Face.
 * The window is never shown (SCF_BACKGROUND). Screenshots go to CAPTIONS_SHOTS.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'captions');
const shotsDir = process.env.CAPTIONS_SHOTS ?? '';
const whisperDir = process.env.CAPTIONS_WHISPER_DIR ?? join(projectRoot, '.stress-tmp', 'whisper-bin', 'b5130-cpu', 'Release');
const modelsDir = process.env.CAPTIONS_MODELS_DIR ?? join(projectRoot, '.stress-tmp', 'whisper-models');
const packagedExe = process.env.CAPTIONS_PACKAGED === '1' ? join(projectRoot, 'release/win-unpacked/STOOK CREATOR FILMS.exe') : null;
const FAST = 'ggml-small-q5_1.bin';
const PRECISE = 'ggml-large-v3-turbo-q5_0.bin';

const W = 1920;
const H = 1080;
const FPS = 30;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(Boolean(passed));
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const shot = async (window, name) => {
  if (!shotsDir) return;
  await sleep(250);
  await window.screenshot({ path: join(shotsDir, name) });
};

async function appMenu(window, menu, item) {
  await window.getByTestId('app-menu-button').click();
  await window.getByRole('menuitem', { name: menu, exact: true }).click();
  await window.getByRole('menuitem', { name: item }).click();
  await window.waitForTimeout(250);
}

const powershell = (command) =>
  execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout.trim());

/** The engine's processes that this app started, by name. */
async function engineProcesses(appPid) {
  const out = await powershell(
    `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'whisper-cli.exe' -or $_.Name -eq 'ffmpeg.exe') -and $_.ParentProcessId -eq ${appPid} } | ForEach-Object { "$($_.Name):$($_.ProcessId)" }`,
  );
  return out ? out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

/** TCP connections a process holds, as "address:port" lines. */
const connectionsOf = (pid) =>
  powershell(`Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.RemoteAddress):$($_.RemotePort)" }`)
    .then((out) => (out ? out.split(/\r?\n/).filter(Boolean) : []))
    .catch(() => []);

/* Words ------------------------------------------------------------------------- */

const fold = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
function wordErrors(reference, hypothesis) {
  const n = reference.length;
  const m = hypothesis.length;
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i += 1) table[i][0] = i;
  for (let j = 0; j <= m; j += 1) table[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
    }
  }
  // Which hypothesis word each reference word was matched to.
  const matched = new Map();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const same = reference[i - 1] === hypothesis[j - 1];
    if (table[i][j] === table[i - 1][j - 1] + (same ? 0 : 1)) {
      if (same) matched.set(j - 1, i - 1);
      i -= 1;
      j -= 1;
    } else if (table[i][j] === table[i - 1][j] + 1) i -= 1;
    else j -= 1;
  }
  return { errors: table[n][m], rate: table[n][m] / n, matched };
}

async function launch(profile, models, extraEnv = {}) {
  const profileArg = `--user-data-dir=${join(workDir, profile)}`;
  const app = await electron.launch({
    ...(packagedExe ? { executablePath: packagedExe, args: [profileArg] } : { args: [profileArg, join(projectRoot, 'dist-electron/main/index.js')] }),
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      // Packaged, the engine is the one inside the app.
      SCF_WHISPER_DIR: packagedExe ? undefined : whisperDir,
      SCF_WHISPER_MODELS_DIR: models,
      ...extraEnv,
    },
  });
  const window = await app.firstWindow();
  const issues = [];
  const requests = [];
  window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
  window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
  window.on('request', (request) => requests.push(request.url()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
  // Every request the main process's own network stack makes, too.
  await app.evaluate(({ session }) => {
    globalThis.__scfRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^(https?|wss?|ftp):/i.test(details.url)) globalThis.__scfRequests.push(details.url);
      callback({});
    });
  });
  const mainRequests = () => app.evaluate(() => globalThis.__scfRequests.slice());
  // The app's own main process: the one Playwright started hands over to it.
  const pid = await app.evaluate(() => process.pid);
  return { app, window, issues, requests, mainRequests, pid };
}

const exactFrame = (window) =>
  window.evaluate(async () => {
    const renderer = window.__scfRenderer();
    const project = window.__scfStore.getState().project;
    renderer.beginExclusive();
    try {
      const rgba = await renderer.renderExact(project, project.currentFrame, false);
      let binary = '';
      for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
      return btoa(binary);
    } finally {
      renderer.endExclusive();
    }
  }).then((b64) => Buffer.from(b64, 'base64'));

const viewerFrame = (window) =>
  window.evaluate(async () => {
    const renderer = window.__scfRenderer();
    const { project } = window.__scfStore.getState();
    for (let i = 0; i < 4; i += 1) await new Promise((done) => requestAnimationFrame(done));
    renderer.drawViewport(project, false, false);
    const rgba = renderer.compositor.readPixels(false);
    let binary = '';
    for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
    return btoa(binary);
  }).then((b64) => Buffer.from(b64, 'base64'));

/** Where the near-white pixels are: the letters of a caption over a grey picture. */
function whiteBox(rgba, width, height, floor = 235) {
  let count = 0;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (rgba[i] > floor && rgba[i + 1] > floor && rgba[i + 2] > floor) {
        count += 1;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { count, left, right, top, bottom };
}

/** The caption clips of the project, in order, with their track. */
const captionClips = (window) =>
  window.evaluate(() => {
    const { project } = window.__scfStore.getState();
    return Object.values(project.clips)
      .filter((clip) => clip.caption)
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((clip) => ({ id: clip.id, trackId: clip.trackId, start: clip.startFrame, duration: clip.durationFrames, offset: clip.sourceOffsetFrames, text: clip.caption.text, words: clip.caption.words ?? [], name: clip.name }));
  });

const jobPhase = (window) => window.evaluate(() => window.__scfCaptions.job.getState().phase);

/** Open the dialog from the Timeline menu and set its fields. */
async function openDialog(window, menu = 'Timeline', item = /^Generate captions/) {
  await appMenu(window, menu, item);
  const dialog = window.getByTestId('captions-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  // The models' state arrives from the main process.
  await window.waitForFunction(() => !document.querySelector('[data-testid="captions-generate"]')?.disabled, null, { timeout: 15_000 }).catch(() => undefined);
  return dialog;
}

async function generate(window, { language = 'es', model = 'fast', preset = 'classic', source = 'mix' } = {}) {
  const dialog = await openDialog(window);
  await dialog.getByTestId('captions-language').selectOption(language);
  await dialog.getByTestId('captions-model').selectOption(model);
  await dialog.getByTestId('captions-preset').selectOption(preset);
  await dialog.getByTestId('captions-source').selectOption(source);
  await dialog.getByTestId('captions-generate').click();
}

const waitIdle = (window, timeout = 600_000) => window.waitForFunction(() => window.__scfCaptions.job.getState().phase === 'idle', null, { timeout });

async function main() {
  const engineCli = packagedExe ? join(projectRoot, 'release/win-unpacked/resources/whisper/whisper-cli.exe') : join(whisperDir, 'whisper-cli.exe');
  for (const needed of [engineCli, join(modelsDir, FAST), join(modelsDir, PRECISE)]) {
    if (!existsSync(needed)) {
      console.error(`Missing ${needed}. This test needs the speech engine and both models: see the header of tests/ui/captions.mjs.`);
      process.exit(2);
    }
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  if (shotsDir) await mkdir(shotsDir, { recursive: true });

  console.log('0. a Spanish recording with a known text (a Windows voice)');
  const ttsDir = join(workDir, 'tts');
  await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'tests', 'bench', 'captions-tts.ps1'), '-Out', ttsDir]);
  const truth = JSON.parse((await readFile(join(ttsDir, 'speech.json'), 'utf8')).replace(/^﻿/, ''));
  const truthWords = [...truth.words].sort((a, b) => a.char - b.char).map((word) => ({ text: fold(word.text)[0], startMs: word.startMs })).filter((word) => word.text);
  const speech = join(ttsDir, 'speech.wav');
  const seconds = ((await stat(speech)).size - 44) / 32_000;
  console.log(`   ${truthWords.length} words, ${seconds.toFixed(1)} s, voice ${truth.voice}`);
  const still = join(workDir, 'grey.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}`, '-frames:v', '1', still]);
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });

  const { app, window, issues, requests, mainRequests, pid } = await launch('profile', modelsDir);
  const tempRoot = join(await app.evaluate(({ app: electronApp }) => electronApp.getPath('temp')), 'scf-captions');
  const tempLeft = async () => (existsSync(tempRoot) ? (await readdir(tempRoot)).length : 0);
  try {
    // The network is cut from here on: nothing below needs it.
    await app.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }));

    await window.evaluate(([w, h, fps]) => window.__scfStore.getState().setProjectSettings({ width: w, height: h, fps }), [W, H, FPS]);
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [still, speech]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 30_000 });
    const frames = Math.ceil(seconds * FPS);
    await window.evaluate((length) => {
      const store = window.__scfStore.getState();
      const picture = store.assets.find((asset) => asset.kind === 'image');
      const sound = store.assets.find((asset) => asset.kind === 'audio');
      const video = store.project.tracks.find((track) => track.type === 'video' && track.order === 0);
      const audio = store.project.tracks.find((track) => track.type === 'audio');
      const pictureId = store.addAssetToTimeline(picture, video.id, 0);
      window.__scfStore.getState().updateClip(pictureId, { durationFrames: length });
      window.__scfStore.getState().addAssetToTimeline(sound, audio.id, 0);
      window.__scfStore.getState().selectClips([]);
      window.__scfStore.getState().setCurrentFrame(0);
    }, frames);

    console.log('1. the dialog');
    const dialog = await openDialog(window);
    const fields = await dialog.locator('label.field-label').allInnerTexts();
    check('Timeline > Generate captions opens it: Spoken language, Sound to listen to, Quality, Style',
      fields.join('|') === 'Spoken language|Sound to listen to|Quality|Style', fields.join(' / '));
    const defaults = await window.evaluate(() => ({
      language: document.querySelector('[data-testid="captions-language"]').value,
      source: document.querySelector('[data-testid="captions-source"]').value,
      model: document.querySelector('[data-testid="captions-model"]').value,
      preset: document.querySelector('[data-testid="captions-preset"]').value,
      sources: [...document.querySelector('[data-testid="captions-source"]').options].map((option) => option.textContent),
      models: [...document.querySelector('[data-testid="captions-model"]').options].map((option) => option.textContent),
    }));
    check('it starts on the interface language (English), the whole mix, Precise and Classic',
      defaults.language === 'en' && defaults.source === 'mix' && defaults.model === 'precise' && defaults.preset === 'classic', JSON.stringify(defaults).slice(0, 120));
    check('the sound can be the whole mix or the one track that has sound', defaults.sources.length === 2 && /whole mix/.test(defaults.sources[0]) && /Audio 1/.test(defaults.sources[1]),
      defaults.sources.join(' / '));
    check('both models are on this computer, and say so', defaults.models.every((text) => /on this computer/.test(text)), defaults.models.join(' / '));
    const engineLine = await dialog.getByTestId('captions-engine').innerText();
    check('it says everything is done on this computer, and what does the work', /never sent anywhere/.test(engineLine) && /(processor|runs on the)/i.test(engineLine), engineLine);
    await shot(window, 'captions-dialog-en.png');
    await window.keyboard.press('Escape');
    await sleep(300);
    check('Escape closes it and nothing was started', (await jobPhase(window)) === 'idle' && (await captionClips(window)).length === 0);

    console.log('2. generating, with the Fast model');
    const depth = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    await generate(window, { language: 'es', model: 'fast' });
    await window.getByTestId('captions-progress').waitFor({ state: 'visible', timeout: 10_000 });
    const closed = await window.getByTestId('captions-dialog').waitFor({ state: 'detached', timeout: 3_000 }).then(() => true).catch(() => false);
    check('the dialog closes and a progress card with Cancel takes over', closed && (await window.getByTestId('captions-cancel').isVisible()));
    // The editor is usable meanwhile: move the playhead, add and remove a marker.
    let sawTranscribing = false;
    let sawProcess = false;
    let connections = [];
    let edited = false;
    for (let tries = 0; tries < 600 && (await jobPhase(window)) !== 'idle'; tries += 1) {
      const phase = await jobPhase(window);
      if (phase === 'transcribing') {
        if (!sawTranscribing) await shot(window, 'captions-progress-en.png');
        sawTranscribing = true;
        const running = await engineProcesses(pid);
        const whisper = running.find((line) => line.startsWith('whisper-cli.exe'));
        if (whisper) {
          sawProcess = true;
          connections = connections.concat(await connectionsOf(Number(whisper.split(':')[1])));
        }
        if (!edited) {
          edited = await window.evaluate(() => {
            const store = window.__scfStore.getState();
            store.setCurrentFrame(45);
            const id = store.addMarker(45);
            const there = window.__scfStore.getState().project.markers.length === 1;
            window.__scfStore.getState().removeMarker(id);
            return there && window.__scfStore.getState().project.currentFrame === 45;
          });
        }
      }
      await sleep(250);
    }
    const fast = await window.evaluate(() => window.__scfCaptions.job.getState().last);
    let clips = await captionClips(window);
    check('it ran as a child process of the app (whisper-cli), which opened no network connection', sawProcess && connections.length === 0,
      `seen ${sawProcess}, connections ${connections.join(', ') || 'none'}`);
    check('the editor stayed usable while it ran: the playhead moved and a marker was added and removed', edited);
    check('the captions arrive on a new track on top, named Captions 1', clips.length > 5 && await window.evaluate((trackId) => {
      const { project } = window.__scfStore.getState();
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      const top = [...project.tracks].filter((candidate) => candidate.type !== 'audio').sort((a, b) => b.order - a.order)[0];
      return track.type === 'captions' && track.name === 'Captions 1' && top.id === track.id && track.captions.language === 'es' && track.captions.preset === 'classic';
    }, clips[0]?.trackId), `${clips.length} captions`);
    const afterDepth = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    // The marker added and removed while it ran is two steps of its own.
    check('as one undo step', afterDepth === depth + 3, `${depth} -> ${afterDepth}`);
    const toast = await window.getByText(/captions added in \d+ s/).first().innerText().catch(() => '');
    check('and a message says how many, how long it took and what did the work', /\d+ captions added in \d+ s, on the (processor|.+)\. Ctrl\+Z removes them\./.test(toast), toast);
    await sleep(600);
    const leftovers = { processes: await engineProcesses(pid), temp: await tempLeft() };
    check('nothing is left behind: no engine process, no temporary sound', leftovers.processes.length === 0 && leftovers.temp === 0, JSON.stringify(leftovers));
    await shot(window, 'captions-timeline-en.png');

    console.log('3. accuracy (a synthetic voice: the easy case)');
    const measure = (list) => {
      const reference = truthWords.map((word) => word.text);
      const hypothesis = list.flatMap((clip) => fold(clip.text));
      const { errors, rate, matched } = wordErrors(reference, hypothesis);
      // Each caption's first word, against when the voice began it.
      const starts = [];
      let index = 0;
      for (const clip of list) {
        const at = matched.get(index);
        if (at !== undefined) starts.push({ text: clip.text.split('\n')[0], error: clip.start / FPS - truthWords[at].startMs / 1000 });
        index += fold(clip.text).length;
      }
      const abs = starts.map((entry) => Math.abs(entry.error)).sort((a, b) => a - b);
      return { errors, rate, words: reference.length, starts, median: abs[abs.length >> 1], worst: abs[abs.length - 1], within: abs.filter((value) => value <= 0.2).length };
    };
    const fastAccuracy = measure(clips);
    check('Fast (small): word error rate under 5%', fastAccuracy.rate < 0.05, `${fastAccuracy.errors} errors in ${fastAccuracy.words} words = ${(fastAccuracy.rate * 100).toFixed(2)}%`);
    check('Fast: every caption starts within 200 ms of its first word, give or take a frame', fastAccuracy.worst <= 0.2 + 1 / FPS,
      `${fastAccuracy.within}/${fastAccuracy.starts.length} within 200 ms, median ${(fastAccuracy.median * 1000).toFixed(0)} ms, worst ${(fastAccuracy.worst * 1000).toFixed(0)} ms`);
    console.log(`   Fast: ${fast.result.audioSeconds.toFixed(1)} s of sound in ${fast.result.elapsedSeconds.toFixed(1)} s (${(fast.result.audioSeconds / fast.result.elapsedSeconds).toFixed(1)}x), on the ${fast.result.ran}; ${fast.totalSeconds.toFixed(1)} s in all`);

    console.log('4. the rules (Netflix, Spanish)');
    const rules = await window.evaluate((list) => {
      const { rulesFor, checkCue, isWeak } = window.__scfCaptions;
      const { project } = window.__scfStore.getState();
      const limits = rulesFor('classic', project);
      const out = { long: [], lines: [], short: [], longTime: [], fast: [], fastWithRoom: [], gaps: [], weak: [], limits };
      list.forEach((clip, index) => {
        const lines = clip.text.split('\n');
        const cue = { start: clip.start / project.fps, end: (clip.start + clip.duration) / project.fps, lines };
        const result = checkCue(cue, limits);
        if (!result.charsPerLine) out.long.push(clip.text);
        if (!result.lines) out.lines.push(clip.text);
        if (!result.minDuration) out.short.push(`${clip.text} (${cue.end - cue.start})`);
        if (!result.maxDuration) out.longTime.push(clip.text);
        // Over the reading speed with room left to stay up longer is a rule broken;
        // over it with the next caption 2 frames away is speech that is itself that fast.
        const next0 = list[index + 1];
        const room = next0 ? next0.start - (clip.start + clip.duration) > 2 : false;
        if (!result.readingSpeed) (room ? out.fastWithRoom : out.fast).push(`${(lines.join('').length / (cue.end - cue.start)).toFixed(1)}`);
        if (lines.length === 2 && isWeak(lines[0].split(' ').pop(), 'es')) out.weak.push(lines[0]);
        const next = list[index + 1];
        if (next) {
          const gap = next.start - (clip.start + clip.duration);
          if (!(gap === 2 || gap >= Math.round(project.fps / 2))) out.gaps.push(gap);
        }
      });
      return out;
    }, clips);
    check('no line longer than 42 characters, no caption of more than two lines', rules.long.length === 0 && rules.lines.length === 0, [...rules.long, ...rules.lines].join(' | '));
    check('every caption lasts between 5/6 of a second and 7 seconds', rules.short.length === 0 && rules.longTime.length === 0, [...rules.short, ...rules.longTime].join(' | '));
    check('gaps between captions are 2 frames, or half a second or more', rules.gaps.length === 0, `gaps of ${rules.gaps.join(', ')} frames`);
    check('no line ends on an article, a preposition or a conjunction', rules.weak.length === 0, rules.weak.join(' | '));
    // Speech faster than 17 characters a second cannot be slowed down: those are counted, not failed.
    check('no caption is over 17 characters a second while it has room to stay up longer', rules.fastWithRoom.length === 0 && rules.fast.every((speed) => Number(speed) < 20),
      `${rules.fast.length} of ${clips.length} are over because the speech itself is that fast, with the next caption 2 frames away: ${rules.fast.join(', ')} characters a second`);

    console.log('5. the Precise model, and undo');
    await window.evaluate(() => window.__scfStore.getState().undo());
    check('Ctrl+Z takes the captions and their track away', (await captionClips(window)).length === 0
      && await window.evaluate(() => !window.__scfStore.getState().project.tracks.some((track) => track.type === 'captions')));
    await generate(window, { language: 'es', model: 'precise' });
    await window.getByTestId('captions-progress').waitFor({ state: 'visible', timeout: 10_000 });
    await waitIdle(window);
    const precise = await window.evaluate(() => window.__scfCaptions.job.getState().last);
    clips = await captionClips(window);
    const preciseAccuracy = measure(clips);
    check('Precise (large-v3-turbo): word error rate under 5%', preciseAccuracy.rate < 0.05,
      `${preciseAccuracy.errors} errors in ${preciseAccuracy.words} words = ${(preciseAccuracy.rate * 100).toFixed(2)}%`);
    check('Precise: every caption starts within 200 ms of its first word, give or take a frame', preciseAccuracy.worst <= 0.2 + 1 / FPS,
      `${preciseAccuracy.within}/${preciseAccuracy.starts.length} within 200 ms, median ${(preciseAccuracy.median * 1000).toFixed(0)} ms, worst ${(preciseAccuracy.worst * 1000).toFixed(0)} ms`);
    check('Precise writes the Spanish opening marks (¿ ¡)', clips.some((clip) => clip.text.includes('¿')) && clips.some((clip) => clip.text.includes('¡')));
    console.log(`   Precise: ${precise.result.audioSeconds.toFixed(1)} s of sound in ${precise.result.elapsedSeconds.toFixed(1)} s (${(precise.result.audioSeconds / precise.result.elapsedSeconds).toFixed(1)}x), on the ${precise.result.ran}; ${precise.totalSeconds.toFixed(1)} s in all`);
    await writeFile(join(workDir, 'accuracy.json'), JSON.stringify({ voice: truth.voice, seconds, fast: { ...fastAccuracy, starts: undefined, job: fast }, precise: { ...preciseAccuracy, starts: undefined, job: precise } }, null, 2));

    console.log('6. cancelling');
    const before = clips.length;
    await generate(window, { language: 'es', model: 'precise' });
    await window.waitForFunction(() => window.__scfCaptions.job.getState().phase === 'transcribing', null, { timeout: 60_000 });
    for (let tries = 0; tries < 40 && !(await engineProcesses(pid)).some((line) => line.startsWith('whisper-cli')); tries += 1) await sleep(100);
    const runningBefore = await engineProcesses(pid);
    const tempDuring = await tempLeft();
    await sleep(1500);
    await window.getByTestId('captions-cancel').click();
    await waitIdle(window, 20_000);
    await sleep(800);
    const runningAfter = await engineProcesses(pid);
    check('Cancel stops it: the engine was running with its sound on disk, and both are gone',
      runningBefore.length > 0 && tempDuring === 1 && runningAfter.length === 0 && (await tempLeft()) === 0,
      `before: ${runningBefore.join(', ')}, ${tempDuring} temp folder; after: ${runningAfter.join(', ') || 'no process'}, ${await tempLeft()} temp folders`);
    check('nothing was added, and the card is gone', (await captionClips(window)).length === before && (await window.getByTestId('captions-progress').count()) === 0);
    check('and it says so', await window.getByText('Captions cancelled. Nothing was added.').first().isVisible().catch(() => false));

    console.log('7. the picture');
    const target = clips.find((clip) => clip.text.includes('\n')) ?? clips[1];
    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), target.start + Math.floor(target.duration / 2));
    await sleep(800);
    let exact = await exactFrame(window);
    for (let tries = 0; tries < 20 && whiteBox(exact, W, H).count === 0; tries += 1) {
      await sleep(250);
      exact = await exactFrame(window);
    }
    const box = whiteBox(exact, W, H);
    const centre = (box.left + box.right) / 2;
    check('the caption is drawn: white letters, centred, at the bottom of the title-safe area',
      box.count > 2000 && Math.abs(centre - W / 2) < W * 0.02 && box.bottom < H * 0.95 && box.bottom > H * 0.88 && box.top > H * 0.7,
      `${box.count} white pixels, x ${box.left}..${box.right} (centre ${centre}), y ${box.top}..${box.bottom}`);
    check('a full line fits inside the title-safe width', box.left >= W * 0.05 && box.right <= W * 0.95, `x ${box.left}..${box.right} of ${W}`);
    const viewer = await viewerFrame(window);
    let worst = 0;
    for (let i = 0; i < exact.length; i += 1) worst = Math.max(worst, Math.abs(exact[i] - viewer[i]));
    check('the viewer and the exact render (the export\'s frame) are identical', worst === 0, `worst difference ${worst}`);
    await shot(window, 'captions-viewer-en.png');
    await window.evaluate((trackId) => window.__scfStore.getState().updateTrack(trackId, { visible: false }), target.trackId);
    const hidden = whiteBox(await exactFrame(window), W, H);
    await window.evaluate(() => window.__scfStore.getState().undo());
    check('hiding the captions track takes them off the picture', hidden.count === 0, `${hidden.count} white pixels`);

    console.log('8. editing');
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), target.id);
    await sleep(300);
    const tabs = await window.getByTestId('inspector-panel').getByRole('tab').allInnerTexts();
    check('a selected caption opens the Caption tab: Caption, Info', tabs.join('|') === 'Caption|Info'
      && (await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Caption' }).getAttribute('aria-selected')) === 'true', tabs.join(' / '));
    const shown = await window.getByTestId('caption-text').inputValue();
    const stats = await window.evaluate(() => ['caption-lines', 'caption-length', 'caption-speed'].map((id) => document.querySelector(`[data-testid="${id}"]`).textContent));
    check('with its text, and its lines, longest line and reading speed against the limits', shown === target.text && /of 2$/.test(stats[0]) && /of 42 characters$/.test(stats[1]) && /of 17 characters a second$/.test(stats[2]),
      stats.join(' / '));
    await shot(window, 'captions-inspector-en.png');
    const undoDepth = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    const text = window.getByTestId('caption-text');
    await text.click();
    await text.press('Control+A');
    await text.pressSequentially('Hola a todas y a todos, bienvenidos a este canal de edición de vídeo');
    const typed = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { text: clip.caption.text, name: clip.name, depth: window.__scfHistory.getState().undoStack.length };
    }, target.id);
    check('typing changes the caption and its name on the timeline, as one undo step',
      typed.text === 'Hola a todas y a todos, bienvenidos a este canal de edición de vídeo' && typed.name === typed.text && typed.depth === undoDepth + 1, JSON.stringify(typed));
    const warned = await window.evaluate(() => ({
      over: document.querySelector('[data-testid="caption-length"]').dataset.over,
      warning: document.querySelector('[data-testid="caption-warning"]')?.textContent ?? '',
    }));
    check('a line over 42 characters is marked, and it says what to do', warned.over === 'true' && /Break it with Enter|Too much to read/.test(warned.warning), JSON.stringify(warned));
    await window.evaluate(() => window.__scfStore.getState().undo());
    check('undo brings the transcribed text back', (await window.evaluate((id) => window.__scfStore.getState().project.clips[id].caption.text, target.id)) === target.text);
    await window.evaluate(() => document.activeElement?.blur());

    // The razor, between two words.
    const cut = await window.evaluate(([id, fps]) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[id];
      const words = clip.caption.words;
      const at = Math.floor(words.length / 2);
      const frame = clip.startFrame + Math.round(((words[at - 1].end + words[at].start) / 2) * fps);
      store.razorAtFrame(frame, [id]);
      const { project } = window.__scfStore.getState();
      const halves = Object.values(project.clips).filter((candidate) => candidate.caption && candidate.startFrame >= clip.startFrame && candidate.startFrame < clip.startFrame + clip.durationFrames)
        .sort((a, b) => a.startFrame - b.startFrame);
      return {
        frame,
        expected: [words.slice(0, at).map((word) => word.text).join(' '), words.slice(at).map((word) => word.text).join(' ')],
        got: halves.map((half) => half.caption.text.replace(/\n/g, ' ')),
        ends: halves.map((half) => [half.startFrame, half.startFrame + half.durationFrames]),
        whole: [clip.startFrame, clip.startFrame + clip.durationFrames],
      };
    }, [target.id, FPS]);
    check('the razor cuts a caption between two words: each half keeps the words spoken on its side',
      cut.got.length === 2 && cut.got[0] === cut.expected[0] && cut.got[1] === cut.expected[1] && cut.ends[0][1] === cut.frame && cut.ends[1][0] === cut.frame
        && cut.ends[0][0] === cut.whole[0] && cut.ends[1][1] === cut.whole[1], JSON.stringify(cut.got));
    await window.evaluate(() => window.__scfStore.getState().undo());
    check('and undo makes it one caption again', (await captionClips(window)).length === before);

    const moved = await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[id];
      const end = clip.startFrame + clip.durationFrames;
      store.trimClip(id, 'end', end - 6);
      const trimmed = window.__scfStore.getState().project.clips[id];
      window.__scfStore.getState().undo();
      const video = store.project.tracks.find((track) => track.type === 'video');
      window.__scfStore.getState().moveClipTo(id, video.id, clip.startFrame);
      const stayed = window.__scfStore.getState().project.clips[id].trackId === clip.trackId;
      // The magnet is on. Deleting a caption must not pull the later ones off their words.
      const startsOf = () => Object.values(window.__scfStore.getState().project.clips).filter((other) => other.caption && other.id !== id).map((other) => `${other.id}@${other.startFrame}`).sort().join();
      const beforeDelete = startsOf();
      window.__scfStore.getState().removeClips([id]);
      const kept = startsOf() === beforeDelete && window.__scfStore.getState().ui.rippleEnabled === true;
      window.__scfStore.getState().undo();
      // Dragged far to the right, it stops at the next caption instead of pushing it.
      window.__scfStore.getState().moveClipTo(id, clip.trackId, clip.startFrame + 900);
      const after = window.__scfStore.getState().project.clips[id];
      const stopped = startsOf() === beforeDelete && after.startFrame - clip.startFrame <= 2;
      if (after.startFrame !== clip.startFrame) window.__scfStore.getState().undo();
      return { trimmed: trimmed.durationFrames === clip.durationFrames - 6 && trimmed.caption.text === clip.caption.text, stayed, kept, stopped };
    }, target.id);
    check('a caption trims like a clip and keeps its text; dragged onto a video track it stays on its own', moved.trimmed && moved.stayed, JSON.stringify(moved));
    check('with the magnet on, deleting a caption or dragging it into the next one moves no other caption', moved.kept && moved.stopped, JSON.stringify(moved));

    console.log('9. files');
    const srtPath = join(exportDir, 'captions.srt');
    const vttPath = join(exportDir, 'captions.vtt');
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, srtPath);
    await appMenu(window, 'Timeline', /^Export captions/);
    await window.getByText(/captions saved to captions\.srt/).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    const srt = existsSync(srtPath) ? await readFile(srtPath, 'utf8') : '';
    const blocks = srt.split('\r\n\r\n').filter(Boolean);
    check('Timeline > Export captions writes an .srt: numbered, with times, one block per caption', blocks.length === clips.length
      && /^1\r\n00:00:0\d,\d{3} --> 00:00:0\d,\d{3}\r\n/.test(srt), `${blocks.length} blocks for ${clips.length} captions`);
    const expectedSrt = await window.evaluate(() => {
      const { captionCues, writeSrt } = window.__scfCaptions;
      return writeSrt(captionCues(window.__scfStore.getState().project));
    });
    check('exactly the captions on the timeline, at their times', srt === expectedSrt);
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, vttPath);
    await appMenu(window, 'Timeline', /^Export captions/);
    await sleep(800);
    const vtt = existsSync(vttPath) ? await readFile(vttPath, 'utf8') : '';
    check('choosing .vtt in the same dialog writes WebVTT', vtt.startsWith('WEBVTT\n\n00:00:0') && vtt.split('-->').length - 1 === clips.length);

    // In again: a second captions track, the same captions; out again: the same file.
    for (const [path, original, label] of [[srtPath, srt, '.srt'], [vttPath, vtt, '.vtt']]) {
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path);
      const tracksBefore = await window.evaluate(() => window.__scfStore.getState().project.tracks.filter((track) => track.type === 'captions').length);
      await appMenu(window, 'Timeline', /^Import captions/);
      await window.waitForFunction((count) => window.__scfStore.getState().project.tracks.filter((track) => track.type === 'captions').length === count + 1, tracksBefore, { timeout: 10_000 }).catch(() => undefined);
      const again = await window.evaluate((isVtt) => {
        const { captionCues, writeSrt, writeVtt } = window.__scfCaptions;
        const { project } = window.__scfStore.getState();
        const imported = [...project.tracks].filter((track) => track.type === 'captions').sort((a, b) => b.order - a.order)[0];
        const cues = captionCues(project, { trackId: imported.id });
        return { text: isVtt ? writeVtt(cues) : writeSrt(cues), name: imported.name, count: cues.length };
      }, label === '.vtt');
      check(`${label}: imported and exported again, it is the same file, byte for byte`, again.text === original && again.count === clips.length, `${again.count} captions on ${again.name}`);
      await window.evaluate(() => window.__scfStore.getState().undo());
    }
    check('undo takes an imported track away again', (await captionClips(window)).length === before);

    console.log('10. export');
    const first = clips[0];
    // The first three captions, and not a frame of the fourth.
    const range = [0, clips[3].start];
    const probeFrame = first.start + Math.floor(first.duration / 2);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportDir);
    const exportOnce = async (name, burn, file) => {
      await window.evaluate(([start, end]) => window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', width: 960, height: 540, startFrame: start, endFrame: end }), range);
      await window.getByRole('button', { name: 'Export' }).click();
      const exportDialog = window.getByRole('dialog', { name: 'Export' });
      await exportDialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      await exportDialog.getByLabel('Start frame').fill(String(range[0]));
      await exportDialog.getByLabel('End frame').fill(String(range[1]));
      await exportDialog.getByLabel('File name').fill(name);
      await exportDialog.getByRole('button', { name: 'Browse' }).click();
      await sleep(500);
      const section = await exportDialog.getByTestId('export-captions-burn').isVisible().catch(() => false);
      await exportDialog.getByTestId('export-captions-burn').setChecked(burn);
      await exportDialog.getByTestId('export-captions-file').selectOption(file);
      if (name === 'burnt') await shot(window, 'captions-export-en.png');
      await exportDialog.getByRole('button', { name: 'Start export' }).click();
      const finished = await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 180_000 }).then(() => true).catch(() => false);
      const result = finished ? await window.getByTestId('export-result').innerText() : '';
      if (name === 'burnt') await shot(window, 'captions-export-done-en.png');
      await exportDialog.getByTitle('Close').click();
      await sleep(400);
      const video = join(exportDir, `${name}.mp4`);
      let white = -1;
      if (finished && existsSync(video)) {
        const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-ss', String(probeFrame / FPS), '-i', video, '-frames:v', '1', '-vf', 'scale=960:540', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
        // Half size and through H.264, thin white letters come out a little grey.
        white = whiteBox(stdout, 960, 540, 180).count;
      }
      return { section, finished, result, white, video };
    };
    const burnt = await exportOnce('burnt', true, 'srt');
    check('the export dialog has a Captions group once the timeline has captions', burnt.section);
    check('burnt in: the exported video has the caption in its picture', burnt.finished && burnt.white > 500, `${burnt.white} white pixels`);
    const sidecar = join(exportDir, 'burnt.srt');
    const sidecarText = existsSync(sidecar) ? await readFile(sidecar, 'utf8') : '';
    const expectedSidecar = await window.evaluate(([start, end]) => {
      const { captionCues, writeSrt } = window.__scfCaptions;
      return writeSrt(captionCues(window.__scfStore.getState().project, { fromFrame: start, toFrame: end }));
    }, range);
    check('and its .srt is beside it, with the captions of the range exported', sidecarText !== '' && sidecarText === expectedSidecar && sidecarText.split('-->').length - 1 === 3,
      `${sidecarText.split('-->').length - 1} captions in burnt.srt`);
    check('the finished card names the subtitle file', /burnt\.srt/.test(burnt.result), burnt.result.replace(/\s+/g, ' ').slice(0, 160));
    const clean = await exportOnce('clean', false, 'vtt');
    check('not burnt in: the picture has no caption, and the .vtt is beside the video', clean.finished && clean.white === 0 && existsSync(join(exportDir, 'clean.vtt'))
      && (await readFile(join(exportDir, 'clean.vtt'), 'utf8')).startsWith('WEBVTT'), `${clean.white} white pixels`);
    const plain = await exportOnce('plain', true, 'none');
    check('no file asked for, none written', plain.finished && !existsSync(join(exportDir, 'plain.srt')) && !existsSync(join(exportDir, 'plain.vtt')));

    console.log('11. in Spanish');
    await window.evaluate(() => window.localStorage.removeItem('scf.captions.options'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await sleep(300);
    const modelsEs = await window.getByTestId('speech-models').innerText();
    check('Preferencias lists the two models, on this computer, and where they come from',
      /Modelos de voz, para los subtítulos/i.test(modelsEs) && /Preciso · 574 MB/.test(modelsEs) && /Rápido · 190 MB/.test(modelsEs) && (modelsEs.match(/En este equipo/gi) ?? []).length === 2
        && /huggingface\.co\/ggerganov\/whisper\.cpp/.test(modelsEs), modelsEs.replace(/\s+/g, ' ').slice(0, 200));
    await shot(window, 'captions-preferences-es.png');
    await window.keyboard.press('Escape');
    await sleep(400);
    const dialogEs = await openDialog(window, 'Línea de tiempo', /^Generar subtítulos/);
    const fieldsEs = await dialogEs.locator('label.field-label').allInnerTexts();
    const languageEs = await dialogEs.getByTestId('captions-language').inputValue();
    check('Línea de tiempo > Generar subtítulos: Idioma hablado, Sonido que se escucha, Calidad, Estilo; el idioma empieza en español',
      fieldsEs.join('|') === 'Idioma hablado|Sonido que se escucha|Calidad|Estilo' && languageEs === 'es', `${fieldsEs.join(' / ')} - ${languageEs}`);
    await shot(window, 'captions-dialog-es.png');
    await dialogEs.getByTestId('captions-model').selectOption('fast');
    await dialogEs.getByTestId('captions-preset').selectOption('social');
    await dialogEs.getByTestId('captions-source').selectOption({ index: 1 });
    await dialogEs.getByTestId('captions-generate').click();
    await window.getByTestId('captions-progress').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    const cardEs = await window.getByTestId('captions-progress').innerText().catch(() => '');
    await waitIdle(window);
    check('the progress card speaks Spanish', /Subtítulos: (preparando el sonido|escuchando y escribiendo)…/.test(cardEs) && /Puedes seguir editando/.test(cardEs) && /Cancelar/.test(cardEs), cardEs.replace(/\s+/g, ' '));
    const social = await window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      const track = [...project.tracks].filter((candidate) => candidate.type === 'captions').sort((a, b) => b.order - a.order)[0];
      const list = Object.values(project.clips).filter((clip) => clip.trackId === track.id).sort((a, b) => a.startFrame - b.startFrame);
      return { name: track.name, preset: track.captions.preset, count: list.length, lines: Math.max(...list.map((clip) => clip.caption.text.split('\n').length)), longest: Math.max(...list.map((clip) => clip.caption.text.length)), first: list[0].id };
    });
    check('one track only heard, style Redes: a track named Subtítulos 2, every caption one line of at most 28 characters',
      social.name === 'Subtítulos 2' && social.preset === 'social' && social.lines === 1 && social.longest <= 28 && social.count > before, JSON.stringify(social));
    const toastEs = await window.getByText(/subtítulos añadidos en \d+ s/).first().innerText().catch(() => '');
    check('and the message too', /\d+ subtítulos añadidos en \d+ s, con (el procesador|la .+)\. Ctrl\+Z los quita\./.test(toastEs), toastEs);
    await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      store.selectClips([id]);
      store.setCurrentFrame(store.project.clips[id].startFrame + 3);
    }, social.first);
    await sleep(600);
    const tabsEs = await window.getByTestId('inspector-panel').getByRole('tab').allInnerTexts();
    const statsEs = await window.evaluate(() => document.querySelector('[data-testid="caption-length"]').textContent);
    check('the Inspector: Subtítulo, Info, and the one-line limit of 28', tabsEs.join('|') === 'Subtítulo|Info' && /de 28 caracteres$/.test(statsEs), `${tabsEs.join(' / ')} - ${statsEs}`);
    await shot(window, 'captions-social-es.png');
    await window.evaluate(() => window.__scfStore.getState().undo());

    console.log('12. nothing left the computer');
    const remote = [...requests.filter((url) => /^(https?|wss?|ftp):/i.test(url)), ...(await mainRequests())];
    check('with the network cut, everything above worked and no request was even attempted', remote.length === 0, remote.slice(0, 3).join(' | '));
    check('no engine process and no temporary sound is left', (await engineProcesses(pid)).length === 0 && (await tempLeft()) === 0);
    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
  }

  console.log('13. models: asking before downloading, importing, deleting');
  const emptyModels = join(workDir, 'models');
  await mkdir(emptyModels, { recursive: true });
  // A stand-in for Hugging Face on this computer: the same files, behind the
  // same kind of redirect, the big one slowed so it can be cancelled part-way.
  const real = process.env.CAPTIONS_DOWNLOAD === '1';
  const served = [];
  const server = createServer((request, response) => {
    served.push(request.url);
    const name = basename(request.url);
    const file = join(modelsDir, name);
    if (request.url.startsWith('/resolve/')) {
      response.writeHead(302, { location: `/cdn/${name}` });
      response.end();
      return;
    }
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-length': statSync(file).size, 'content-type': 'application/octet-stream' });
    const stream = createReadStream(file, { highWaterMark: 1 << 20 });
    // A megabyte at a time, with a breath between: long enough to see progress, and to cancel the big one.
    const pause = name === PRECISE ? 60 : 12;
    stream.on('data', () => { stream.pause(); setTimeout(() => stream.resume(), pause); });
    stream.pipe(response);
    response.on('close', () => stream.destroy());
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}/resolve`;
  const second = await launch('profile-models', emptyModels, real ? {} : { SCF_WHISPER_MODEL_BASE: base });
  try {
    const { app: app2, window: window2 } = second;
    const listModels = async () => (existsSync(emptyModels) ? (await readdir(emptyModels)).sort() : []);
    await app2.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window2.getByTestId('speech-models').waitFor({ state: 'visible', timeout: 10_000 });
    const absent = await window2.evaluate(() => ['precise', 'fast'].map((id) => document.querySelector(`[data-testid="speech-model-${id}"]`).dataset.present));
    check('with no models, Preferences says neither is on this computer', absent.join('|') === 'false|false', absent.join(' / '));
    await shot(window2, 'captions-preferences-empty-en.png');
    await window2.keyboard.press('Escape');
    await sleep(300);

    const dialog2 = await openDialog(window2);
    const options = await dialog2.getByTestId('captions-model').locator('option').allInnerTexts();
    check('the dialog says what each would download: 574 MB and 190 MB', /download of 574 MB/.test(options[0]) && /download of 190 MB/.test(options[1]), options.join(' / '));
    await dialog2.getByTestId('captions-generate').click();
    const prompt = window2.getByTestId('captions-download-prompt');
    await prompt.waitFor({ state: 'visible', timeout: 5_000 });
    const body = await prompt.innerText();
    check('Generate asks first: the model, its size, its source, and that only the model travels',
      /Download the speech model\?/.test(body) && /“Precise”/.test(body) && /574 MB/.test(body) && /huggingface\.co\/ggerganov\/whisper\.cpp/.test(body) && /Your video and its sound stay here/.test(body)
        && /Download \(574 MB\)/.test(body) && /Import from a file/.test(body), body.replace(/\s+/g, ' ').slice(0, 220));
    await shot(window2, 'captions-download-prompt-en.png');
    await window2.getByTestId('captions-download-cancel').click();
    await sleep(500);
    check('declining downloads nothing: no request, no file, no job',
      (await second.mainRequests()).length === 0 && (await listModels()).length === 0 && (await jobPhase(window2)) === 'idle', (await second.mainRequests()).join(' | '));

    // A file that is not a model, with the right size, is refused.
    const fake = join(workDir, FAST);
    await copyFile(join(modelsDir, FAST), fake);
    const handle = await (await import('node:fs/promises')).open(fake, 'r+');
    await handle.write(Buffer.from([0x00, 0x11, 0x22, 0x33]), 0, 4, 1_000_000);
    await handle.close();
    await app2.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, fake);
    await dialog2.getByTestId('captions-generate').click();
    await prompt.waitFor({ state: 'visible', timeout: 5_000 });
    await window2.getByTestId('captions-import-model').click();
    const refused = await window2.getByText(/not one of the two speech models/).first().waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false);
    check('a file altered by four bytes is refused by its checksum, and nothing is kept', refused && (await listModels()).length === 0, (await listModels()).join(', '));

    // The real one, from a file: told apart by its hash, whatever the button it came from.
    await app2.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, join(modelsDir, FAST));
    await window2.getByTestId('captions-import-model').click();
    await window2.getByText('The model was imported and checked.').first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => undefined);
    await sleep(300);
    const afterImport = await window2.evaluate(() => window.__scfCaptions.models.getState().status.models.map((model) => `${model.id}:${model.present}`));
    check('the real Fast model imported from a file is recognised as Fast and verified', afterImport.join('|') === 'precise:false|fast:true'
      && (await listModels()).join('|') === `${FAST}|${FAST}.verified`, `${afterImport.join(', ')} - ${(await listModels()).join(', ')}`);
    await window2.getByTestId('captions-download-cancel').click().catch(() => undefined);
    await window2.keyboard.press('Escape');
    await sleep(300);

    await app2.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window2.getByTestId('speech-model-delete-fast').click();
    await window2.waitForFunction(() => document.querySelector('[data-testid="speech-model-fast"]').dataset.present === 'false', null, { timeout: 10_000 }).catch(() => undefined);
    check('Delete removes it from the disk', (await listModels()).length === 0, (await listModels()).join(', '));
    check('none of this used the network', (await second.mainRequests()).length === 0);

    if (real || !packagedExe) {
      console.log(real ? '14. a real download of the Fast model (190 MB), from Hugging Face' : '14. downloading: the Fast model, from a server on this computer');
      await window2.getByTestId('speech-model-download-fast').click();
      await prompt.waitFor({ state: 'visible', timeout: 5_000 });
      await window2.getByTestId('captions-download-confirm').click();
      let sawProgress = '';
      for (let tries = 0; tries < 2400; tries += 1) {
        const line = await window2.getByTestId('captions-download-progress').innerText().catch(() => '');
        if (line && !sawProgress) { sawProgress = line; await shot(window2, 'captions-downloading-en.png'); }
        if (await window2.evaluate(() => window.__scfCaptions.models.getState().downloading === null)) break;
        await sleep(250);
      }
      const present = await window2.evaluate(() => window.__scfCaptions.models.getState().status.models.find((model) => model.id === 'fast').present);
      const { stdout } = await execFileAsync('certutil', ['-hashfile', join(emptyModels, FAST), 'SHA256']).catch(() => ({ stdout: '' }));
      const hash = stdout.split(/\r?\n/)[1]?.replace(/\s/g, '').toLowerCase();
      check('it downloads with progress, and what arrives has the SHA-256 fixed in the app',
        present && /Downloading: \d+% \(.+ of 190 MB\)/.test(sawProgress) && hash === 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb', `${sawProgress} - ${hash}`);
      const asked = await second.mainRequests();
      const hosts = [...new Set(asked.map((url) => new URL(url).host))];
      if (real) {
        check('the only requests were for that file: huggingface.co and the host it redirects to', hosts.length >= 1 && hosts.length <= 3 && hosts[0] === 'huggingface.co'
          && asked[0] === `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${FAST}`, hosts.join(', '));
      } else {
        check('the only requests were for that file: asked for once, followed through its redirect', asked.length === 2 && asked[0] === `${base}/${FAST}` && asked[1].endsWith(`/cdn/${FAST}`)
          && served.join('|') === `/resolve/${FAST}|/cdn/${FAST}`, asked.join(' -> '));
      }
      // A download cancelled part-way leaves nothing.
      await window2.getByTestId('speech-model-download-precise').click();
      await prompt.waitFor({ state: 'visible', timeout: 5_000 });
      await window2.getByTestId('captions-download-confirm').click();
      await window2.waitForFunction(() => (window.__scfCaptions.models.getState().downloading?.received ?? 0) > 3_000_000, null, { timeout: 120_000 }).catch(() => undefined);
      const partial = (await listModels()).includes(`${PRECISE}.part`);
      await window2.getByTestId('captions-download-cancel').click();
      await sleep(1500);
      check('a download cancelled part-way leaves no half file', partial && !(await listModels()).some((name) => name.startsWith(PRECISE)), (await listModels()).join(', '));
      await window2.getByTestId('speech-model-delete-fast').click();
      await sleep(500);
    }
    check('no errors in the console', second.issues.length === 0, second.issues.slice(0, 3).join(' | '));
  } finally {
    await second.app.close().catch(() => undefined);
    server.close();
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
