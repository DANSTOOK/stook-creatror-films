import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * User-interface test.
 *
 * Everything else in this repository tests the code the UI calls. This drives
 * the UI itself: the real Electron window, the real buttons, the real export
 * dialog. Until this existed, the Import button and the Export dialog had never
 * once been clicked in an automated run.
 *
 * Native dialogs live in the main process and cannot be intercepted from the
 * page, so they are replaced through `electronApp.evaluate` - which is the
 * approach Playwright documents for exactly this.
 *
 * https://playwright.dev/docs/api/class-electron
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp');

const ffmpeg = require('ffmpeg-static');

const sourceVideo = process.env.UI_SOURCE_VIDEO ?? join(workDir, 'source.mp4');
const exportPath = join(workDir, 'ui-export.mp4');
const lutPath = join(workDir, 'identity.cube');
const panelDropImage = join(workDir, 'panel-drop.png');
const timelineDropImage = join(workDir, 'drop.png');
const projectPath = join(workDir, 'ui-project.scf');
const folderImportRoot = join(workDir, 'Footage');

/** Media panel width left by the resize checks, to find again in the fresh session. */
let persistedMediaWidth = null;

// A profile of its own: the run must work beside a copy of the app the user
// has open (the app allows one instance per profile), and must not read or
// write the user's settings, such as the saved GPU choice.
const profileArg = `--user-data-dir=${join(workDir, 'profile')}`;

// Two seconds, so the export crosses a change of testsrc's seconds counter: a
// picture from the wrong moment is then unmistakable.
const EXPORT_FRAMES = 60;

// Timeline rows, top to bottom: Video 2 (covers), Video 1, Audio 1. Centres,
// from the top of the timeline canvas: 24 px ruler, then 58 px per row.
const VIDEO2_ROW_Y = 24 + 28;
const VIDEO1_ROW_Y = 24 + 58 + 28;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push({ name, passed, detail });
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const run = (file, args) =>
  execFileAsync(file, args, { maxBuffer: 32 * 1024 * 1024 });

/** A tiny identity .cube, enough to prove a look survives save and reopen. */
async function writeIdentityLut(path) {
  const size = 2;
  const lines = ['TITLE "UI Test Identity"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b += 1)
    for (let g = 0; g < size; g += 1)
      for (let r = 0; r < size; r += 1) lines.push(`${r} ${g} ${b}`);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

async function prepare() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeIdentityLut(lutPath);

  // Stills for the drag-and-drop checks.
  for (const path of [panelDropImage, timelineDropImage]) {
    await run(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=1', '-frames:v', '1', path,
    ]);
  }

  // A folder with subfolders, for "Add folder and subfolders": each folder has
  // to come out as a bin, with each still filed in its own.
  const { copyFile } = require('node:fs/promises');
  for (const [dir, name] of [['', 'still-root.png'], ['Day 1', 'still-a.png'], ['Day 2', 'still-b.png']]) {
    await mkdir(join(folderImportRoot, dir), { recursive: true });
    await copyFile(panelDropImage, join(folderImportRoot, dir, name));
  }

  if (!process.env.UI_SOURCE_VIDEO) {
    // A short clip WITH audio, so the export exercises the mux too.
    await run(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      sourceVideo,
    ]);
  }
}

/** Decode the first `frames` frames of a file to RGB at a fixed small size. */
async function decodeFrames(file, frames) {
  const { stdout } = await execFileAsync(
    ffmpeg,
    // -map 0:v:0: the film, never the cover image, which is a video stream too.
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', String(frames), '-vf', 'scale=160:120',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
  );
  return stdout;
}

/**
 * Compare every exported frame with the source frame it should be.
 *
 * "The file has the right duration" says nothing about WHICH picture sits at
 * each frame. The export borrows the viewport's renderer, and the viewport's
 * own draw loop kept seeking the shared video element to the playhead while
 * the export was seeking it to frame N - so roughly every other exported frame
 * was really the playhead's frame. It showed up as flashes in the render, and
 * no structural check could see it.
 */
async function frameAccuracy(exported, source, frames) {
  const size = 160 * 120 * 3;
  const [a, b] = await Promise.all([decodeFrames(exported, frames), decodeFrames(source, frames)]);
  const count = Math.min(a.length, b.length) / size;
  const wrong = [];

  for (let frame = 0; frame < count; frame += 1) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += Math.abs(a[frame * size + i] - b[frame * size + i]);
    // Honest lossy re-encoding lands around 1-3; a picture from another moment
    // of testsrc (different counter digit, moved gradient) is well above 8.
    if (sum / size > 8) wrong.push(frame);
  }
  return { count, wrong };
}

/** Read the stream summary ffmpeg prints for a file. */
async function probe(file) {
  try {
    await run(ffmpeg, ['-hide_banner', '-i', file]);
    return '';
  } catch (error) {
    return String(error.stderr ?? '');
  }
}

/**
 * Point the run at the packaged build instead of the development one.
 *
 * Worth having as a switch: packaging is where a dependency in the wrong
 * section of package.json stops being harmless and starts shipping an app that
 * cannot export.
 */
const packagedExe = process.env.UI_PACKAGED
  ? join(projectRoot, 'release/win-unpacked/STOOK CREATOR FILMS.exe')
  : null;

/**
 * Run with the network cut. Every attempted request is logged and cancelled,
 * so the run proves the app has no network dependency rather than merely
 * tolerating a slow one.
 */
const offline = Boolean(process.env.UI_OFFLINE);

async function main() {
  console.log('1. preparing media and building the app');
  await prepare();

  if (!packagedExe) {
    await run(process.execPath, [
      join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build',
    ]);
  }

  console.log(`2. launching the ${packagedExe ? 'PACKAGED' : 'development'} Electron app`);
  const app = await electron.launch({
    ...(packagedExe
      ? { executablePath: packagedExe, args: [profileArg] }
      : { args: [profileArg, join(projectRoot, 'dist-electron/main/index.js')] }),
    cwd: projectRoot,
    // ELECTRON_RUN_AS_NODE is cleared for the same reason as in the e2e runner:
    // the child must start as Electron even when this script was launched by an
    // Electron binary running in Node mode.
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined },
  });

  const consoleIssues = [];

  try {
    const window = await app.firstWindow();
    window.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleIssues.push(`[${message.type()}] ${message.text()}`);
      }
    });
    window.on('pageerror', (error) => consoleIssues.push(`[pageerror] ${error.message}`));

    if (offline) {
      // Cut the network for the whole Chromium session, and record anything
      // that even tries to leave the machine. Blocking alone would hide a
      // dependency; logging it is what proves there is none.
      await app.evaluate(({ session }) => {
        globalThis.__externalRequests = [];
        const ses = session.defaultSession;
        ses.enableNetworkEmulation({ offline: true });
        ses.webRequest.onBeforeRequest((details, callback) => {
          // media: is the app's own protocol for footage on disk (main/ipc/
          // mediaProtocol.ts serves a file by token, nothing else). It came
          // after this list was written, and blocking it failed every import
          // with the network cut - a stale list, not a network dependency.
          const local = /^(file|blob|data|devtools|chrome|chrome-extension|media):/i.test(details.url);
          if (!local) {
            globalThis.__externalRequests.push(details.url);
            callback({ cancel: true });
            return;
          }
          callback({});
        });
      });
      // The page loaded before the hook existed; reload so the whole startup
      // runs through it too.
      await window.reload();
    }

    await window.waitForSelector('#root > *', { timeout: 30_000 });

    console.log('3. driving the interface');

    check('window opens with the app title', (await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getTitle())) === 'STOOK CREATOR FILMS');

    check('media panel starts empty',
      await window.getByText('Drop files here').isVisible());

    // Replace the native dialogs. They run in the main process, so this is the
    // only way to make them deterministic.
    await app.evaluate(({ dialog }, { video, output }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
    }, { video: sourceVideo, output: exportPath });

    /* Import ------------------------------------------------------------- */
    await window.getByRole('button', { name: 'Import' }).click();

    const assetName = sourceVideo.split(/[\\/]/).pop();
    await window.getByText(assetName, { exact: false }).first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    check('import through the real dialog adds the asset', true, assetName);

    /* Add to the timeline -------------------------------------------------- */
    const assetRow = window.locator('li').filter({ hasText: assetName }).first();
    await assetRow.hover();
    await assetRow.getByTitle(/Add at the playhead/).click();

    // The inspector is the observable proof a clip exists and is selectable.
    // The clip lands on Video 1, the lower of the two picture rows (the one
    // above covers it, as in every editor).
    await window.locator('canvas').last().click({ position: { x: 60, y: VIDEO1_ROW_Y } });
    const inspectorHasClip = await window.getByText('TRANSFORM').isVisible().catch(() => false);
    check('clip lands on the timeline and can be selected', inspectorHasClip);

    /* The hand tool -------------------------------------------------------- */
    const surface = window.locator('canvas').last();
    await window.getByRole('button', { name: 'Pan' }).click();

    const scrollBefore = await window.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => d.scrollWidth > d.clientWidth + 50);
      return el ? el.scrollLeft : -1;
    });
    const box = await surface.boundingBox();
    await window.mouse.move(box.x + 400, box.y + 100);
    await window.mouse.down();
    await window.mouse.move(box.x + 150, box.y + 100, { steps: 8 });
    await window.mouse.up();
    const scrollAfter = await window.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => d.scrollWidth > d.clientWidth + 50);
      return el ? el.scrollLeft : -1;
    });

    check('hand tool actually pans the timeline', scrollAfter > scrollBefore,
      `scrollLeft ${scrollBefore} -> ${scrollAfter}`);
    await window.getByRole('button', { name: 'Select' }).click();

    /* Context menu honesty --------------------------------------------------- */
    await surface.click({ button: 'right', position: { x: 500, y: 200 } });
    await window.waitForTimeout(300);
    const menuItems = await window.locator('[role="menuitem"]').allInnerTexts();
    check('no menu entry creates a track nothing can draw',
      !menuItems.some((text) => /text track/i.test(text)),
      menuItems.length ? menuItems.join(' / ') : 'no menu');
    await window.keyboard.press('Escape');

    /* Drag and drop ---------------------------------------------------------- */
    // A synthetic drop normally carries JS-built Files with no path on disk,
    // which would test the fallback, not the real thing. Playwright fills a
    // file input with REAL files from disk; those same File objects are then
    // re-dispatched in the drop, so webUtils.getPathForFile resolves them
    // exactly as it does for a drag out of Explorer.
    const dropFiles = async (paths, target, offset) => {
      await window.evaluate(() => {
        if (document.getElementById('__ui_drop')) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.id = '__ui_drop';
        input.style.display = 'none';
        document.body.appendChild(input);
      });
      await window.setInputFiles('#__ui_drop', paths);
      await window.evaluate(({ target, offset }) => {
        const element = target === 'media'
          ? [...document.querySelectorAll('aside')].find((el) => el.textContent.includes('Media'))
          : [...document.querySelectorAll('canvas')].at(-1).parentElement;
        const rect = element.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        for (const file of document.getElementById('__ui_drop').files) dataTransfer.items.add(file);
        const init = {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: rect.left + offset.x,
          clientY: rect.top + offset.y,
        };
        for (const type of ['dragenter', 'dragover', 'drop']) {
          element.dispatchEvent(new DragEvent(type, init));
        }
      }, { target, offset });
    };

    // Onto the media panel.
    await dropFiles(
      [panelDropImage],
      'media',
      { x: 100, y: 200 },
    );
    const panelDropped = await window.getByText('panel-drop.png').first()
      .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    check('dropping a file on the media panel imports it', panelDropped);

    // Onto the timeline, on the other picture track (the top row), well past the export range so the
    // frame-accuracy check below still compares the source video alone.
    await dropFiles(
      [timelineDropImage],
      'timeline',
      { x: 1100, y: VIDEO2_ROW_Y },
    );
    const droppedOnTimeline = await window.locator('aside').filter({ hasText: 'TRANSFORM' })
      .getByText('drop.png', { exact: true }).first()
      .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    check('dropping a file on the timeline puts a clip there and selects it', droppedOnTimeline);

    // The drop revealed its clip, which may have scrolled the first clip out of
    // view. "\" fits the whole timeline again - and is itself under test here:
    // the first clip is only where the next click expects it if fit worked.
    await window.keyboard.press('\\');
    await window.waitForTimeout(300);

    // Rubber band: from empty space at the bottom right to the top left of the
    // tracks - both clips on the timeline (the video and the dropped still).
    const bandBox = await surface.boundingBox();
    await window.mouse.move(bandBox.x + bandBox.width - 6, bandBox.y + 24 + 58 * 2 + 30);
    await window.mouse.down();
    await window.mouse.move(bandBox.x + bandBox.width / 2, bandBox.y + 60, { steps: 6 });
    await window.mouse.move(bandBox.x + 3, bandBox.y + 26, { steps: 6 });
    await window.mouse.up();
    const bandSelected = await window.getByText('2 clips selected', { exact: false })
      .isVisible().catch(() => false);
    check('dragging a band over the timeline selects several clips', bandSelected);

    /* Scrubbing: picture and sound follow a dragged playhead ----------------- */
    // Park the playhead, let the forward decoder settle there, then drag the
    // ruler forwards the way a hand does: a move every 16 ms.
    await window.evaluate(() => {
      window.__scfScrubStats = { grains: 0 };
    });
    const rulerY = bandBox.y + 8;
    await window.mouse.click(bandBox.x + 4, rulerY);
    await window.waitForTimeout(700);
    await window.evaluate(() => {
      window.__scfViewportStats = { draws: 0, exact: 0 };
    });
    await window.mouse.move(bandBox.x + 4, rulerY);
    await window.mouse.down();
    for (let i = 1; i <= 40; i += 1) {
      await window.mouse.move(bandBox.x + 4 + i * 3, rulerY);
      await window.waitForTimeout(16);
    }
    await window.mouse.up();
    const scrub = await window.evaluate(() => ({ ...window.__scfViewportStats, ...window.__scfScrubStats }));
    await window.evaluate(() => {
      delete window.__scfViewportStats;
      delete window.__scfScrubStats;
    });
    check('dragging the playhead plays the sound under it', scrub.grains > 5, `${scrub.grains} grains`);
    const exactShare = scrub.exact / Math.max(1, scrub.draws);
    check('dragging the playhead forwards shows the frame under it', exactShare >= 0.5,
      `exact frame on ${Math.round(exactShare * 100)}% of ${scrub.draws} draws`);

    // A cut gives the clip under the playhead a new id, but what the drag just
    // decoded is still frames of the same file. Dragging straight back over
    // them has to find them, not start again from nothing - before the
    // decoders were handed over, a cut threw them away.
    const scrubEndX = bandBox.x + 4 + 40 * 3;
    const clipCount = () => window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    const beforeScrubCut = await clipCount();
    await window.mouse.click(scrubEndX, bandBox.y + 16);
    const afterScrubCut = await clipCount();
    await window.waitForTimeout(100);
    await window.evaluate(() => {
      window.__scfViewportStats = { draws: 0, exact: 0 };
    });
    // Above the scissors, so the press scrubs instead of cutting again.
    const backY = bandBox.y + 3;
    await window.mouse.move(scrubEndX, backY);
    await window.mouse.down();
    for (let i = 1; i <= 40; i += 1) {
      await window.mouse.move(scrubEndX - i * 3, backY);
      await window.waitForTimeout(16);
    }
    await window.mouse.up();
    const back = await window.evaluate(() => ({ ...window.__scfViewportStats }));
    await window.evaluate(() => {
      delete window.__scfViewportStats;
    });
    const backShare = back.exact / Math.max(1, back.draws);
    // 90%, not the forward check's 50%: with the decoders thrown away on the
    // cut, seeks alone still landed 53% of the time here, against 100% with
    // them handed over. Half would pass either way and prove nothing.
    check('after a cut, dragging back over covered ground shows the frame under it',
      afterScrubCut === beforeScrubCut + 1 && backShare >= 0.9,
      `${beforeScrubCut} -> ${afterScrubCut} clips; exact frame on ${Math.round(backShare * 100)}% of ${back.draws} draws`);
    // Leave the timeline as it was for the checks below.
    if (afterScrubCut > beforeScrubCut) await window.keyboard.press('Control+z');

    /* Point 6: cuts land on the playhead line, not where the pointer is ------ */
    const clipsNow = () => window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      return { frame: project.currentFrame, clips: Object.values(project.clips).map((c) => [c.trackId, c.startFrame, c.durationFrames]) };
    });
    // Put the playhead a third of the way into the video clip via the ruler.
    const videoClip = await window.evaluate((name) => {
      const { project } = window.__scfStore.getState();
      return Object.values(project.clips).find((c) => c.name === name);
    }, assetName);
    const ppf = await window.evaluate(() => window.__scfStore.getState().ui.pixelsPerFrame);
    const scroll = await window.evaluate(() => window.__scfStore.getState().ui.scrollLeftPx);
    const frameX = (f) => bandBox.x + f * ppf - scroll;
    const cutAt = videoClip.startFrame + Math.round(videoClip.durationFrames / 3);
    await window.mouse.click(frameX(cutAt), rulerY);
    const placed = (await clipsNow()).frame;

    // Razor, then click the clip well away from the playhead.
    await window.keyboard.press('Escape');
    await window.getByTitle(/Razor tool/).first().click();
    const videoRow = await window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      return project.tracks.filter((t) => t.type === 'video').length;
    });
    const beforeCut = (await clipsNow()).clips.length;
    await window.mouse.click(frameX(videoClip.startFrame + Math.round(videoClip.durationFrames * 0.8)), bandBox.y + VIDEO1_ROW_Y);
    const afterRazor = await clipsNow();
    const halves = afterRazor.clips.filter((c) => c[0] === videoClip.trackId).sort((a, b) => a[1] - b[1]);
    const boundary = halves.find((c) => c[1] > videoClip.startFrame)?.[1];
    check('a razor click cuts at the playhead, not where it clicked',
      afterRazor.clips.length === beforeCut + 1 && boundary === placed,
      `cut at frame ${boundary}, playhead at ${placed}, click at ${videoClip.startFrame + Math.round(videoClip.durationFrames * 0.8)} (${videoRow} video track)`);
    await window.keyboard.press('Control+z');
    await window.getByTitle(/Selection tool/).first().click();

    // The scissors on the playhead cut at the line too.
    const beforeScissors = (await clipsNow()).clips.length;
    await window.mouse.click(frameX(placed), bandBox.y + 16);
    const afterScissors = await clipsNow();
    check('the scissors on the playhead cut at the line',
      afterScissors.clips.length > beforeScissors && afterScissors.clips.some((c) => c[1] === placed),
      `${beforeScissors} -> ${afterScissors.clips.length} clips`);

    /* Point 9: the magnet closes the hole a deleted clip leaves -------------- */
    // Select the left half of the cut and press Delete: the right half has to
    // move up to where the left half began.
    await window.mouse.click(frameX(videoClip.startFrame + 2), bandBox.y + VIDEO1_ROW_Y);
    await window.keyboard.press('Delete');
    const afterDelete = await clipsNow();
    const survivor = afterDelete.clips.filter((c) => c[0] === videoClip.trackId);
    check('deleting a clip closes the gap it leaves (magnet)',
      survivor.length === 1 && survivor[0][1] === videoClip.startFrame,
      `the rest now starts at ${survivor[0]?.[1]}, was ${placed}`);
    await window.keyboard.press('Control+z');
    await window.keyboard.press('Control+z');

    /* Point 10: Ctrl+C / Ctrl+V with the real keys --------------------------- */
    await window.mouse.click(frameX(videoClip.startFrame + 5), bandBox.y + VIDEO1_ROW_Y);
    await window.keyboard.press('Control+c');
    const toolAfterCopy = await window.evaluate(() => window.__scfStore.getState().ui.tool);
    const pasteAt = videoClip.startFrame + videoClip.durationFrames + 10;
    await window.mouse.click(frameX(pasteAt), rulerY);
    const beforePaste = (await clipsNow()).clips.length;
    await window.keyboard.press('Control+v');
    const afterPaste = await clipsNow();
    const pastedHere = afterPaste.clips.some((c) => c[0] === videoClip.trackId && c[1] === afterPaste.frame - videoClip.durationFrames);
    check('Ctrl+C then Ctrl+V pastes the clip at the playhead',
      afterPaste.clips.length === beforePaste + 1 && pastedHere && toolAfterCopy === 'select',
      `${beforePaste} -> ${afterPaste.clips.length} clips; tool after Ctrl+C: ${toolAfterCopy}`);
    await window.keyboard.press('Control+z');

    /* LUT survives save and reopen ------------------------------------------- */
    await surface.click({ position: { x: 60, y: VIDEO1_ROW_Y } });
    await app.evaluate(({ dialog }, lut) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lut] });
    }, lutPath);

    await window.getByRole('button', { name: /LUT/ }).first().click();
    await window.getByText('identity.cube', { exact: false })
      .waitFor({ state: 'visible', timeout: 15_000 });
    check('LUT loads through the native dialog', true, 'identity.cube');

    await app.evaluate(({ dialog }, project) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: project });
    }, projectPath);
    await window.getByRole('button', { name: 'Save' }).click();
    await window.getByText('Saved to', { exact: false })
      .waitFor({ state: 'visible', timeout: 15_000 });

    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    }, projectPath);
    await window.getByRole('button', { name: 'Open' }).click();
    await window.getByText('Opened', { exact: false })
      .waitFor({ state: 'visible', timeout: 30_000 });

    // Reopening clears the selection, so the clip has to be picked again.
    await surface.click({ position: { x: 60, y: VIDEO1_ROW_Y } });
    const lutSurvived = await window.getByText('identity.cube', { exact: false })
      .isVisible().catch(() => false);
    check('LUT survives saving and reopening the project', lutSurvived);

    // Counted, not tested with isVisible(): with two missing assets there are
    // two badges, isVisible() throws a strict-mode violation, and the catch
    // turned that into "nothing missing". The check only ever worked for
    // exactly one missing file - it passed with both dropped files lost.
    const missingBadges = await window.getByText('missing', { exact: true }).count();
    const statusLine = await window.getByText('Opened', { exact: false }).first().innerText();
    check('media survives saving and reopening the project (dropped files too)',
      missingBadges === 0 && !/could not be found/.test(statusLine),
      missingBadges > 0 ? `${missingBadges} missing - ${statusLine}` : 'all restored from disk');

    /* Point 7: several video and audio tracks -------------------------------- */
    // Read off the track headers, top to bottom, as the user sees them.
    const headerNames = () => window.evaluate(() =>
      [...document.querySelectorAll('button, span, div')]
        .filter((el) => el.children.length === 0 && /^(Video|Audio) \d+$/.test(el.textContent.trim()))
        .map((el) => ({ name: el.textContent.trim(), y: el.getBoundingClientRect().top }))
        .sort((a, b) => a.y - b.y)
        .map((entry) => entry.name));
    await window.getByTitle('Add video track').click();
    await window.getByTitle('Add audio track').click();
    const rowsShown = [...new Set(await headerNames())];
    check('a new video track goes on top and a new audio track at the bottom',
      rowsShown.join(',') === 'Video 3,Video 2,Video 1,Audio 1,Audio 2', rowsShown.join(' / '));
    // Stacking follows the rows: the top row has the highest compositing order.
    const stacking = await window.evaluate(() => {
      const tracks = window.__scfStore.getState().project.tracks.filter((t) => t.type === 'video');
      return tracks.sort((a, b) => b.order - a.order).map((t) => t.name).join(',');
    });
    check('the top video row covers the ones below it', stacking === 'Video 3,Video 2,Video 1', stacking);
    await window.keyboard.press('Control+z');
    await window.keyboard.press('Control+z');

    /* The mixer, the project settings and markers --------------------------- */
    // Each panel is only real if what it shows changes the project - the
    // render reads the project, not the panel. Everything is put back after.
    const projectNow = () => window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      return {
        master: project.audio.masterVolume,
        muted: project.tracks.filter((t) => t.muted).map((t) => t.name),
        ducking: project.audio.ducking.enabled,
        width: project.width,
        height: project.height,
        fps: project.fps,
        duration: project.durationFrames,
        frame: project.currentFrame,
        markers: project.markers.map((m) => m.frame),
        clips: Object.values(project.clips).map((c) => ({ id: c.id, start: c.startFrame })),
      };
    });

    await window.getByTitle('Mixer - levels, pan, EQ and auto ducking').click();
    const mixer = window.locator('div.panel', { hasText: 'Auto ducking' });
    await mixer.waitFor({ state: 'visible', timeout: 10_000 });
    const masterFader = mixer.locator('label', { hasText: 'Master level' }).locator('input[type=range]');
    await masterFader.fill('1.5');
    const afterMaster = await projectNow();
    check('the mixer master fader sets the project master level', afterMaster.master === 1.5,
      `master ${afterMaster.master}`);
    await masterFader.fill('1');

    await mixer.getByTitle('Mute', { exact: true }).first().click();
    const afterMute = await projectNow();
    await mixer.getByTitle('Unmute', { exact: true }).first().click();
    const afterUnmute = await projectNow();
    check('the mixer mute button mutes and unmutes a track',
      afterMute.muted.length === 1 && afterUnmute.muted.length === 0,
      `muted: [${afterMute.muted}] then [${afterUnmute.muted}]`);

    // Nothing is on the dialogue bus in this project, so the switch must say
    // it does nothing rather than look like it works.
    const duckSwitch = mixer.getByLabel('Duck the music bus under dialogue');
    await duckSwitch.check();
    const duckWarned = await mixer.getByText('nothing to duck against', { exact: false })
      .isVisible().catch(() => false);
    const duckOn = (await projectNow()).ducking;
    await duckSwitch.uncheck();
    check('auto ducking turns on and warns when no track is dialogue', duckOn && duckWarned,
      `enabled ${duckOn}, warning ${duckWarned ? 'shown' : 'missing'}`);

    await mixer.getByRole('button', { name: 'Close', exact: true }).last().click();
    const mixerClosed = await mixer.isHidden();
    const afterMixer = await projectNow();
    check('the mixer closes and leaves the mix as it was',
      mixerClosed && afterMixer.master === 1 && afterMixer.muted.length === 0 && !afterMixer.ducking,
      `closed ${mixerClosed}, master ${afterMixer.master}, ducking ${afterMixer.ducking}`);

    const beforeSettings = await projectNow();
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = window.locator('div.panel', { hasText: 'Project settings' });
    await settings.waitFor({ state: 'visible', timeout: 10_000 });

    await settings.locator('label', { hasText: 'Preset' }).locator('select').selectOption('1280 x 720 (720p)');
    const afterPreset = await projectNow();
    check('a resolution preset resizes the project',
      afterPreset.width === 1280 && afterPreset.height === 720,
      `${beforeSettings.width}x${beforeSettings.height} -> ${afterPreset.width}x${afterPreset.height}`);

    // "Keep timing" is on by default: a clip that starts at 1 s must still
    // start at 1 s after the rate doubles, in twice as many frames.
    const movedClip = beforeSettings.clips.find((c) => c.start > 0) ?? beforeSettings.clips[0];
    const doubled = beforeSettings.fps * 2;
    const customRate = settings.locator('label', { hasText: 'Custom frame rate' }).locator('input');
    await customRate.fill(String(doubled));
    const afterRate = await projectNow();
    const movedStart = afterRate.clips.find((c) => c.id === movedClip.id)?.start;
    const secondsBefore = movedClip.start / beforeSettings.fps;
    const secondsAfter = movedStart / afterRate.fps;
    check('changing the frame rate keeps every clip at the same time',
      afterRate.fps === doubled && Math.abs(secondsAfter - secondsBefore) < 1 / afterRate.fps,
      `${beforeSettings.fps} -> ${afterRate.fps} fps; clip at frame ${movedClip.start} -> ${movedStart} ` +
        `(${secondsBefore.toFixed(3)}s -> ${secondsAfter.toFixed(3)}s)`);

    await customRate.fill(String(beforeSettings.fps));
    await settings.locator('label', { hasText: 'Width' }).locator('input').fill(String(beforeSettings.width));
    await settings.locator('label', { hasText: 'Height' }).locator('input').fill(String(beforeSettings.height));
    await settings.getByRole('button', { name: 'Done' }).click();
    const afterSettings = await projectNow();
    const settingsRestored = afterSettings.fps === beforeSettings.fps &&
      afterSettings.width === beforeSettings.width && afterSettings.height === beforeSettings.height &&
      afterSettings.duration === beforeSettings.duration &&
      afterSettings.clips.every((c) => beforeSettings.clips.find((b) => b.id === c.id)?.start === c.start);
    check('project settings close and put back exactly what was there',
      (await settings.isHidden()) && settingsRestored,
      `${afterSettings.width}x${afterSettings.height} @ ${afterSettings.fps} fps, ` +
        `${afterSettings.duration} frames long (was ${beforeSettings.duration})`);

    // Markers: drop one at the playhead, walk away, and jump back to it.
    // Placed by pixels, not frames: a ruler click within a few pixels of a
    // flag selects that marker, and zoomed out to fit a long clip, thirty
    // frames can be closer than that - the "away" click landed on the flag.
    const ppfNow = await window.evaluate(() => window.__scfStore.getState().ui.pixelsPerFrame);
    await window.mouse.click(bandBox.x + 40, bandBox.y + 3);
    const markerFrame = (await projectNow()).frame;
    await window.getByTitle('Add marker at the playhead (M)').click();
    const withMarker = await projectNow();
    // The button opens the new marker's name field right on the ruler, over
    // the next stretch of it - so a click there only places the caret. Name
    // it and press Enter first, as a user would.
    const namingFocused = await window.evaluate(() =>
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.classList.contains('numeric-input'));
    await window.keyboard.type('Intro');
    await window.keyboard.press('Enter');
    const markerLabel = await window.evaluate((frame) =>
      window.__scfStore.getState().project.markers.find((m) => m.frame === frame)?.label ?? null, markerFrame);
    check('a new marker opens its name field and Enter keeps the name',
      namingFocused && markerLabel === 'Intro',
      `field ${namingFocused ? 'focused' : 'not focused'}, label ${JSON.stringify(markerLabel)}`);
    await window.mouse.click(bandBox.x + 160, bandBox.y + 3);
    const awayFrame = (await projectNow()).frame;
    await window.getByTitle('Previous marker').click();
    const jumpedTo = (await projectNow()).frame;
    check('a marker lands on the playhead and Previous marker jumps back to it',
      withMarker.markers.length === beforeSettings.markers.length + 1 &&
        withMarker.markers.includes(markerFrame) && awayFrame !== markerFrame && jumpedTo === markerFrame,
      `marker at ${markerFrame}; playhead ${awayFrame} -> ${jumpedTo} ` +
        `(${ppfNow.toFixed(3)} px/frame, project ${withMarker.duration} frames long)`);
    // Two steps in the history: the name, then the marker itself.
    await window.keyboard.press('Control+z');
    const labelAfterOneUndo = await window.evaluate((frame) =>
      window.__scfStore.getState().project.markers.find((m) => m.frame === frame)?.label ?? null, markerFrame);
    await window.keyboard.press('Control+z');
    const markersAfterUndo = (await projectNow()).markers.length;
    check('naming and adding a marker undo one step at a time',
      labelAfterOneUndo !== 'Intro' && markersAfterUndo === beforeSettings.markers.length,
      `label after one undo ${JSON.stringify(labelAfterOneUndo)}; ${withMarker.markers.length} -> ${markersAfterUndo} markers`);

    /* Resizable panels ------------------------------------------------------ */
    // Every border drags, as in DaVinci Resolve. Measured on the panels
    // themselves, not on the handle: a handle that moves without resizing
    // anything cannot pass.
    const mediaPanel = window.locator('aside').filter({ hasText: 'Transparent background' }).first();
    const timelinePanel = window.locator('section.panel').filter({ has: window.getByTitle('Split at playhead (B)') }).first();
    const dragHandle = async (name, dx, dy) => {
      const box = await window.getByRole('separator', { name }).boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await window.mouse.move(x, y);
      await window.mouse.down();
      for (let i = 1; i <= 10; i += 1) await window.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
      await window.mouse.up();
    };
    const widthOf = async (locator) => Math.round((await locator.boundingBox()).width);
    const heightOf = async (locator) => Math.round((await locator.boundingBox()).height);

    const mediaBefore = await widthOf(mediaPanel);
    await dragHandle('Resize the media panel', 80, 0);
    const mediaDragged = await widthOf(mediaPanel);
    const editBeforeKey = JSON.stringify(await clipsNow());
    await window.getByRole('separator', { name: 'Resize the media panel' }).press('ArrowRight');
    const editAfterKey = JSON.stringify(await clipsNow());
    const mediaStepped = await widthOf(mediaPanel);
    persistedMediaWidth = mediaStepped;
    check('dragging the media panel border widens it, and the arrow keys step it',
      Math.abs(mediaDragged - mediaBefore - 80) <= 2 && Math.abs(mediaStepped - mediaDragged - 16) <= 2,
      `${mediaBefore} -> ${mediaDragged} px dragged, ${mediaStepped} px after ArrowRight`);
    // The editor's own arrow shortcuts nudge the selected clips. A key pressed
    // on a border used to reach them too: the clip moved a frame and the
    // export began on black. Found by the frame-accuracy check further down.
    check('an arrow key on a border resizes the panel and leaves the edit alone',
      editBeforeKey === editAfterKey,
      editBeforeKey === editAfterKey ? 'playhead and clips unchanged' : `${editBeforeKey} -> ${editAfterKey}`);

    const timelineBefore = await heightOf(timelinePanel);
    await dragHandle('Resize the timeline', 0, -60);
    const timelineDragged = await heightOf(timelinePanel);
    await window.getByRole('separator', { name: 'Resize the timeline' }).dblclick();
    const timelineReset = await heightOf(timelinePanel);
    check('dragging the timeline border makes it taller, and a double-click resets it',
      Math.abs(timelineDragged - timelineBefore - 60) <= 2 && Math.abs(timelineReset - timelineBefore) <= 2,
      `${timelineBefore} -> ${timelineDragged} px, reset to ${timelineReset} px`);

    /* Bins ------------------------------------------------------------------ */
    // Folders in the library, as in DaVinci Resolve's Media Pool. Read from the
    // store as paths, so "filed in the right bin" is checked, not just "a bin exists".
    const libraryState = () => window.evaluate(() => {
      const { assets, bins, currentBinId } = window.__scfStore.getState();
      const pathOf = (id) => {
        const names = [];
        let bin = bins.find((b) => b.id === id);
        while (bin) {
          names.unshift(bin.name);
          const parentId = bin.parentId;
          bin = bins.find((b) => b.id === parentId);
        }
        return names.join('/');
      };
      return {
        bins: bins.map((b) => pathOf(b.id)).sort(),
        current: pathOf(currentBinId),
        assets: Object.fromEntries(assets.map((a) => [a.name, pathOf(a.binId)])),
      };
    });

    await window.getByRole('button', { name: 'New bin', exact: true }).click();
    const binNameField = window.getByLabel('Bin name');
    await binNameField.waitFor({ state: 'visible', timeout: 5_000 });
    await binNameField.fill('Shots');
    await binNameField.press('Enter');
    await mediaPanel.locator('li').filter({ hasText: assetName }).first().click({ button: 'right' });
    await window.getByText('Move to Shots', { exact: true }).click();
    const afterMove = await libraryState();
    const listedInMaster = await mediaPanel.locator('li').filter({ hasText: assetName }).count();
    await window.getByRole('treeitem', { name: /Shots/ }).click();
    const listedInShots = await mediaPanel.locator('li').filter({ hasText: assetName }).count();
    check('a new bin can be named, and a clip filed into it from its menu',
      afterMove.bins.includes('Shots') && afterMove.assets[assetName] === 'Shots' && listedInMaster === 0 && listedInShots === 1,
      `bins [${afterMove.bins}]; ${assetName} in "${afterMove.assets[assetName]}", listed in Master ${listedInMaster}, in Shots ${listedInShots}`);

    await window.getByRole('treeitem', { name: /^Master/ }).click();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, folderImportRoot);
    await window.getByRole('button', { name: 'Add folder and subfolders' }).click();
    await window.waitForFunction(
      () => window.__scfStore.getState().assets.some((a) => a.name === 'still-b.png'),
      null,
      { timeout: 30_000 },
    );
    const afterFolder = await libraryState();
    check('adding a folder turns its subfolders into bins and files each clip in its own',
      ['Footage', 'Footage/Day 1', 'Footage/Day 2'].every((path) => afterFolder.bins.includes(path))
        && afterFolder.assets['still-root.png'] === 'Footage'
        && afterFolder.assets['still-a.png'] === 'Footage/Day 1'
        && afterFolder.assets['still-b.png'] === 'Footage/Day 2'
        && afterFolder.current === 'Footage',
      `bins [${afterFolder.bins.join(', ')}]; still-a.png in "${afterFolder.assets['still-a.png']}", showing "${afterFolder.current}"`);

    // Saved again, so the fresh session at the end has bins to restore.
    await app.evaluate(({ dialog }, project) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: project });
    }, projectPath);
    await window.getByRole('button', { name: 'Save' }).click();
    let savedBins = 0;
    for (let attempt = 0; attempt < 50 && savedBins !== 4; attempt += 1) {
      await window.waitForTimeout(200);
      try {
        savedBins = (JSON.parse(await readFile(projectPath, 'utf8')).bins ?? []).length;
      } catch {
        savedBins = 0;
      }
    }
    check('bins are saved with the project', savedBins === 4, `${savedBins} bins in the file`);

    /* Export --------------------------------------------------------------- */
    // The export picks a FOLDER in a dialog and takes the name from a text
    // field, so the folder dialog is what gets stubbed.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, workDir);

    await window.getByRole('button', { name: 'Export' }).click();
    await window.getByText('Target bitrate', { exact: false })
      .waitFor({ state: 'visible', timeout: 10_000 });
    check('export dialog opens', true);

    // Scope every field lookup to the dialog. The inspector is open behind it
    // with number inputs of its own, and an unscoped nth() lands in there -
    // silently editing the clip instead of the export range.
    const dialog = window.locator('div[role="dialog"], .panel').filter({
      hasText: 'Target bitrate',
    }).first();

    // Laid out like Resolve's Deliver page: the actions sit at the top.
    const startBox = await dialog.getByRole('button', { name: 'Start export' }).boundingBox();
    const formatBox = await dialog.getByText('Format', { exact: true }).first().boundingBox();
    check('Start export sits at the top, above the settings',
      Boolean(startBox && formatBox) && startBox.y < formatBox.y,
      `button at y ${Math.round(startBox?.y ?? -1)}, Format at y ${Math.round(formatBox?.y ?? -1)}`);

    const exportState = () => window.evaluate(() => {
      const s = window.__scfStore.getState().exportSettings;
      return { format: s.format, alpha: s.exportAlpha, size: `${s.width}x${s.height}` };
    });
    await dialog.getByRole('button', { name: /^Sprite frames/ }).click();
    const spritePreset = await exportState();
    await dialog.getByRole('button', { name: /^Project/ }).click();
    const projectPreset = await exportState();
    check('quick presets set format, size and transparency together',
      spritePreset.format === 'png-sequence' && spritePreset.alpha
        && projectPreset.format === 'mp4-h264' && !projectPreset.alpha,
      `Sprite frames: ${spritePreset.format}${spritePreset.alpha ? ' + alpha' : ''} ${spritePreset.size}; Project: ${projectPreset.format} ${projectPreset.size}`);


    await dialog.getByLabel('Start frame').fill('0');
    await dialog.getByLabel('End frame').fill(String(EXPORT_FRAMES));

    check('export range fields accept input',
      (await dialog.getByLabel('End frame').inputValue()) === String(EXPORT_FRAMES));

    const resolutionOptions = await dialog.locator('select').filter({ hasText: '4K UHD' }).first()
      .locator('option').allInnerTexts().catch(() => []);
    check('the export offers 720p, 1080p, 2K and 4K presets',
      ['720p', '1080p', '2K', '4K'].every((name) => resolutionOptions.some((text) => text.includes(name))),
      resolutionOptions.join(' / '));

    await dialog.getByLabel('File name').fill('ui-export');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await dialog.getByText('Will save as', { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
    const target = await dialog.getByText('Will save as', { exact: false }).innerText();
    check('the typed file name decides the output file', target.includes('ui-export.mp4'), target);

    // The thumbnail: the frame under the playhead, embedded as cover art.
    await dialog.getByRole('button', { name: 'Use the frame at the playhead' }).click();
    const thumbnailShown = await dialog.getByAltText('Thumbnail')
      .waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    check('a thumbnail can be taken from the playhead', thumbnailShown);

    const blurred = await window.evaluate(() =>
      [...document.querySelectorAll('div')].some((el) => getComputedStyle(el).backdropFilter.includes('blur')));
    check('the editor behind the export dialog is blurred', blurred);

    await dialog.getByRole('button', { name: 'Start export' }).click();
    await window.getByText('Export finished', { exact: false })
      .waitFor({ state: 'visible', timeout: 180_000 });
    check('export completes through the dialog', true);
    const barBox = await dialog.getByRole('progressbar').boundingBox();
    const formatAfterBox = await dialog.getByText('Format', { exact: true }).first().boundingBox();
    check('the render progress shows at the top, above the settings',
      Boolean(barBox && formatAfterBox) && barBox.y < formatAfterBox.y,
      `progress at y ${Math.round(barBox?.y ?? -1)}, Format at y ${Math.round(formatAfterBox?.y ?? -1)}`);

    /* The file itself ------------------------------------------------------- */
    const info = await stat(exportPath).catch(() => null);
    check('export produced a file', info !== null && info.size > 1000,
      info ? `${info.size} bytes` : 'missing');

    if (info) {
      const summary = await probe(exportPath);
      check('exported file has a video stream', /Video: h264/.test(summary));
      check('exported file has an audio stream', /Audio: aac/.test(summary));
      check('the thumbnail is embedded as the file cover', /(attached pic)/.test(summary),
        /(attached pic)/.test(summary) ? 'attached_pic stream present' : 'no cover stream');

      // Without this the range fields could silently do nothing and every other
      // check would still pass - it did exactly that once.
      const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(summary);
      const seconds = duration
        ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
        : 0;
      const expected = EXPORT_FRAMES / 30;
      check('exported only the requested range',
        Math.abs(seconds - expected) < 0.2,
        `${seconds.toFixed(2)}s vs ${expected.toFixed(2)}s requested`);

      const accuracy = await frameAccuracy(exportPath, sourceVideo, EXPORT_FRAMES);
      check('every exported frame is the right picture',
        accuracy.count === EXPORT_FRAMES && accuracy.wrong.length === 0,
        accuracy.wrong.length
          ? `${accuracy.wrong.length}/${accuracy.count} wrong, e.g. frame ${accuracy.wrong.slice(0, 5).join(', ')}`
          : `${accuracy.count}/${EXPORT_FRAMES} match the source`);
    }

    if (offline) {
      const external = await app.evaluate(() => globalThis.__externalRequests ?? []);
      check('no network request attempted with the network cut', external.length === 0,
        external.length ? external.slice(0, 3).join(', ') : 'none attempted');
    }

    check('no console errors during the whole session', consoleIssues.length === 0,
      consoleIssues.length ? consoleIssues[0] : 'clean');

    // Last on purpose: Playwright keeps waiting for the navigation it saw start,
    // even though the app cancelled it, so nothing can run after this.
    // The main process refuses navigation: this is the backstop for a file
    // dropped outside any drop zone, which Chromium would otherwise open in the
    // window, replacing the editor.
    const urlBefore = window.url();
    await window.evaluate((path) => {
      window.location.href = `file:///${path.replace(/\\/g, '/')}`;
    }, timelineDropImage).catch(() => undefined);
    await window.waitForTimeout(1000);
    const stillEditor = window.url() === urlBefore
      && await window.getByRole('button', { name: 'Import' }).isVisible().catch(() => false);
    check('a stray file cannot replace the editor', stillEditor, window.url());
  } finally {
    await app.close().catch(() => undefined);
  }

  /* A fresh session ---------------------------------------------------------- */
  // Reopening inside the session that saved the project proves little: the
  // read allowlist is in memory, and there it still holds every path. In a new
  // process it starts empty - and a project saved one day reopened the next
  // with EVERY clip missing. Only a second launch can see that.
  console.log('4. reopening the project in a brand new session');
  const second = await electron.launch({
    ...(packagedExe
      ? { executablePath: packagedExe, args: [profileArg] }
      : { args: [profileArg, join(projectRoot, 'dist-electron/main/index.js')] }),
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined },
  });
  try {
    const window = await second.firstWindow();
    await second.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    }, projectPath);
    await window.getByRole('button', { name: 'Open' }).click();
    const status = await window.getByText('Opened', { exact: false }).first()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => window.getByText('Opened', { exact: false }).first().innerText())
      .catch(() => 'did not open');
    const missing = await window.getByText('missing', { exact: true }).count();
    check('a saved project reopens in a NEW session with all its media',
      missing === 0 && status.startsWith('Opened') && !/could not be found/.test(status),
      missing > 0 ? `${missing} missing - ${status}` : 'all restored from disk');

    const reopenedBins = await window.evaluate(() => {
      const { assets, bins } = window.__scfStore.getState();
      const nameOf = (id) => bins.find((b) => b.id === id)?.name ?? null;
      return { count: bins.length, dayOne: nameOf(assets.find((a) => a.name === 'still-a.png')?.binId) };
    });
    check('bins, and the bin each clip is in, survive reopening in a new session',
      reopenedBins.count === 4 && reopenedBins.dayOne === 'Day 1',
      `${reopenedBins.count} bins; still-a.png in ${reopenedBins.dayOne}`);

    const reopenedMediaWidth = Math.round(
      (await window.locator('aside').filter({ hasText: 'Transparent background' }).first().boundingBox()).width,
    );
    check('panel sizes are remembered in a new session',
      persistedMediaWidth !== null && Math.abs(reopenedMediaWidth - persistedMediaWidth) <= 2,
      `media panel ${reopenedMediaWidth} px (left at ${persistedMediaWidth})`);
  } finally {
    await second.close().catch(() => undefined);
  }

  const failures = checks.filter((entry) => !entry.passed).length;
  console.log('');
  console.log(`${checks.length - failures}/${checks.length} UI checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
