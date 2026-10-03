import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Captions, phase 3, in the running app: `npm run test:captions-f3:ui`
 *
 *   1. the Style tab's Animation section;
 *   2. word by word, in the picture: the colour on the word being said at
 *      each word's frame, karaoke's fill, words appearing, a few at a time,
 *      the box - measured in the exact render against where layout put
 *      each word; a caption typed over keeps its timing;
 *   3. preview and export identical, pixel for pixel, on frames where words
 *      are moving - and a real PNG export of them;
 *   4. what it costs: a picture is drawn only when the words change;
 *   5. two tracks - Spanish and English typed by hand - out of one export:
 *      two streams with their languages and names, two files, one burnt in;
 *   6. the glossary: a suggestion, replace everywhere, undo;
 *   7. Generate for the marked range onto an existing track, with the
 *      glossary and the voice detector, and once with it switched off;
 *   8. the same in Spanish;
 *   and no request leaves the computer.
 *
 * Needs the engine and the Fast model where the other captions tests keep
 * them (build/whisper, .whisper-dev/models, .whisper-dev/vad). The window is
 * never shown (SCF_BACKGROUND). Screenshots go to CAPTIONS_SHOTS.
 * CAPTIONS_PACKAGED=1 runs the packaged app (release/win-unpacked).
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'captions-f3');
const shotsDir = process.env.CAPTIONS_SHOTS ?? '';
const packagedExe = process.env.CAPTIONS_PACKAGED === '1' ? join(projectRoot, 'release/win-unpacked/STOOK CREATOR FILMS.exe') : null;
const whisperDir = process.env.CAPTIONS_WHISPER_DIR ?? join(projectRoot, 'build', 'whisper');
const engineDir = packagedExe ? join(projectRoot, 'release/win-unpacked/resources/whisper') : whisperDir;
const modelsDir = process.env.CAPTIONS_MODELS_DIR ?? join(projectRoot, '.whisper-dev', 'models');
const devVad = process.env.CAPTIONS_VAD ?? join(projectRoot, '.whisper-dev', 'vad', 'ggml-silero-v6.2.0.bin');
const engineHasVad = existsSync(engineDir) && readdirSync(engineDir).some((file) => /^ggml-silero-.*\.bin$/i.test(file));

const W = 1920;
const H = 1080;
const FPS = 30;
const CYAN = [0, 229, 255];
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

const toBuffer = (b64) => Buffer.from(b64, 'base64');

/** The export's picture of a frame. */
const exactFrame = (window, frame) =>
  window
    .evaluate(async (at) => {
      const renderer = window.__scfRenderer();
      const project = window.__scfStore.getState().project;
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, at ?? project.currentFrame, false);
        let binary = '';
        for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
        return btoa(binary);
      } finally {
        renderer.endExclusive();
      }
    }, frame)
    .then(toBuffer);

/** The viewer's picture of the frame the playhead is on. */
const viewerFrame = (window) =>
  window
    .evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      for (let i = 0; i < 3; i += 1) await new Promise((done) => requestAnimationFrame(done));
      renderer.drawViewport(project, false, false);
      const rgba = renderer.compositor.readPixels(false);
      let binary = '';
      for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
      return btoa(binary);
    })
    .then(toBuffer);

const setFrame = (window, frame) => window.evaluate((at) => window.__scfStore.getState().setCurrentFrame(at), frame);

/** Pixels close to a colour, in a region (default: the whole frame). */
function colourBox(rgba, [r, g, b], tolerance = 40, region = { x: 0, y: 0, width: W, height: H }) {
  let count = 0;
  let left = W;
  let right = -1;
  let top = H;
  let bottom = -1;
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(H, region.y + region.height); y += 1) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(W, region.x + region.width); x += 1) {
      const i = (y * W + x) * 4;
      if (Math.abs(rgba[i] - r) <= tolerance && Math.abs(rgba[i + 1] - g) <= tolerance && Math.abs(rgba[i + 2] - b) <= tolerance) {
        count += 1;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return { count, left, right, top, bottom, centre: (left + right) / 2 };
}

/** Anything that is not the grey background: letters, outline, band. */
function inkBox(rgba, region = { x: 0, y: 0, width: W, height: H }) {
  let count = 0;
  let left = W;
  let right = -1;
  let top = H;
  let bottom = -1;
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(H, region.y + region.height); y += 1) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(W, region.x + region.width); x += 1) {
      const i = (y * W + x) * 4;
      if (Math.abs(rgba[i] - 96) + Math.abs(rgba[i + 1] - 96) + Math.abs(rgba[i + 2] - 96) > 60) {
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

const worstRgb = (a, b) => {
  if (a.length !== b.length) return 255;
  let worst = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(a[i + c] - b[i + c]));
  return worst;
};

const depthOf = (window) => window.evaluate(() => window.__scfHistory.getState().undoStack.length);
const undo = (window) => window.evaluate(() => window.__scfStore.getState().undo());

/** What a transcription would leave: a word every 0.4 s, each 0.33 s long. */
function cue(start, text, hold = 0.5) {
  const parts = text.replace(/\n/g, ' ').split(' ');
  const words = parts.map((word, index) => ({ text: word, start: start + index * 0.4, end: start + index * 0.4 + 0.33 }));
  return { start, end: words[words.length - 1].end + hold, lines: text.split('\n'), words };
}

const CUES = [cue(1, 'Hoy vamos a editar'), cue(3.5, 'un video corto sobre la ciudad'), cue(6.5, 'El color también importa.\nUna toma oscura mejora mucho.')];

const fold = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
function wordErrors(reference, hypothesis) {
  const n = reference.length;
  const m = hypothesis.length;
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i += 1) table[i][0] = i;
  for (let j = 0; j <= m; j += 1) table[0][j] = j;
  for (let i = 1; i <= n; i += 1) for (let j = 1; j <= m; j += 1) table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
  return { errors: table[n][m], rate: n > 0 ? table[n][m] / n : 0 };
}

/** The streams ffmpeg reads in a file, each with its metadata lines. */
async function streamsOf(file) {
  const probe = await execFileAsync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).catch((error) => ({ stderr: error.stderr ?? '' }));
  const blocks = [];
  for (const line of (probe.stderr ?? '').split(/\r?\n/)) {
    if (/^\s*Stream #/.test(line)) blocks.push({ line: line.trim(), meta: {} });
    else if (blocks.length > 0) {
      const match = /^\s+(\w+)\s*:\s*(.*)$/.exec(line);
      if (match && !/^(Stream|Metadata)$/.test(match[1])) blocks[blocks.length - 1].meta[match[1]] ??= match[2].trim();
    }
  }
  return blocks;
}

async function main() {
  for (const needed of [join(engineDir, 'whisper-cli.exe'), join(modelsDir, 'ggml-small-q5_1.bin'), ...(engineHasVad ? [] : [devVad]), ...(packagedExe ? [packagedExe] : [])]) {
    if (!existsSync(needed)) {
      console.error(`Missing ${needed}. See the header of tests/ui/captions-f3.mjs.`);
      process.exit(2);
    }
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });

  console.log('0. a grey picture, and a Spanish recording with a known text');
  const still = join(workDir, 'grey.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}`, '-frames:v', '1', still]);
  const ttsDir = join(workDir, 'tts');
  await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'tests', 'bench', 'captions-tts.ps1'), '-Out', ttsDir]);
  const speech = join(ttsDir, 'speech.wav');
  const truth = JSON.parse((await readFile(join(ttsDir, 'speech.json'), 'utf8')).replace(/^﻿/, ''));
  const truthWords = [...truth.words].sort((a, b) => a.char - b.char).map((word) => ({ text: fold(word.text)[0], ms: word.startMs })).filter((word) => word.text);

  const profileArg = `--user-data-dir=${join(workDir, 'profile')}`;
  console.log(packagedExe ? `   the packaged app: ${packagedExe}` : '   the development build');
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
      SCF_WHISPER_DIR: packagedExe ? undefined : whisperDir,
      SCF_WHISPER_MODELS_DIR: modelsDir,
      SCF_WHISPER_VAD: engineHasVad ? undefined : devVad,
    },
  });
  const issues = [];
  const requests = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    window.on('request', (request) => requests.push(request.url()));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ session }) => {
      globalThis.__scfRequests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (/^(https?|wss?|ftp):/i.test(details.url)) globalThis.__scfRequests.push(details.url);
        callback({});
      });
      session.defaultSession.enableNetworkEmulation({ offline: true });
    });

    await window.evaluate(([w, h, fps]) => window.__scfStore.getState().setProjectSettings({ width: w, height: h, fps }), [W, H, FPS]);
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [still, speech]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 30_000 });
    const ids = await window.evaluate((cues) => {
      const store = window.__scfStore.getState();
      store.setUi({ snappingEnabled: false });
      const video = store.project.tracks.find((track) => track.type === 'video' && track.order === 0);
      const audio = store.project.tracks.find((track) => track.type === 'audio');
      const stillId = store.addAssetToTimeline(store.assets.find((asset) => asset.kind === 'image'), video.id, 0);
      window.__scfStore.getState().updateClip(stillId, { durationFrames: 2700 });
      const speechId = window.__scfStore.getState().addAssetToTimeline(window.__scfStore.getState().assets.find((asset) => asset.kind === 'audio'), audio.id, 0);
      // Muted on the speakers; the job hears the mix as an export would, unmuted.
      const trackId = window.__scfStore.getState().addCaptionTrack({ cues, offsetFrame: 0, sourceTrackId: audio.id }, { preset: 'classic', language: 'es' });
      window.__scfStore.getState().selectClips([]);
      const captions = Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.trackId === trackId).sort((a, b) => a.startFrame - b.startFrame);
      return { trackId, speechId, captions: captions.map((clip) => ({ id: clip.id, start: clip.startFrame, end: clip.startFrame + clip.durationFrames })) };
    }, CUES);
    const [c0, c1, c2] = ids.captions;
    /** The frame word `k` of a cue is said on. */
    const said = (cueIndex, k) => Math.round((CUES[cueIndex].start + k * 0.4) * FPS);

    console.log('1. the Style tab: Animation');
    await window.getByTestId('media-panel').getByRole('tab', { name: 'Captions' }).click();
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), c0.id);
    await setFrame(window, said(0, 1));
    await sleep(500);
    const inspector = window.getByTestId('inspector-panel');
    await inspector.getByRole('tab', { name: 'Style' }).click();
    const section = window.locator('section[data-section="captionAnimation"]');
    const header = section.locator('button[aria-expanded]').first();
    if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
    const depthBefore = await depthOf(window);
    await section.getByRole('switch').first().check();
    await sleep(200);
    const kinds = await window.getByTestId('caption-style-animation').locator('option').allInnerTexts();
    check('Animation lists still and the five kinds',
      kinds.join('|') === 'Still, as subtitles are|The word said takes the colour|A box on the word said|Karaoke: the colour fills them|Words appear as they are said|A few words at a time, large', kinds.join(' / '));
    await window.getByTestId('caption-style-animation-color').fill('#00e5ff');
    await sleep(200);
    const animation = await window.evaluate((id) => window.__scfStore.getState().project.tracks.find((track) => track.id === id).captions.animation, ids.trackId);
    check('switched on it is the word said in colour, with bounce; the colour chosen is the track\'s', JSON.stringify(animation) === JSON.stringify({ kind: 'highlight', color: '#00e5ff', bounce: true, perPage: 2 }),
      JSON.stringify(animation));
    check('as undo steps of their own', (await depthOf(window)) === depthBefore + 2, `${depthBefore} -> ${await depthOf(window)}`);
    await window.getByTestId('caption-style-animation').selectOption('words');
    const perPage = await window.getByTestId('caption-style-per-page-2').getAttribute('aria-pressed');
    await window.getByTestId('caption-style-per-page-3').click();
    const three = await window.evaluate((id) => window.__scfStore.getState().project.tracks.find((track) => track.id === id).captions.animation, ids.trackId);
    await window.getByTestId('caption-style-animation').selectOption('karaoke');
    const bounceShown = await window.getByTestId('caption-style-bounce').count();
    check('a few words at a time asks how many (2, then 3); karaoke keeps the colour and has no bounce',
      perPage === 'true' && three.kind === 'words' && three.perPage === 3 && bounceShown === 0
        && (await window.evaluate((id) => window.__scfStore.getState().project.tracks.find((track) => track.id === id).captions.animation.color, ids.trackId)) === '#00e5ff',
      `${perPage} ${JSON.stringify(three)} bounce rows ${bounceShown}`);
    await window.getByTestId('caption-style-animation').selectOption('highlight');
    await shot(window, 'f3-style-animation-en.png');

    // Set straight on the store from here: the control was checked above.
    const animate = (patch) => window.evaluate(([id, change]) => {
      const store = window.__scfStore.getState();
      const current = store.project.tracks.find((track) => track.id === id).captions.animation;
      store.setCaptionAnimation(id, { ...current, ...change });
    }, [ids.trackId, patch]);
    const layout = (clipId, frame) => window.evaluate(([id, at]) => window.__scfCaptions.wordLayout(id, at), [clipId, frame]);

    console.log('2. word by word, in the picture');
    // Wait for the fonts: the first exact render loads them.
    await exactFrame(window, said(0, 0) + 10);
    const seated = [];
    for (let k = 0; k < 4; k += 1) {
      const frame = said(0, k) + 10;
      const picture = await exactFrame(window, frame);
      const word = (await layout(c0.id, frame)).pages[0][k];
      const cyan = colourBox(picture, CYAN);
      const inside = cyan.count > 150 && cyan.centre >= word.x && cyan.centre <= word.x + word.width && cyan.left >= word.x - word.width * 0.1 - 4 && cyan.right <= word.x + word.width * 1.1 + 4;
      seated.push({ k, frame, inside, count: cyan.count, span: `${cyan.left}-${cyan.right}`, word: `${word.text} ${Math.round(word.x)}-${Math.round(word.x + word.width)}` });
    }
    check('highlight: at each word\'s frame the colour is on that word and nowhere else', seated.every((entry) => entry.inside), seated.map((entry) => `${entry.word}: ${entry.span} (${entry.count})`).join('; '));
    await setFrame(window, said(0, 2) + 10);
    await shot(window, 'f3-highlight-en.png');
    const stillPicture = await exactFrame(window, said(0, 2) + 10);
    const settledScale = (await layout(c0.id, said(0, 2) + 10)).words[2].scale;
    const springing = (await layout(c0.id, said(0, 2) + 3)).words[2].scale;
    check('the word said springs larger and settles at its emphasis (the interface\'s bounce)', springing > 1 && settledScale > 1.1 && settledScale < 1.13, `${springing.toFixed(3)} at 3 frames, ${settledScale.toFixed(3)} settled`);

    // Karaoke: half way through a word, its left half is coloured.
    await animate({ kind: 'karaoke', bounce: false });
    const half = said(0, 2) + 5;
    const kState = await layout(c0.id, half);
    const kWord = kState.pages[0][2];
    const kPicture = await exactFrame(window, half);
    const kInWord = colourBox(kPicture, CYAN, 40, { x: kWord.x - 4, y: kWord.baseline - kWord.size, width: kWord.width + 8, height: kWord.size * 1.3 });
    const kBefore = colourBox(kPicture, CYAN, 40, { x: kState.pages[0][1].x - 4, y: kWord.baseline - kWord.size, width: kState.pages[0][1].width + 8, height: kWord.size * 1.3 });
    const reach = kWord.x + kWord.width * kState.words[2].fill;
    check('karaoke: what was said is coloured; the word being said is coloured from its left edge as far as it has got',
      kBefore.count > 100 && kInWord.count > 20 && Math.abs(kInWord.left - kWord.x) <= 6 && Math.abs(kInWord.right - reach) <= 12 && kState.words[2].fill > 0.3 && kState.words[2].fill < 0.7,
      `fill ${kState.words[2].fill.toFixed(2)}, coloured to ${kInWord.right} (expected ${Math.round(reach)}), word ${Math.round(kWord.x)}-${Math.round(kWord.x + kWord.width)}`);
    await setFrame(window, half);
    await shot(window, 'f3-karaoke-en.png');

    // Appear: nothing of a word before it is said.
    await animate({ kind: 'appear', bounce: true });
    const aWord = (await layout(c0.id, said(0, 2))).pages[0][2];
    // Inside its letters, clear of the shadow and outline of the words beside it.
    const wordRegion = { x: aWord.x + 6, y: aWord.baseline - aWord.size * 0.8, width: Math.max(1, aWord.width - 12), height: aWord.size };
    const beforeIt = inkBox(await exactFrame(window, said(0, 2) - 1), wordRegion);
    const afterIt = inkBox(await exactFrame(window, said(0, 2) + 10), wordRegion);
    check('appear: a word is not there the frame before it is said, and is after', beforeIt.count === 0 && afterIt.count > 200, `${beforeIt.count} then ${afterIt.count} ink pixels`);

    // A few words at a time: only the page of the word being said, larger.
    await animate({ kind: 'words', perPage: 2, bounce: true });
    const wFrame = said(1, 2) + 10;
    const wState = await layout(c1.id, wFrame);
    const page = wState.pages[wState.page];
    const wInk = inkBox(await exactFrame(window, wFrame));
    const pageLeft = Math.min(...page.map((word) => word.x));
    const pageRight = Math.max(...page.map((word) => word.x + word.width));
    check('a few at a time: only the page with the word being said is drawn, in larger letters',
      page.map((word) => word.text).join(' ') === 'corto sobre' && wInk.left >= pageLeft - 40 && wInk.right <= pageRight + 40 && page[0].size >= 90,
      `page "${page.map((word) => word.text).join(' ')}" ${Math.round(pageLeft)}-${Math.round(pageRight)}, ink ${wInk.left}-${wInk.right}, ${page[0].size} px`);
    await setFrame(window, wFrame);
    await shot(window, 'f3-words-en.png');

    // The box behind the word being said.
    await animate({ kind: 'box', bounce: true });
    const bFrame = said(0, 3) + 10;
    const bWord = (await layout(c0.id, bFrame)).pages[0][3];
    const box = colourBox(await exactFrame(window, bFrame), CYAN);
    check('box: a box in the colour stands behind the word being said',
      box.count > bWord.width * bWord.size * 0.4 && box.left <= bWord.x && box.right >= bWord.x + bWord.width && box.left >= bWord.x - bWord.size * 0.4,
      `${box.count} px, ${box.left}-${box.right} around ${Math.round(bWord.x)}-${Math.round(bWord.x + bWord.width)}`);
    await setFrame(window, said(0, 3) + 3);
    await shot(window, 'f3-box-en.png');

    // A caption typed over keeps its timing: the corrected word takes its place's.
    await animate({ kind: 'highlight', bounce: false });
    await window.evaluate((id) => window.__scfStore.getState().setCaptionText(id, 'Hoy vamos a montar'), c0.id);
    const eFrame = said(0, 3) + 10;
    const eState = await layout(c0.id, eFrame);
    const eWord = eState.pages[0][3];
    const eCyan = colourBox(await exactFrame(window, eFrame), CYAN);
    check('typed over, the new word is coloured when the old one was said', eWord.text === 'montar' && eState.active === 3 && eCyan.centre >= eWord.x && eCyan.centre <= eWord.x + eWord.width,
      `${eWord.text} at ${Math.round(eWord.x)}-${Math.round(eWord.x + eWord.width)}, colour ${eCyan.left}-${eCyan.right}`);
    await undo(window);

    console.log('3. the viewer and the export, on frames where words move');
    const frames = [];
    for (const [kind, extra] of [['highlight', { bounce: true }], ['box', { bounce: true }], ['karaoke', { bounce: false }], ['appear', { bounce: true }], ['words', { bounce: true, perPage: 2 }]]) {
      await animate({ kind, ...extra });
      for (const frame of [said(0, 1) + 2, said(0, 2) + 4, said(2, 6) + 3]) {
        await setFrame(window, frame);
        const viewer = await viewerFrame(window);
        const exact = await exactFrame(window, frame);
        frames.push({ kind, frame, worst: worstRgb(viewer, exact), ink: inkBox(exact).count });
      }
    }
    check('fifteen moving frames, five kinds: the viewer and the exact render are identical, pixel for pixel',
      frames.every((entry) => entry.worst === 0 && entry.ink > 500), frames.filter((entry) => entry.worst !== 0 || entry.ink <= 500).map((entry) => `${entry.kind}@${entry.frame}: ${entry.worst} (${entry.ink})`).join('; ') || `${frames.length} frames`);

    // A real export: PNG frames in the middle of a spring, against the viewer.
    await animate({ kind: 'highlight', bounce: true });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportDir);
    const openExport = async (format, name, range) => {
      await window.evaluate(([value, start, end]) => window.__scfStore.getState().setExportSettings({ format: value, exportAlpha: false, startFrame: start, endFrame: end }), [format, ...range]);
      await window.getByRole('button', { name: 'Export', exact: true }).click();
      const dialog = window.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByLabel('Start frame').fill(String(range[0]));
      await dialog.getByLabel('End frame').fill(String(range[1]));
      await dialog.getByLabel('File name').fill(name);
      await dialog.getByRole('button', { name: 'Browse' }).click();
      await sleep(500);
      return dialog;
    };
    const finish = async (dialog) => {
      await dialog.getByRole('button', { name: 'Start export' }).click();
      const finished = await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 240_000 }).then(() => true).catch(() => false);
      const card = finished ? (await window.getByTestId('export-result').innerText()).replace(/\s+/g, ' ') : '';
      return { finished, card };
    };
    const pngRange = [said(0, 1), said(0, 1) + 6];
    let dialog = await openExport('png-sequence', 'moving', pngRange);
    const png = await finish(dialog);
    await dialog.getByTitle('Close').click();
    await sleep(300);
    const pngs = [];
    const walk = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(folder, entry.name));
        else if (entry.name.endsWith('.png')) pngs.push(join(folder, entry.name));
      }
    };
    await walk(exportDir);
    pngs.sort();
    const compared = [];
    for (let i = 0; i < pngs.length; i += 1) {
      const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-i', pngs[i], '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      await setFrame(window, pngRange[0] + i);
      compared.push(worstRgb(stdout, await viewerFrame(window)));
    }
    check('a PNG export of six frames of a spring: each identical to the viewer at that frame, pixel for pixel',
      png.finished && pngs.length === 6 && compared.every((worst) => worst === 0), `${pngs.length} files, worst differences ${compared.join(', ')}`);

    console.log('4. what it costs');
    await animate({ kind: 'highlight', bounce: false });
    const drawnBefore = await window.evaluate(() => window.__scfCaptions.wordsDrawn());
    for (let frame = c0.start; frame < c0.end; frame += 1) {
      await setFrame(window, frame);
      await window.evaluate(() => {
        const renderer = window.__scfRenderer();
        renderer.drawViewport(window.__scfStore.getState().project, false, false);
      });
    }
    const drawnStill = (await window.evaluate(() => window.__scfCaptions.wordsDrawn())) - drawnBefore;
    check('without bounce, a caption of four words is drawn four times over its frames, not once a frame', drawnStill <= 5, `${drawnStill} pictures over ${c0.end - c0.start} frames`);

    console.log('5. two tracks: Spanish, and English typed by hand');
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await window.getByTestId('transcript-new-track').click();
    await sleep(300);
    const english = await window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      const track = [...project.tracks].filter((candidate) => candidate.type === 'captions').sort((a, b) => b.order - a.order)[0];
      return { id: track.id, name: track.name, language: track.captions.language };
    });
    const emptyShown = await window.getByTestId('transcript-empty-track').isVisible().catch(() => false);
    check('New captions track: an empty track, in the interface\'s language, that says how to start', english.name === 'Captions 2' && english.language === 'en' && emptyShown, JSON.stringify(english));
    const typed = [];
    for (const [frame, text] of [[c0.start + 3, 'Today we are editing'], [130, 'a short video about the city']]) {
      await setFrame(window, frame);
      await window.getByTestId('transcript-add').click();
      const editor = window.getByTestId('transcript-edit');
      const shown = await editor.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
      if (!shown) {
        console.log('   (debug)', JSON.stringify(await window.evaluate((id) => {
          const state = window.__scfStore.getState();
          return {
            selected: state.ui.selectedClipIds,
            onTrack: Object.values(state.project.clips).filter((clip) => clip.trackId === id).map((clip) => [clip.startFrame, clip.durationFrames, clip.caption?.text]),
            rows: document.querySelectorAll('[data-testid="transcript-row"]').length,
            active: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
          };
        }, english.id)));
        throw new Error('no editor');
      }
      await editor.fill(text);
      await editor.press('Enter');
      await sleep(200);
    }
    typed.push(...(await window.evaluate((id) => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.trackId === id).sort((a, b) => a.startFrame - b.startFrame).map((clip) => clip.caption.text), english.id)));
    check('Add a caption at the playhead, typed straight away: two English captions', typed.join('|') === 'Today we are editing|a short video about the city', typed.join(' | '));
    await shot(window, 'f3-two-tracks-en.png');
    // At the top, so which track is in the picture can be told apart.
    await window.evaluate((id) => window.__scfStore.getState().setCaptionLook(id, { position: 'top' }), english.id);

    const twoRange = [0, c1.end + 10];
    dialog = await openExport('mp4-h264', 'two-tracks', twoRange);
    const burnTracks = await dialog.getByTestId('export-captions-burn-track').count();
    await dialog.locator(`[data-testid="export-captions-burn-track"][data-track="${english.id}"]`).uncheck();
    await dialog.getByTestId('export-captions-embed').check();
    await dialog.getByTestId('export-captions-file').selectOption('srt');
    const groupText = (await dialog.locator('section', { has: window.getByTestId('export-captions-burn') }).innerText()).replace(/\s+/g, ' ');
    check('with two tracks, the export asks which to burn in, and says each goes in as a stream and a file of its own',
      burnTracks === 2 && /Captions 1 \(Spanish\)/.test(groupText) && /Captions 2 \(English\)/.test(groupText) && /a stream of its own, tagged with its language/.test(groupText) && /two-tracks\.es\.srt/.test(groupText),
      groupText.slice(0, 220));
    await shot(window, 'f3-export-two-tracks-en.png');
    const mp4 = await finish(dialog);
    await dialog.getByTitle('Close').click();
    await sleep(300);
    const video = join(exportDir, 'two-tracks.mp4');
    const streams = await streamsOf(video);
    const subs = streams.filter((stream) => /Subtitle/.test(stream.line));
    // Top first, as on the timeline: the English track was made last, above the Spanish one.
    check('the MP4 has two subtitle streams, mov_text: English named "Captions 2", then Spanish named "Captions 1"',
      // An MP4 keeps a track's name as its handler name (ffmpeg prints it so).
      mp4.finished && subs.length === 2 && /\(eng\): Subtitle: mov_text/.test(subs[0].line) && subs[0].meta.handler_name === 'Captions 2' && /\(spa\): Subtitle: mov_text/.test(subs[1].line) && subs[1].meta.handler_name === 'Captions 1',
      subs.map((stream) => `${stream.line.replace(/\s+/g, ' ').slice(0, 64)} name=${stream.meta.handler_name}`).join(' | '));
    const readBack = async (index) => {
      const out = join(workDir, `stream-${index}.srt`);
      await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', video, '-map', `0:s:${index}`, out]).catch(() => undefined);
      const text = existsSync(out) ? await readFile(out, 'utf8') : '';
      return [...text.matchAll(/-->[^\n]*\r?\n([^]*?)(?:\r?\n\r?\n|$)/g)].map((match) => match[1].trim().replace(/\r?\n/g, ' '));
    };
    const englishInside = await readBack(0);
    const spanishInside = await readBack(1);
    const expectedOf = (trackId) => window.evaluate(([id, start, end]) => window.__scfCaptions.captionCues(window.__scfStore.getState().project, { trackId: id, fromFrame: start, toFrame: end }).map((cue) => cue.text.replace(/\n/g, ' ')), [trackId, ...twoRange]);
    const expectedSpanish = await expectedOf(ids.trackId);
    const expectedEnglish = await expectedOf(english.id);
    check('each stream read back holds its own track\'s captions, those of the range', expectedSpanish.length === 3 && spanishInside.join('|') === expectedSpanish.join('|') && englishInside.join('|') === expectedEnglish.join('|') && expectedEnglish.join('|') === 'Today we are editing|a short video about the city',
      `${spanishInside.join(' / ')} || ${englishInside.join(' / ')}`);
    const esFile = join(exportDir, 'two-tracks.es.srt');
    const enFile = join(exportDir, 'two-tracks.en.srt');
    const esText = existsSync(esFile) ? await readFile(esFile, 'utf8') : '';
    const enText = existsSync(enFile) ? await readFile(enFile, 'utf8') : '';
    check('and a file each beside it, named with its language: two-tracks.es.srt and two-tracks.en.srt',
      /Hoy vamos a editar/.test(esText) && !/Today/.test(esText) && /Today we are editing/.test(enText) && !/Hoy/.test(enText) && !existsSync(join(exportDir, 'two-tracks.srt')),
      `${existsSync(esFile)} ${existsSync(enFile)}; card: ${mp4.card.slice(-110)}`);
    const { stdout: twoFrame } = await execFileAsync(ffmpeg, ['-v', 'error', '-ss', String((c0.start + 20) / FPS), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const top = inkBox(twoFrame, { x: 0, y: 0, width: W, height: H * 0.3 });
    const bottom = inkBox(twoFrame, { x: 0, y: H * 0.7, width: W, height: H * 0.3 });
    await setFrame(window, c0.start + 20);
    const viewerTop = inkBox(await viewerFrame(window), { x: 0, y: 0, width: W, height: H * 0.3 });
    check('only the Spanish track is burnt in: nothing at the top of the picture, where the viewer shows the English one',
      top.count < 200 && bottom.count > 1000 && viewerTop.count > 1000, `export top ${top.count}, bottom ${bottom.count}; viewer top ${viewerTop.count}`);

    console.log('6. the glossary');
    await window.evaluate(([id]) => window.__scfStore.getState().setCaptionText(id, 'Kratonis vende bicis.\nEn Kratonis son cien.'), [c2.id]);
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), c2.id);
    await sleep(200);
    await window.getByTestId('transcript-glossary-toggle').click();
    const glossaryBox = window.getByTestId('transcript-glossary-text');
    await glossaryBox.fill('Kratonix\nZorbelia');
    await glossaryBox.evaluate((element) => element.blur());
    await sleep(300);
    const saved = await window.evaluate(() => window.__scfStore.getState().project.glossary);
    const suggestion = await window.getByTestId('transcript-glossary-suggestion').first().innerText().catch(() => '');
    check('names and terms are kept with the project, and a word one letter away is offered: "Kratonis" -> "Kratonix" (2)',
      JSON.stringify(saved) === '["Kratonix","Zorbelia"]' && /“Kratonis” → “Kratonix” \(2\)/.test(suggestion), `${JSON.stringify(saved)} ${suggestion}`);
    await shot(window, 'f3-glossary-en.png');
    const glossaryDepth = await depthOf(window);
    await window.getByTestId('transcript-glossary-replace').first().click();
    await sleep(300);
    const replacedText = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].caption.text, c2.id);
    const toast = await window.getByText(/replaced: “Kratonis” is now “Kratonix”/).first().innerText().catch(() => '');
    check('Replace everywhere puts both right in one undo step, says so, and the suggestion goes',
      replacedText.replace(/\n/g, ' ') === 'Kratonix vende bicis. En Kratonix son cien.' && (await depthOf(window)) === glossaryDepth + 1 && /^2 replaced/.test(toast) && (await window.getByTestId('transcript-glossary-suggestion').count()) === 0,
      `${replacedText.replace(/\n/g, ' / ')} - ${toast}`);
    await undo(window);
    check('undo brings the misspelling back', (await window.evaluate((id) => window.__scfStore.getState().project.clips[id].caption.text, c2.id)).includes('Kratonis'));
    await window.getByTestId('transcript-glossary-toggle').click();

    console.log('7. Generate: the marked range, onto the Spanish track, with the glossary and the voice detector');
    await window.evaluate(([speechId]) => {
      const store = window.__scfStore.getState();
      store.setUi({ inFrame: 600, outFrame: 1200 });
      store.selectClips([speechId]);
    }, [ids.speechId]);
    const otherBefore = await window.evaluate((id) => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.trackId === id).map((clip) => `${clip.startFrame}:${clip.caption.text}`).sort(), ids.trackId);
    await appMenu(window, 'Timeline', 'Generate captions');
    const generate = window.getByTestId('captions-dialog');
    await generate.waitFor({ state: 'visible', timeout: 5_000 });
    const scopes = await generate.getByTestId('captions-scope').locator('option').allInnerTexts();
    const intoOptions = await generate.getByTestId('captions-into').locator('option').allInnerTexts();
    const glossaryValue = await generate.getByTestId('captions-glossary').inputValue();
    const vadOn = await generate.getByTestId('captions-vad').isChecked();
    check('the dialog asks what to listen to (all, the marks, the selected clip), where to put them, the names, and the voice detector (on)',
      scopes.join('|') === 'The whole timeline|Between the in and out marks|The selected clips (1)' && (await generate.getByTestId('captions-scope').inputValue()) === 'clips'
        && intoOptions.join('|') === 'A new captions track|The track “Captions 2”|The track “Captions 1”' && glossaryValue === 'Kratonix\nZorbelia' && vadOn,
      `${scopes.join(' / ')} | ${intoOptions.join(' / ')} | ${JSON.stringify(glossaryValue)} | vad ${vadOn}`);
    await generate.getByTestId('captions-scope').selectOption('range');
    await generate.getByTestId('captions-into').selectOption(ids.trackId);
    await generate.getByTestId('captions-model').selectOption('fast');
    await generate.getByTestId('captions-language').selectOption('es');
    await shot(window, 'f3-generate-en.png');
    const generateDepth = await depthOf(window);
    await window.evaluate(() => window.__scfCaptions.job.setState({ last: null }));
    await generate.getByTestId('captions-generate').click();
    await window.waitForFunction(() => window.__scfCaptions.job.getState().phase !== 'idle', null, { timeout: 30_000 }).catch(() => undefined);
    await window.waitForFunction(() => window.__scfCaptions.job.getState().phase === 'idle', null, { timeout: 600_000 });
    await sleep(300);
    const ranged = await window.evaluate((id) => {
      const { project } = window.__scfStore.getState();
      return Object.values(project.clips).filter((clip) => clip.trackId === id).sort((a, b) => a.startFrame - b.startFrame).map((clip) => ({ start: clip.startFrame, end: clip.startFrame + clip.durationFrames, text: clip.caption.text }));
    }, ids.trackId);
    const fresh = ranged.filter((clip) => clip.start >= 600);
    const kept = ranged.filter((clip) => clip.start < 600).map((clip) => `${clip.start}:${clip.text}`).sort();
    const last = await window.evaluate(() => window.__scfCaptions.job.getState().last);
    const reference = truthWords.filter((word) => word.ms >= 20_300 && word.ms < 39_500).map((word) => word.text);
    const heard = fold(fresh.map((clip) => clip.text).join(' '));
    const inRange = wordErrors(reference, heard);
    check('only the marked range was heard: its captions land between the marks, on the Spanish track, beside the ones it had',
      fresh.length >= 4 && fresh.every((clip) => clip.start >= 600 && clip.start < 1200 && clip.end <= 1230) && JSON.stringify(kept) === JSON.stringify(otherBefore) && last?.result.audioSeconds > 19 && last?.result.audioSeconds < 21,
      `${fresh.length} new, ${fresh[0]?.start}..${fresh[fresh.length - 1]?.end}; ${last?.result.audioSeconds?.toFixed(1)} s of sound heard`);
    check('and they say what was said there (word error rate under 15%, the cut words at either end included)', inRange.rate < 0.15, `${inRange.errors} errors in ${reference.length} words`);
    check('with the voice detector, as one undo step', last?.result.vadSegments > 0 && (await depthOf(window)) === generateDepth + 1, `${last?.result.vadSegments} stretches of speech; depth ${generateDepth} -> ${await depthOf(window)}`);
    await undo(window);
    check('undo takes the new captions back and leaves the others', JSON.stringify((await window.evaluate((id) => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.trackId === id).map((clip) => `${clip.startFrame}:${clip.caption.text}`).sort(), ids.trackId))) === JSON.stringify(otherBefore));

    // The voice detector switched off, onto a new track.
    await appMenu(window, 'Timeline', 'Generate captions');
    await generate.waitFor({ state: 'visible', timeout: 5_000 });
    await generate.getByTestId('captions-scope').selectOption('range');
    await generate.getByTestId('captions-into').selectOption('new');
    await generate.getByTestId('captions-model').selectOption('fast');
    await generate.getByTestId('captions-vad').uncheck();
    const offHint = await generate.getByText('Everything is listened to.', { exact: false }).isVisible().catch(() => false);
    await window.evaluate(() => window.__scfCaptions.job.setState({ last: null }));
    await generate.getByTestId('captions-generate').click();
    await window.waitForFunction(() => window.__scfCaptions.job.getState().phase !== 'idle', null, { timeout: 30_000 }).catch(() => undefined);
    await window.waitForFunction(() => window.__scfCaptions.job.getState().phase === 'idle', null, { timeout: 600_000 });
    const off = await window.evaluate(() => window.__scfCaptions.job.getState().last);
    const remembered = await window.evaluate(() => JSON.parse(window.localStorage.getItem('scf.captions.options') ?? '{}').vad);
    check('switched off, the job listens to everything (no voice detector), and the choice is remembered', offHint && off?.result && off.result.vadSegments === null && off.captions > 0 && remembered === false,
      `vad ${off?.result?.vadSegments}, ${off?.captions} captions, remembered ${remembered}`);
    await undo(window);
    await window.evaluate(() => {
      const options = JSON.parse(window.localStorage.getItem('scf.captions.options') ?? '{}');
      window.localStorage.setItem('scf.captions.options', JSON.stringify({ ...options, vad: true }));
      window.__scfStore.getState().setUi({ inFrame: null, outFrame: null });
      window.__scfStore.getState().selectClips([]);
    });

    console.log('8. in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), c0.id);
    await sleep(300);
    await inspector.getByRole('tab', { name: 'Estilo' }).click();
    const kindsEs = await window.getByTestId('caption-style-animation').locator('option').allInnerTexts();
    const sectionEs = await window.locator('section[data-section="captionAnimation"] h3').innerText();
    check('Estilo > Animación: quietas y los cinco tipos, en español',
      sectionEs === 'Animación' && kindsEs.join('|') === 'Quietas, como en un subtítulo|La palabra dicha toma el color|Un recuadro en la palabra dicha|Karaoke: el color las va llenando|Las palabras aparecen al decirse|Pocas palabras a la vez, grandes',
      `${sectionEs}: ${kindsEs.join(' / ')}`);
    await shot(window, 'f3-style-animation-es.png');
    const languagesEs = await window.getByTestId('transcript-language').locator('option').allInnerTexts();
    const addTip = await window.getByTestId('transcript-add').getAttribute('aria-label') ?? await window.getByTestId('transcript-add').getAttribute('data-tooltip');
    check('la lista: el idioma de la pista (Español, Inglés)', languagesEs.join('|') === 'Español|Inglés', `${languagesEs.join(' / ')} ${addTip ?? ''}`);
    await window.evaluate(([speechId]) => {
      window.__scfStore.getState().setUi({ inFrame: 600, outFrame: 1200 });
      window.__scfStore.getState().selectClips([speechId]);
    }, [ids.speechId]);
    await appMenu(window, 'Línea de tiempo', 'Generar subtítulos');
    await generate.waitFor({ state: 'visible', timeout: 5_000 });
    const labelsEs = await generate.locator('label.field-label').allInnerTexts();
    const vadEs = (await generate.locator('label', { has: window.getByTestId('captions-vad') }).innerText()).replace(/\s+/g, ' ');
    check('el diálogo: Qué se escucha, Dónde ponerlos, Nombres y términos, y «Escuchar solo donde se habla»',
      labelsEs.includes('Qué se escucha') && labelsEs.includes('Dónde ponerlos') && labelsEs.includes('Nombres y términos') && /Escuchar solo donde se habla/.test(vadEs),
      `${labelsEs.join(' / ')} | ${vadEs}`);
    await shot(window, 'f3-generate-es.png');
    await window.keyboard.press('Escape');
    await window.evaluate(() => {
      window.__scfStore.getState().setUi({ inFrame: null, outFrame: null });
      window.__scfStore.getState().selectClips([]);
      window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', startFrame: 0, endFrame: 90 });
    });
    await window.getByRole('button', { name: 'Exportar', exact: true }).click();
    const exportEs = window.getByRole('dialog', { name: 'Exportar' });
    await exportEs.getByTestId('export-captions-burn').waitFor({ state: 'visible', timeout: 10_000 });
    const groupEs = (await exportEs.locator('section', { has: window.getByTestId('export-captions-burn') }).innerText()).replace(/\s+/g, ' ');
    check('la exportación con dos pistas: cuáles se graban, cada una su pista y su archivo con su idioma',
      /Captions 1 \(Español\)/.test(groupEs) && /Captions 2 \(Inglés\)/.test(groupEs) && /Solo se dibujan en la imagen las pistas marcadas/.test(groupEs) && /Un archivo por pista/.test(groupEs),
      groupEs.slice(0, 220));
    await shot(window, 'f3-export-es.png');
    await exportEs.getByTitle('Cerrar').click();

    console.log('9. nothing left the computer');
    const remote = [...requests.filter((url) => /^(https?|wss?|ftp):/i.test(url)), ...(await app.evaluate(() => globalThis.__scfRequests.slice()))];
    check('no request was attempted', remote.length === 0, remote.slice(0, 3).join(' | '));
    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
    void stillPicture;
  } finally {
    await app.close().catch(() => undefined);
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
