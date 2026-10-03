import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Captions, phase 2, in the running app: `npm run test:captions-f2:ui`
 *
 * No speech engine here: the captions are put on the timeline with their
 * words and times, as a transcription leaves them, over a real video with
 * sound. Then:
 *
 *   1. the Captions tab of the Library: the list, its times, the playhead;
 *   2. typing in place: lines laid out again, the caret kept, one undo step,
 *      Shift+Enter for a break of the author's;
 *   3. find and replace: the count, one, all, one undo step;
 *   4. split at the playhead and merge, word times intact;
 *   5. warnings in the list, and Fix timing;
 *   6. the Style tab: the track's look, in the picture;
 *   7. export: burnt in - the exported frame against the viewer, pixel for
 *      pixel; a subtitle track inside the MP4, read back with ffmpeg, with
 *      its language; the .srt beside it;
 *   8. captions follow the edit: a clip moved, trimmed, deleted, cut;
 *   9. the same in Spanish;
 *   and no request leaves the computer.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to CAPTIONS_SHOTS.
 * CAPTIONS_PACKAGED=1 runs the packaged app (release/win-unpacked), as an
 * installed copy would, instead of the development build.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'captions-f2');
const shotsDir = process.env.CAPTIONS_SHOTS ?? '';
const packagedExe = process.env.CAPTIONS_PACKAGED === '1' ? join(projectRoot, 'release/win-unpacked/STOOK CREATOR FILMS.exe') : null;

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

/** Where pixels close to a colour are: the letters of a caption, or its band. */
function colourBox(rgba, width, height, [r, g, b], tolerance = 24) {
  let count = 0;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (Math.abs(rgba[i] - r) <= tolerance && Math.abs(rgba[i + 1] - g) <= tolerance && Math.abs(rgba[i + 2] - b) <= tolerance) {
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

const worstDifference = (a, b) => {
  let worst = a.length === b.length ? 0 : 255;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
};

/** The captions of the top captions track, in order. */
const captions = (window) =>
  window.evaluate(() => {
    const { project } = window.__scfStore.getState();
    const track = [...project.tracks].filter((candidate) => candidate.type === 'captions').sort((a, b) => b.order - a.order)[0];
    if (!track) return [];
    return Object.values(project.clips)
      .filter((clip) => clip.trackId === track.id && clip.caption)
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        start: clip.startFrame,
        end: clip.startFrame + clip.durationFrames,
        text: clip.caption.text,
        manual: clip.caption.manualBreaks === true,
        linked: clip.caption.link?.clipId ?? null,
        // When each word is spoken, in timeline frames.
        spoken: (clip.caption.words ?? []).map((word) => [word.text, Math.round(clip.startFrame + (word.start * project.fps - clip.sourceOffsetFrames) / (clip.speed ?? 1))]),
      }));
  });

const depthOf = (window) => window.evaluate(() => window.__scfHistory.getState().undoStack.length);
const undo = (window) => window.evaluate(() => window.__scfStore.getState().undo());
const rows = (window) => window.getByTestId('transcript-row');

/** What a transcription would leave: cues with a word every 0.4 s. */
function cue(start, text, hold = 0.4) {
  const parts = text.replace(/\n/g, ' ').split(' ');
  const words = parts.map((word, index) => ({ text: word, start: start + index * 0.4, end: start + index * 0.4 + 0.33 }));
  return { start, end: words[words.length - 1].end + hold, lines: text.split('\n'), words };
}

const CUES = [
  cue(1, 'Hoy vamos a editar'),
  cue(3, 'un video corto.'),
  cue(6, 'El video se exporta\ny el Video se comparte.'),
  cue(11, 'Gracias por acompañarnos.'),
  cue(14, 'Hasta la próxima.'),
];

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });
  // Twenty seconds of grey with a tone under it: a clip that has sound, for captions to follow.
  const still = join(workDir, 'grey.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}`, '-frames:v', '1', still]);
  const talk = join(workDir, 'talk.mp4');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}:r=${FPS}:d=20`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=20',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '128k', '-shortest', talk]);

  if (packagedExe && !existsSync(packagedExe)) {
    console.error(`Missing ${packagedExe}: pack the app first (CAPTIONS_PACKAGED=1).`);
    process.exit(2);
  }
  const profileArg = `--user-data-dir=${join(workDir, 'profile')}`;
  console.log(packagedExe ? `the packaged app: ${packagedExe}` : 'the development build');
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
    }, [talk, still]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 30_000 });
    // Its sound is pulled out of the file as it is imported: that is what says the clip can be followed.
    await window.waitForFunction(() => Boolean(window.__scfStore.getState().assets.find((asset) => asset.kind === 'video')?.audioUri), null, { timeout: 30_000 }).catch(() => undefined);
    const clipId = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      store.setUi({ snappingEnabled: false });
      const video = store.project.tracks.find((track) => track.type === 'video' && track.order === 0);
      const above = store.project.tracks.find((track) => track.type === 'video' && track.order === 1);
      const id = store.addAssetToTimeline(store.assets.find((asset) => asset.kind === 'video'), video.id, 0);
      // A grey still over the picture, for the whole of it: what the captions are drawn on,
      // the same to the viewer and to the export (a video is decoded by each in its own way).
      const stillId = window.__scfStore.getState().addAssetToTimeline(store.assets.find((asset) => asset.kind === 'image'), above.id, 0);
      window.__scfStore.getState().updateClip(stillId, { durationFrames: 900 });
      window.__scfStore.getState().selectClips([]);
      return id;
    });

    console.log('1. the Captions tab');
    const tabNames = await window.getByTestId('media-panel').getByRole('tab').allInnerTexts();
    check('the Library has a fourth tab: Media, Titles, Transitions, Captions', tabNames.join('|') === 'Media|Titles|Transitions|Captions', tabNames.join(' / '));
    await window.getByTestId('library-tab-captions').click();
    const empty = await window.getByTestId('transcript-empty').innerText();
    check('with no captions it says so, and offers to generate or import them', /No captions yet/.test(empty) && /Generate captions…/.test(empty) && /Import captions…/.test(empty), empty.replace(/\s+/g, ' '));
    await shot(window, 'f2-transcript-empty-en.png');
    await window.getByTestId('library-tab-media').click();

    const depth0 = await depthOf(window);
    await window.evaluate((cues) => {
      window.__scfStore.getState().addCaptionTrack({ cues, offsetFrame: 0 }, { preset: 'classic', language: 'es' });
      window.dispatchEvent(new CustomEvent('scf:library-tab', { detail: 'captions' }));
    }, CUES);
    await window.getByTestId('transcript-panel').waitFor({ state: 'visible', timeout: 5_000 });
    let list = await captions(window);
    const before = list;
    check('new captions bring their list forward: five rows, numbered, with their times and text',
      (await rows(window).count()) === 5 && (await window.getByTestId('library-tab-captions').getAttribute('aria-selected')) === 'true'
        && (await rows(window).nth(0).innerText()).replace(/\s+/g, ' ').trim() === '1 00:01:00 00:02:28 Hoy vamos a editar',
      (await rows(window).nth(0).innerText()).replace(/\s+/g, ' '));
    check('every caption is tied to the clip under it, in one undo step', list.every((caption) => caption.linked === clipId) && (await depthOf(window)) === depth0 + 1,
      `${list.filter((caption) => caption.linked === clipId).length}/5 tied`);
    check('the header counts them', (await window.getByTestId('transcript-count').innerText()) === '5 captions');

    await rows(window).nth(2).getByTestId('transcript-time').click();
    await sleep(200);
    const picked = await window.evaluate(() => ({ frame: window.__scfStore.getState().project.currentFrame, selected: window.__scfStore.getState().ui.selectedClipIds }));
    check('clicking a row\'s times moves the playhead to it and selects it', picked.frame === list[2].start && picked.selected.join() === list[2].id
      && (await rows(window).nth(2).getAttribute('data-active')) === 'true' && (await rows(window).nth(2).getAttribute('data-selected')) === 'true', JSON.stringify(picked));
    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), list[3].start + 5);
    await sleep(200);
    check('the row under the playhead is marked as the playhead moves', (await rows(window).nth(3).getAttribute('data-active')) === 'true' && (await rows(window).nth(2).getAttribute('data-active')) === 'false');
    await shot(window, 'f2-transcript-en.png');

    console.log('2. typing in place');
    const depth1 = await depthOf(window);
    await rows(window).nth(0).getByTestId('transcript-text').click();
    const field = window.getByTestId('transcript-edit');
    await field.waitFor({ state: 'visible', timeout: 3_000 });
    await field.press('End');
    await field.pressSequentially(' un video corto sobre la ciudad de Guadalajara');
    list = await captions(window);
    const typedLines = list[0].text.split('\n');
    check('the lines are laid out again as it is typed: two lines of at most 42, the break where the rules put it',
      list[0].text.replace(/\n/g, ' ') === 'Hoy vamos a editar un video corto sobre la ciudad de Guadalajara' && typedLines.length === 2 && typedLines.every((line) => line.length <= 42) && !list[0].manual,
      JSON.stringify(typedLines));
    // In the middle of the text: the caret must not jump to the end when a line break moves.
    await field.evaluate((element) => {
      const at = element.value.indexOf('video');
      element.setSelectionRange(at, at);
    });
    await field.pressSequentially('nuevo ');
    const caret = await field.evaluate((element) => ({ at: element.selectionStart, value: element.value }));
    check('typing in the middle keeps the caret where it is', caret.value.replace(/\n/g, ' ').includes('un nuevo video corto') && caret.value.slice(caret.at).replace(/\n/g, ' ').startsWith('video corto'),
      `caret at ${caret.at} of ${caret.value.length}: "${caret.value.slice(caret.at, caret.at + 12).replace(/\n/g, '/')}"`);
    await field.press('Enter');
    await sleep(200);
    check('Enter finishes; the whole of it was one undo step', (await window.getByTestId('transcript-edit').count()) === 0 && (await depthOf(window)) === depth1 + 1, `${depth1} -> ${await depthOf(window)}`);
    await undo(window);
    check('and undo brings the text back', (await captions(window))[0].text === 'Hoy vamos a editar');

    await rows(window).nth(0).getByTestId('transcript-text').click();
    await field.waitFor({ state: 'visible', timeout: 3_000 });
    await field.evaluate((element) => {
      const at = element.value.indexOf(' a editar');
      element.setSelectionRange(at, at + 1);
    });
    await field.press('Shift+Enter');
    await field.press('Escape');
    await sleep(200);
    list = await captions(window);
    check('Shift+Enter breaks the line where the author wants, and the breaks are then theirs', list[0].text === 'Hoy vamos\na editar' && list[0].manual, JSON.stringify(list[0].text));
    await sleep(200);
    const autoSwitch = window.getByTestId('caption-auto-breaks');
    check('the Inspector says so: Automatic line breaks is off', (await autoSwitch.isChecked()) === false);
    await autoSwitch.check();
    list = await captions(window);
    check('switched on again, the lines are the rules\' again', list[0].text === 'Hoy vamos a editar' && !list[0].manual, JSON.stringify(list[0].text));
    await undo(window);
    await undo(window);

    console.log('3. find and replace');
    await window.getByTestId('transcript-find-toggle').click();
    const find = window.getByTestId('transcript-find');
    await find.fill('video');
    await sleep(200);
    const count = () => window.getByTestId('transcript-match-count').innerText();
    check('find counts every match across the captions, whatever its case: 1 of 3', (await count()) === '1 of 3' && (await window.locator('[data-testid="transcript-list"] mark').count()) === 3, await count());
    await window.getByTestId('transcript-find-next').click();
    await sleep(150);
    const second = await window.evaluate(() => ({ frame: window.__scfStore.getState().project.currentFrame, current: document.querySelector('[data-testid="transcript-list"] mark[data-current="true"]')?.textContent }));
    check('next goes to the second match, and the playhead with it', (await count()) === '2 of 3' && second.frame === before[2].start && second.current === 'video', JSON.stringify(second));
    await window.getByTestId('transcript-match-case').click();
    await sleep(150);
    check('match case leaves "Video" out: 2', /of 2$/.test(await count()), await count());
    await window.getByTestId('transcript-match-case').click();
    await find.fill('video se');
    await sleep(150);
    check('a phrase is found across a line break', /of 2$/.test(await count()), await count());
    await find.fill('video');
    await shot(window, 'f2-find-en.png');

    const depth2 = await depthOf(window);
    await window.getByTestId('transcript-replace').fill('vídeo');
    await window.getByTestId('transcript-replace-one').click();
    await sleep(200);
    list = await captions(window);
    check('replace one changes that match only, and the count goes down', list[1].text === 'un vídeo corto.' && list[2].text === before[2].text && /of 2$/.test(await count()) && (await depthOf(window)) === depth2 + 1,
      `${list[1].text} / ${await count()}`);
    await window.getByTestId('transcript-replace-all').click();
    await sleep(200);
    list = await captions(window);
    const toast = await window.getByText(/replaced\. Ctrl\+Z undoes them all at once\./).first().innerText().catch(() => '');
    check('replace all changes the rest in one undo step, and says how many', list[2].text === 'El vídeo se exporta\ny el vídeo se comparte.' && (await depthOf(window)) === depth2 + 2 && /^2 replaced/.test(toast)
      && (await count()) === 'None', `${JSON.stringify(list[2].text)} / ${toast} / ${await count()}`);
    await undo(window);
    list = await captions(window);
    check('one undo takes all of that back', list[2].text === before[2].text && list[1].text === 'un vídeo corto.');
    await undo(window);
    await window.getByTestId('transcript-find-toggle').click();

    console.log('4. split and merge');
    const spokenBefore = (await captions(window)).flatMap((caption) => caption.spoken);
    // Between "se" and "exporta" of the third caption.
    const third = (await captions(window))[2];
    const cutFrame = Math.round((third.spoken[2][1] + 10 + third.spoken[3][1]) / 2);
    await rows(window).nth(2).getByTestId('transcript-time').click();
    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), cutFrame);
    await sleep(200);
    const depth3 = await depthOf(window);
    await window.getByTestId('transcript-split').click();
    await sleep(200);
    list = await captions(window);
    check('Split at the playhead cuts the selected caption between two words: six captions, each half with its words',
      list.length === 6 && list[2].text === 'El video se' && list[3].text === 'exporta y el Video se comparte.' && list[2].end === cutFrame && list[3].start === cutFrame && (await depthOf(window)) === depth3 + 1,
      `${JSON.stringify(list[2].text)} | ${JSON.stringify(list[3].text)}`);
    check('every word is still spoken on the frame it was', JSON.stringify(list.flatMap((caption) => caption.spoken)) === JSON.stringify(spokenBefore));
    await rows(window).nth(2).getByTestId('transcript-time').click();
    await sleep(150);
    await window.getByTestId('transcript-merge').click();
    await sleep(200);
    list = await captions(window);
    check('Merge with the next makes them one again: its text laid out by the rules, its words where they were',
      list.length === 5 && list[2].text === before[2].text && list[2].start === before[2].start && list[2].end === before[2].end
        && JSON.stringify(list.flatMap((caption) => caption.spoken)) === JSON.stringify(spokenBefore) && (await depthOf(window)) === depth3 + 2, JSON.stringify(list[2].text));
    // The same from the row's own menu.
    await rows(window).nth(0).click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Merge with the next' }).click();
    await sleep(200);
    list = await captions(window);
    check('a row\'s menu merges too: "Hoy vamos a editar un video corto."', list.length === 4 && list[0].text === 'Hoy vamos a editar un video corto.' && list[0].end === before[1].end, JSON.stringify(list[0].text));
    await undo(window);

    console.log('5. warnings, and Fix timing');
    // The fourth is cut down to a third of a second; the last is given far too much text.
    await window.evaluate(([shortId, longId]) => {
      const store = window.__scfStore.getState();
      const short = store.project.clips[shortId];
      store.trimClip(shortId, 'end', short.startFrame + 10);
      window.__scfStore.getState().setCaptionText(longId, 'Hasta la próxima, y muchas gracias por verlo.');
    }, [before[3].id, before[4].id]);
    await sleep(300);
    const flagged = await window.evaluate(() => [...document.querySelectorAll('[data-testid="transcript-row"]')].map((row) => row.getAttribute('data-warning')));
    const label3 = await rows(window).nth(3).getByTestId('transcript-warning').getAttribute('aria-label');
    const label4 = await rows(window).nth(4).getByTestId('transcript-warning').getAttribute('aria-label');
    check('captions that break a rule are marked in the list, and the mark says what is wrong',
      flagged.join() === 'false,false,false,true,true' && /Too short: 0\.3 s on screen\./.test(label3 ?? '') && /Too fast to read: .* characters a second, over 17\./.test(label4 ?? ''),
      `${flagged.join()} | ${label3} | ${label4}`);
    check('the button counts them: 2', (await window.getByTestId('transcript-warnings').innerText()) === '2');
    // The same test marks them on the timeline; asked of the same code the canvas asks.
    const onTimeline = await window.evaluate(() => {
      const { rulesFor } = window.__scfCaptions;
      const { project } = window.__scfStore.getState();
      const limits = rulesFor('classic', project);
      return Object.values(project.clips).filter((clip) => clip.caption).sort((a, b) => a.startFrame - b.startFrame)
        .map((clip) => clip.durationFrames / project.fps < limits.minSeconds || clip.caption.text.replace(/\n/g, '').length / (clip.durationFrames / project.fps) > limits.maxCps);
    });
    check('and the same two wear the amber corner on the timeline', onTimeline.join() === 'false,false,false,true,true', onTimeline.join());
    await shot(window, 'f2-warnings-en.png');
    const depth4 = await depthOf(window);
    await window.getByTestId('transcript-fix').click();
    await sleep(300);
    list = await captions(window);
    const fixToast = await window.getByText(/captions fixed/).first().innerText().catch(() => '');
    check('Fix timing keeps each up for as long as its text needs at 17 characters a second (45 and 78 frames), without moving a start - one undo step',
      list[3].start === before[3].start && list[3].end === before[3].start + Math.ceil((25 / 17) * FPS) && list[4].start === before[4].start && list[4].end - list[4].start === Math.ceil((list[4].text.replace(/\n/g, '').length / 17) * FPS)
        && (await depthOf(window)) === depth4 + 1, `${list[3].end - list[3].start} and ${list[4].end - list[4].start} frames`);
    check('and says what it did', /^2 captions fixed\. Ctrl\+Z undoes it\.$/.test(fixToast) && (await window.getByTestId('transcript-warnings').count()) === 0, fixToast);
    await undo(window);
    await undo(window);
    await undo(window);
    list = await captions(window);
    check('undone, the captions are as they were', JSON.stringify(list.map((caption) => [caption.start, caption.end, caption.text])) === JSON.stringify(before.map((caption) => [caption.start, caption.end, caption.text])));

    console.log('6. the Style tab: the track\'s look');
    await rows(window).nth(2).getByTestId('transcript-time').click();
    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), before[2].start + 20);
    await sleep(600);
    const inspector = window.getByTestId('inspector-panel');
    const tabs = await inspector.getByRole('tab').allInnerTexts();
    check('a caption\'s Inspector: Caption, Style, Info', tabs.join('|') === 'Caption|Style|Info', tabs.join(' / '));
    const follows = await window.getByTestId('caption-link').innerText();
    check('the Caption tab says what it follows', /^Follows the clip “talk\.mp4”/.test(follows), follows);
    let plain = await exactFrame(window);
    for (let tries = 0; tries < 20 && colourBox(plain, W, H, [255, 255, 255], 20).count === 0; tries += 1) {
      await sleep(250);
      plain = await exactFrame(window);
    }
    const white = colourBox(plain, W, H, [255, 255, 255], 20);
    await inspector.getByRole('tab', { name: 'Style' }).click();
    const scope = await window.getByTestId('caption-style-scope').innerText();
    const sections = await window.locator('#inspector-tabpanel section h3').allInnerTexts();
    check('Style says whose look it is, and groups it: Preset, Font, Outline, Background, Position, Animation',
      /every caption on “Captions 1”/.test(scope) && sections.join('|') === 'Preset|Font|Outline|Background|Position|Animation', `${scope} | ${sections.join(' / ')}`);
    await shot(window, 'f2-style-en.png');
    const fonts = await window.getByTestId('caption-style-font').locator('optgroup').first().locator('option').allInnerTexts();
    check('the fonts that come with the app are offered: Inter, Source Serif 4, Oswald', fonts.join('|') === 'Inter|Source Serif 4|Oswald', fonts.join(' / '));

    const depth5 = await depthOf(window);
    await window.getByTestId('caption-style-font').selectOption('Oswald');
    await window.getByTestId('caption-style-color').fill('#ffe600');
    await window.getByTestId('caption-style-position-top').click();
    const look = await window.evaluate(() => window.__scfStore.getState().project.tracks.find((track) => track.type === 'captions').captions.look);
    check('font, colour and place are the track\'s: Oswald, yellow, at the top', look.fontFamily === 'Oswald' && look.color === '#ffe600' && look.position === 'top' && look.fontWeight <= 700,
      JSON.stringify(look).slice(0, 140));
    await sleep(900);
    let styled = await exactFrame(window);
    for (let tries = 0; tries < 20 && colourBox(styled, W, H, [255, 230, 0], 30).count === 0; tries += 1) {
      await sleep(250);
      styled = await exactFrame(window);
    }
    const yellow = colourBox(styled, W, H, [255, 230, 0], 30);
    check('the picture follows: yellow letters at the top of the title-safe area, none white at the bottom',
      yellow.count > 1500 && yellow.top >= H * 0.05 - 2 && yellow.bottom < H * 0.25 && colourBox(styled, W, H, [255, 255, 255], 20).count === 0 && white.bottom > H * 0.88,
      `yellow: ${yellow.count} px, y ${yellow.top}..${yellow.bottom}; before, white: y ${white.top}..${white.bottom}`);
    check('centred', Math.abs((yellow.left + yellow.right) / 2 - W / 2) < W * 0.02, `x ${yellow.left}..${yellow.right}`);
    // Another caption of the track, without touching it: the look is the track's.
    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), before[4].start + 10);
    await sleep(700);
    const other = colourBox(await exactFrame(window), W, H, [255, 230, 0], 30);
    check('every caption on the track has it', other.count > 500 && other.bottom < H * 0.25, `${other.count} px, y ${other.top}..${other.bottom}`);
    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), before[2].start + 20);

    // A band behind the text, and a size chosen by hand.
    await window.locator('section[data-section="captionBox"] input[role="switch"]').check();
    await window.getByTestId('caption-style-box-color').fill('#102040');
    await window.getByTestId('caption-style-auto-size').uncheck();
    const size = await window.evaluate(() => window.__scfStore.getState().project.tracks.find((track) => track.type === 'captions').captions.look.fontSize);
    await sleep(800);
    let banded = await exactFrame(window);
    for (let tries = 0; tries < 12 && colourBox(banded, W, H, [51, 64, 96], 14).count === 0; tries += 1) {
      await sleep(250);
      banded = await exactFrame(window);
    }
    // #102040 at 60% over grey 96: about (48, 58, 77)... measured rather than assumed.
    const bandPixel = (() => {
      const y = Math.round((yellow.top + yellow.bottom) / 2);
      const i = (y * W + (yellow.left - 6)) * 4;
      return [banded[i], banded[i + 1], banded[i + 2]];
    })();
    check('a background band is drawn behind the text, and size goes from automatic to the size it had',
      size === 46 && bandPixel[2] > bandPixel[0] + 10 && bandPixel[0] < 96, `size ${size}, the pixel left of the text is rgb(${bandPixel.join(', ')}) on grey 96`);
    const viewer = await viewerFrame(window);
    check('the viewer and the export\'s frame are identical, pixel for pixel, in this look', worstDifference(viewer, banded) === 0, `worst difference ${worstDifference(viewer, banded)}`);
    await shot(window, 'f2-styled-en.png');

    await window.getByTestId('caption-style-preset').selectOption('social');
    const social = await window.evaluate(() => window.__scfStore.getState().project.tracks.find((track) => track.type === 'captions').captions);
    check('a preset brings its own look back: Social, with nothing changed by hand', social.preset === 'social' && social.look === undefined, JSON.stringify(social));
    await sleep(300);
    const socialFlags = await window.evaluate(() => [...document.querySelectorAll('[data-testid="transcript-row"]')].map((row) => row.getAttribute('data-warning')).join());
    check('and its rules: the two-line caption is now one line too many', socialFlags.split(',')[2] === 'true', socialFlags);
    const afterStyle = await depthOf(window);
    for (let i = afterStyle; i > depth5; i -= 1) await undo(window);
    check('undone step by step, the track has its first look again', await window.evaluate(() => {
      const captionsOf = window.__scfStore.getState().project.tracks.find((track) => track.type === 'captions').captions;
      return captionsOf.preset === 'classic' && captionsOf.look === undefined;
    }), `${afterStyle - depth5} steps`);

    console.log('7. export: burnt in, a track inside the file, a file beside it');
    // A look that is not the default, so "identical" is not said of the easy case.
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'captions');
      store.setCaptionLook(track.id, { fontFamily: 'Source Serif 4', color: '#ffe600', box: { enabled: true, color: '#000000', opacity: 0.7 } });
    });
    const burnFrame = before[2].start + 20;
    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), burnFrame);
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await sleep(900);
    let preview = await viewerFrame(window);
    for (let tries = 0; tries < 20 && colourBox(preview, W, H, [255, 230, 0], 30).count === 0; tries += 1) {
      await sleep(250);
      preview = await viewerFrame(window);
    }
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
      const finished = await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 180_000 }).then(() => true).catch(() => false);
      const card = finished ? (await window.getByTestId('export-result').innerText()).replace(/\s+/g, ' ') : '';
      return { finished, card };
    };

    // One PNG frame, burnt in: against the viewer.
    let dialog = await openExport('png-sequence', 'burnt-frame', [burnFrame, burnFrame + 1]);
    const group = (await dialog.locator('section', { has: window.getByTestId('export-captions-burn') }).innerText()).replace(/\s+/g, ' ');
    check('the Captions group says the three ways out for what they are',
      /5 captions on the timeline\. Three ways to deliver them\. They can be combined\./.test(group) && /Burn the captions into the picture .*nobody can switch them off\./.test(group)
        && /A subtitle track inside the video/.test(group) && /Subtitle file beside the video .*For YouTube/.test(group), group.slice(0, 200));
    const embed = dialog.getByTestId('export-captions-embed');
    check('a PNG sequence cannot carry a track, and says so', (await embed.isDisabled()) && /PNG sequence \(sprite frames\) cannot carry a subtitle track/.test(group), group.match(/[^.]*cannot carry[^.]*\./)?.[0] ?? '');
    await shot(window, 'f2-export-png-en.png');
    const png = await finish(dialog);
    const pngs = [];
    const walk = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(folder, entry.name));
        else if (entry.name.endsWith('.png')) pngs.push(join(folder, entry.name));
      }
    };
    await walk(exportDir);
    let exported = Buffer.alloc(0);
    if (png.finished && pngs.length > 0) {
      const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-i', pngs.sort()[0], '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      exported = stdout;
    }
    const burnt = colourBox(exported, W, H, [255, 230, 0], 30);
    check('burnt in: the exported frame has the caption, in the track\'s look', png.finished && burnt.count > 1500, `${burnt.count} yellow pixels in ${pngs.length} file`);
    let worstRgb = 255;
    if (exported.length === preview.length) {
      worstRgb = 0;
      for (let i = 0; i < exported.length; i += 4) for (let c = 0; c < 3; c += 1) worstRgb = Math.max(worstRgb, Math.abs(exported[i + c] - preview[i + c]));
    }
    check('and is identical to what the viewer showed, pixel for pixel', worstRgb === 0, `worst difference ${worstRgb} over ${exported.length / 4} pixels`);
    await dialog.getByTitle('Close').click();
    await sleep(300);

    // An MP4 with the track inside and the .srt beside it, not burnt in.
    const range = [0, before[2].end + 15];
    dialog = await openExport('mp4-h264', 'with-track', range);
    await dialog.getByTestId('export-captions-burn').uncheck();
    await dialog.getByTestId('export-captions-embed').check();
    await dialog.getByTestId('export-captions-file').selectOption('srt');
    await shot(window, 'f2-export-mp4-en.png');
    const mp4 = await finish(dialog);
    await dialog.getByTitle('Close').click();
    await sleep(300);
    const video = join(exportDir, 'with-track.mp4');
    const probe = await execFileAsync(ffmpeg, ['-hide_banner', '-i', video], { encoding: 'utf8' }).catch((error) => ({ stderr: error.stderr ?? '' }));
    const streams = (probe.stderr ?? '').split(/\r?\n/).filter((line) => /Stream #/.test(line)).map((line) => line.trim());
    const subtitleStream = streams.find((line) => /Subtitle/.test(line)) ?? '';
    check('the MP4 has a subtitle stream: mov_text, tagged Spanish', mp4.finished && /Stream #0:\d+(\[0x\w+\])?\(spa\): Subtitle: mov_text/.test(subtitleStream), streams.join(' | '));
    check('beside its picture and its sound', streams.filter((line) => /Video: h264/.test(line)).length === 1 && streams.filter((line) => /Audio: aac/.test(line)).length === 1);
    const readBack = join(workDir, 'read-back.srt');
    await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', video, '-map', '0:s:0', readBack]).catch(() => undefined);
    const inside = existsSync(readBack) ? await readFile(readBack, 'utf8') : '';
    const cuesInside = [...inside.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)\r?\n([^]*?)(?:\r?\n\r?\n|$)/g)].map((match) => [match[1], match[2], match[3].trim().replace(/\r?\n/g, '\n')]);
    const expected = await window.evaluate(([start, end]) => window.__scfCaptions.captionCues(window.__scfStore.getState().project, { fromFrame: start, toFrame: end }), range);
    const ms = (stamp) => { const [h, m, rest] = stamp.split(':'); const [s, milli] = rest.split(','); return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(milli); };
    const sameCues = cuesInside.length === expected.length && cuesInside.every(([from, to, text], index) =>
      Math.abs(ms(from) - expected[index].startMs) <= 1 && Math.abs(ms(to) - expected[index].endMs) <= 1 && text === expected[index].text);
    check('read back out of the file, it is the three captions of the range, at their times, accents and line break intact', sameCues && expected.length === 3,
      `${cuesInside.length} cues: ${cuesInside.map((entry) => entry[2].replace(/\n/g, '/')).join(' | ')}`);
    const sidecar = existsSync(join(exportDir, 'with-track.srt')) ? await readFile(join(exportDir, 'with-track.srt'), 'utf8') : '';
    check('the .srt is beside it as before, and the finished card names both', sidecar.split('-->').length - 1 === 3 && /inside the video \(spa\) · with-track\.srt/.test(mp4.card), mp4.card.slice(-90));
    const { stdout: frameOut } = await execFileAsync(ffmpeg, ['-v', 'error', '-ss', String((before[2].start + 20) / FPS), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    check('not burnt in, its picture has no caption', colourBox(frameOut, W, H, [255, 230, 0], 60).count === 0);
    const temp = (await readdir(await app.evaluate(({ app: electronApp }) => electronApp.getPath('temp')))).filter((name) => /^scf-captions-.*\.srt$/.test(name));
    check('the temporary subtitle file is gone', temp.length === 0, temp.join(', '));
    await undo(window);

    console.log('8. captions follow the edit');
    const base = await captions(window);
    const state = (window_) => window_.evaluate(() => ({ parked: Object.keys(window.__scfStore.getState().project.parkedCaptions ?? {}).length }));
    await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      store.setUi({ rippleEnabled: false });
      store.moveClipGroup([id], 90, 0);
    }, clipId);
    list = await captions(window);
    check('the clip moved 3 s later: every caption moved with it', list.every((caption, index) => caption.start === base[index].start + 90 && caption.end === base[index].end + 90),
      list.map((caption) => caption.start).join(', '));
    await undo(window);

    await window.evaluate((id) => window.__scfStore.getState().trimClip(id, 'start', 100), clipId);
    await sleep(250);
    list = await captions(window);
    const parkedLine = await window.getByTestId('transcript-parked').innerText().catch(() => '');
    check('the clip trimmed past the first caption: it leaves the timeline, the second is shortened to what is left, the rest stay',
      list.length === 4 && list[0].text === base[1].text && list[0].start === 100 && list[0].end === base[1].end && list[1].start === base[2].start && (await state(window)).parked === 1,
      `${list.length} on the timeline, first ${list[0].start}..${list[0].end}`);
    check('the list says one caption is out of the edit', /^1 captions are out of the edit/.test(parkedLine), parkedLine);
    await shot(window, 'f2-follow-en.png');
    await window.evaluate((id) => window.__scfStore.getState().trimClip(id, 'start', 0), clipId);
    list = await captions(window);
    check('trimmed back, both are exactly as they were', JSON.stringify(list.map((caption) => [caption.start, caption.end, caption.text])) === JSON.stringify(base.map((caption) => [caption.start, caption.end, caption.text]))
      && (await state(window)).parked === 0);

    // Cut the clip between the third and fourth captions, and take the first half out with the magnet.
    const cutAt = base[3].start - 20;
    const afterCut = await window.evaluate(([id, frame]) => {
      const store = window.__scfStore.getState();
      store.setUi({ rippleEnabled: true });
      store.razorAtFrame(frame, [id]);
      const same = JSON.stringify(Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.caption).map((clip) => clip.startFrame).sort((a, b) => a - b));
      window.__scfStore.getState().removeClips([id]);
      return same;
    }, [clipId, cutAt]);
    list = await captions(window);
    check('the clip cut in two: no caption moves', afterCut === JSON.stringify(base.map((caption) => caption.start)), afterCut);
    check('its first half deleted with the magnet: its three captions leave, and the other two ride in with the second half',
      list.length === 2 && list[0].text === base[3].text && list[0].start === base[3].start - cutAt && list[1].start === base[4].start - cutAt && (await state(window)).parked === 3,
      `${list.map((caption) => `${caption.start} ${caption.text}`).join(' | ')}; ${(await state(window)).parked} out of the edit`);
    await undo(window);
    await undo(window);
    list = await captions(window);
    check('undo brings the clip and its captions back', list.length === 5 && list[0].start === base[0].start && (await state(window)).parked === 0);

    await rows(window).nth(0).getByTestId('transcript-time').click();
    await sleep(300);
    await inspector.getByRole('tab', { name: 'Caption' }).click();
    await window.getByTestId('caption-link-toggle').click();
    await window.evaluate((id) => {
      window.__scfStore.getState().setUi({ rippleEnabled: false });
      window.__scfStore.getState().moveClipGroup([id], 60, 0);
    }, clipId);
    list = await captions(window);
    const free = await window.getByTestId('caption-link').innerText();
    check('a caption let go of its clip stays where it is while the others follow', list[0].start === base[0].start && list[0].linked === null && list[1].start === base[1].start + 60 && /^Stays where it is/.test(free), free);
    await undo(window);
    await window.getByTestId('caption-link-toggle').click();
    list = await captions(window);
    check('told to follow again, it is tied to the clip under it', list[0].linked === clipId && /^Follows the clip/.test(await window.getByTestId('caption-link').innerText()));

    console.log('9. in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    const tabNamesEs = await window.getByTestId('media-panel').getByRole('tab').allInnerTexts();
    const inspectorEs = await inspector.getByRole('tab').allInnerTexts();
    check('las pestañas: Medios, Títulos, Transiciones, Subtítulos - y Subtítulo, Estilo, Info', tabNamesEs.join('|') === 'Medios|Títulos|Transiciones|Subtítulos' && inspectorEs.join('|') === 'Subtítulo|Estilo|Info',
      `${tabNamesEs.join(' / ')} - ${inspectorEs.join(' / ')}`);
    const captionEs = (await window.locator('#inspector-tabpanel').innerText()).replace(/\s+/g, ' ');
    check('la pestaña Subtítulo: saltos automáticos, en pantalla, a qué clip sigue', /Saltos de línea automáticos/.test(captionEs) && /En pantalla/.test(captionEs) && /Sigue al clip «talk\.mp4»/.test(captionEs) && /Soltar del clip/.test(captionEs),
      captionEs.slice(0, 160));
    await inspector.getByRole('tab', { name: 'Estilo' }).click();
    const sectionsEs = await window.locator('#inspector-tabpanel section h3').allInnerTexts();
    check('la pestaña Estilo: Estilo base, Fuente, Contorno, Fondo, Posición, Animación', sectionsEs.join('|') === 'Estilo base|Fuente|Contorno|Fondo|Posición|Animación'
      && /todos los subtítulos de «Captions 1»/.test(await window.getByTestId('caption-style-scope').innerText()), sectionsEs.join(' / '));
    await shot(window, 'f2-style-es.png');
    await window.getByTestId('transcript-find-toggle').click();
    await window.getByTestId('transcript-find').fill('video');
    await sleep(200);
    const findEs = { count: await window.getByTestId('transcript-match-count').innerText(), find: await window.getByTestId('transcript-find').getAttribute('placeholder'), replace: await window.getByTestId('transcript-replace').getAttribute('placeholder'),
      header: await window.getByTestId('transcript-count').innerText() };
    check('la lista: «5 subtítulos», Buscar, Reemplazar por, «1 de 3»', findEs.count === '1 de 3' && findEs.find === 'Buscar' && findEs.replace === 'Reemplazar por' && findEs.header === '5 subtítulos', JSON.stringify(findEs));
    await window.getByTestId('transcript-replace').fill('vídeo');
    await window.getByTestId('transcript-replace-all').click();
    const toastEs = await window.getByText(/reemplazadas\. Ctrl\+Z las deshace todas de una vez\./).first().innerText().catch(() => '');
    check('reemplazar todas lo dice en español', /^3 reemplazadas/.test(toastEs), toastEs);
    await shot(window, 'f2-transcript-es.png');
    await undo(window);
    await rows(window).nth(1).click({ button: 'right' });
    const menuEs = await window.getByRole('menuitem').allInnerTexts();
    await window.keyboard.press('Escape');
    check('el menú de una fila: partir, unir, soltar del clip, borrar',
      ['Partir en el cursor', 'Unir con el anterior', 'Unir con el siguiente', 'Soltar del clip', 'Borrar subtítulo'].every((label) => menuEs.some((item) => item.includes(label))), menuEs.join(' / '));
    await window.evaluate(([format, start, end]) => window.__scfStore.getState().setExportSettings({ format, startFrame: start, endFrame: end }), ['mp4-h264', 0, 90]);
    await window.getByRole('button', { name: 'Exportar', exact: true }).click();
    const dialogEs = window.getByRole('dialog', { name: 'Exportar' });
    await dialogEs.getByTestId('export-captions-burn').waitFor({ state: 'visible', timeout: 10_000 });
    await dialogEs.getByTestId('export-captions-embed').check();
    const groupEs = (await dialogEs.locator('section', { has: window.getByTestId('export-captions-burn') }).innerText()).replace(/\s+/g, ' ');
    check('la exportación: grabados, pista dentro del vídeo, archivo aparte, y el aviso de que pueden verse dos veces',
      /Tres maneras de entregarlos/.test(groupEs) && /Grabar los subtítulos en la imagen/.test(groupEs) && /Una pista de subtítulos dentro del vídeo/.test(groupEs) && /Archivo de subtítulos junto al vídeo/.test(groupEs)
        && /los pintará dos veces/.test(groupEs), groupEs.slice(0, 160));
    await shot(window, 'f2-export-es.png');
    await dialogEs.getByTitle('Cerrar').click();

    console.log('10. nothing left the computer');
    const remote = [...requests.filter((url) => /^(https?|wss?|ftp):/i.test(url)), ...(await app.evaluate(() => globalThis.__scfRequests.slice()))];
    check('no request was attempted', remote.length === 0, remote.slice(0, 3).join(' | '));
    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
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
