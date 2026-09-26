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
const droppedFolderRoot = join(workDir, 'Dropped');

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
  // And one to drag in from "Explorer", for the folder drop.
  await mkdir(join(droppedFolderRoot, 'Clips'), { recursive: true });
  await copyFile(panelDropImage, join(droppedFolderRoot, 'Clips', 'still-drop.png'));

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

/**
 * Choose an application-menu entry the way a user does: the menu button at
 * the left of the title bar, the menu (File, Edit...), then the item. The
 * window has no native menu bar under its own title bar; this is the same
 * menu, read from the main process.
 */
async function appMenu(window, menu, item) {
  await window.getByTestId('app-menu-button').click();
  await window.getByRole('menuitem', { name: menu, exact: true }).click();
  // A ticked entry (View > Inspector) is a checkbox item.
  await window.getByRole('menuitem', { name: item }).or(window.getByRole('menuitemcheckbox', { name: item })).click();
  await window.waitForTimeout(250);
}

/**
 * Close an app, and give up on asking nicely after a few seconds.
 *
 * A native dialog - "Save changes to...?" - blocks Electron's close for as
 * long as it is open, and Playwright waits for it. Left alone overnight that
 * is a window sitting on somebody's desktop and a test run that never
 * finishes. The window is killed if it will not go.
 */
async function closeApp(app, seconds = 8) {
  const closed = app.close().then(() => true, () => true);
  const timedOut = new Promise((resolve) => setTimeout(() => resolve(false), seconds * 1000));
  if (await Promise.race([closed, timedOut])) return;

  console.log(`   (a window would not close in ${seconds}s - ending it)`);
  const process_ = app.process();
  try {
    process_.kill('SIGKILL');
  } catch {
    // Already gone, which is the outcome wanted anyway.
  }
}

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

    // The app opens on its start screen, as Resolve opens on its Project
    // Manager; a blank project is one click from there.
    const home = window.getByRole('main', { name: 'Start screen' });
    check('the app opens on the start screen', await home.isVisible());
    await window.getByRole('button', { name: 'Blank project' }).click();
    const leftHome = await home.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false);
    check('Blank project goes straight to an empty, untitled editor',
      leftHome && (await window.getByTestId('project-name').innerText()) === 'Untitled project');

    check('media panel starts empty',
      await window.getByText('Drop files here').isVisible());

    // Replace the native dialogs. They run in the main process, so this is the
    // only way to make them deterministic.
    await app.evaluate(({ dialog }, { video, output }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
      // "Don't save" by default, so that closing the window at the end of the
      // run never waits on a native prompt nobody is there to answer. The
      // close-prompt check below installs its own stub while it runs.
      dialog.showMessageBox = async () => ({ response: 1 });
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
    // The inspector names the clip it is inspecting, which is proof the click
    // selected one. "TRANSFORM" is a heading in that panel and also the name
    // of the viewer's mode, so it is the wrong word to look for.
    const inspectorHasClip = await window.evaluate(() => {
      const { ui, project } = window.__scfStore.getState();
      return ui.selectedClipIds.length === 1 && Boolean(project.clips[ui.selectedClipIds[0]]);
    });
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
    await appMenu(window, 'File', /^Save$/);
    await window.getByText('Saved to', { exact: false })
      .waitFor({ state: 'visible', timeout: 15_000 });

    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    }, projectPath);
    await appMenu(window, 'File', /^Open project/);
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

    await window.getByRole('button', { name: 'Mixer', exact: true }).click();
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
    // Dialogs play a short exit animation, so this waits for it to go rather
    // than looking the instant the button is clicked.
    await mixer.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    const mixerClosed = (await mixer.count()) === 0;
    const afterMixer = await projectNow();
    check('the mixer closes and leaves the mix as it was',
      mixerClosed && afterMixer.master === 1 && afterMixer.muted.length === 0 && !afterMixer.ducking,
      `closed ${mixerClosed}, master ${afterMixer.master}, ducking ${afterMixer.ducking}`);

    const beforeSettings = await projectNow();
    await appMenu(window, 'File', /^Project settings/);
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
    await settings.locator('label', { hasText: /^Frame rate/ }).locator('select').selectOption('custom');
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
      (await settings.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false)) && settingsRestored,
      `${afterSettings.width}x${afterSettings.height} @ ${afterSettings.fps} fps, ` +
        `${afterSettings.duration} frames long (was ${beforeSettings.duration})`);

    /* Dragging the picture in the viewer ------------------------------------ */
    // Select the clip on the timeline, then push it around in the viewer the
    // way an editor would, and read back the same numbers the inspector shows.
    // The controls only show for a clip that is actually on screen, so the
    // playhead goes onto it first - the same rule Filmora and Premiere follow.
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const clip = Object.values(store.project.clips)[0];
      store.setCurrentFrame(clip.startFrame + 5);
      store.setUi({ selectedClipIds: [clip.id], selectedTrackId: clip.trackId });
    });
    const viewportTransformNow = () => window.evaluate(() => {
      const { project, ui } = window.__scfStore.getState();
      const clip = project.clips[ui.selectedClipIds[0]];
      const last = (track, fallback) => (track.length ? track[track.length - 1].value : fallback);
      return {
        position: last(clip.transform.position, { x: 0, y: 0 }),
        scale: last(clip.transform.scale, { x: 1, y: 1 }),
        rotation: last(clip.transform.rotation, 0),
      };
    });

    // The handles are a mode, as they are in Final Cut: a selected clip on
    // its own leaves the viewer alone.
    const handlesBeforeMode = await window.evaluate(() =>
      document.querySelectorAll('[data-testid^="viewport-handle-"]').length);
    await window.evaluate(() => window.__scfStore.getState().setUi({ transformMode: true }));
    const viewportGrip = window.getByTestId('viewport-handle-topRight');
    const viewportGripShown = await viewportGrip.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    check('the transform mode puts handles on the selected clip, and nothing before it',
      viewportGripShown && handlesBeforeMode === 0,
      `${handlesBeforeMode} handles before the mode, grip visible ${viewportGripShown}`);

    const beforeViewportDrag = await viewportTransformNow();
    const viewportGripBox = await viewportGrip.boundingBox();
    await window.mouse.move(viewportGripBox.x + viewportGripBox.width / 2, viewportGripBox.y + viewportGripBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(viewportGripBox.x + viewportGripBox.width / 2 - 60, viewportGripBox.y + viewportGripBox.height / 2 + 34, { steps: 10 });
    await window.mouse.up();
    const afterViewportScale = await viewportTransformNow();
    const viewportShrank = afterViewportScale.scale.x < beforeViewportDrag.scale.x && afterViewportScale.scale.y < beforeViewportDrag.scale.y;
    const viewportKeptProportions = Math.abs(afterViewportScale.scale.x - afterViewportScale.scale.y) < 0.001;
    check('dragging a corner handle scales the clip, keeping its proportions', viewportShrank && viewportKeptProportions,
      `scale ${beforeViewportDrag.scale.x.toFixed(3)} -> ${afterViewportScale.scale.x.toFixed(3)} x ${afterViewportScale.scale.y.toFixed(3)}`);

    const previewCanvas = window.locator('canvas').first();
    const previewCanvasBox = await previewCanvas.boundingBox();
    await window.mouse.move(previewCanvasBox.x + previewCanvasBox.width / 2, previewCanvasBox.y + previewCanvasBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(previewCanvasBox.x + previewCanvasBox.width / 2 + 70, previewCanvasBox.y + previewCanvasBox.height / 2 - 30, { steps: 8 });
    await window.mouse.up();
    const afterViewportMove = await viewportTransformNow();
    check('dragging the picture moves the clip',
      afterViewportMove.position.x > afterViewportScale.position.x && afterViewportMove.position.y < afterViewportScale.position.y,
      `position ${afterViewportScale.position.x.toFixed(0)},${afterViewportScale.position.y.toFixed(0)} -> ${afterViewportMove.position.x.toFixed(0)},${afterViewportMove.position.y.toFixed(0)}`);

    // One drag is one edit: two of them, two undos, back where it started.
    await window.keyboard.press('Control+z');
    await window.keyboard.press('Control+z');
    const afterViewportUndo = await viewportTransformNow();
    check('each drag in the viewer is a single undo step',
      Math.abs(afterViewportUndo.scale.x - beforeViewportDrag.scale.x) < 0.001
      && Math.abs(afterViewportUndo.position.x - beforeViewportDrag.position.x) < 0.5
      && Math.abs(afterViewportUndo.position.y - beforeViewportDrag.position.y) < 0.5,
      `back to scale ${afterViewportUndo.scale.x.toFixed(3)}, position ${afterViewportUndo.position.x.toFixed(0)},${afterViewportUndo.position.y.toFixed(0)}`);

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
    const mediaPanel = window.getByTestId('media-panel');
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

    // A folder dragged out of Explorer. Chromium's own drag with the folder's
    // path arrives exactly as a real one does - a directory entry - where a
    // DataTransfer built in the page could only ever carry files.
    await window.getByRole('treeitem', { name: /^Master/ }).click();
    const cdp = await window.context().newCDPSession(window);
    const panelBox = await mediaPanel.boundingBox();
    const dropPoint = { x: Math.round(panelBox.x + panelBox.width / 2), y: Math.round(panelBox.y + panelBox.height * 0.7) };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', {
        type,
        ...dropPoint,
        data: { items: [], files: [droppedFolderRoot], dragOperationsMask: 1 },
      });
    }
    await window.waitForFunction(
      () => window.__scfStore.getState().assets.some((a) => a.name === 'still-drop.png'),
      null,
      { timeout: 30_000 },
    ).catch(() => undefined);
    const afterFolderDrop = await libraryState();
    check('a folder dropped from Explorer becomes bins, like the folder button',
      afterFolderDrop.bins.includes('Dropped') && afterFolderDrop.bins.includes('Dropped/Clips')
        && afterFolderDrop.assets['still-drop.png'] === 'Dropped/Clips',
      `bins [${afterFolderDrop.bins.join(', ')}]; still-drop.png in "${afterFolderDrop.assets['still-drop.png'] ?? 'not imported'}"`);

    // Bin edits undo from the keyboard like any other edit.
    await window.getByRole('button', { name: 'New bin', exact: true }).click();
    const tempBinName = window.getByLabel('Bin name');
    await tempBinName.waitFor({ state: 'visible', timeout: 5_000 });
    await tempBinName.fill('Temp');
    await tempBinName.press('Enter');
    // Paths, and the new bin lands inside whichever bin is on show: compare names.
    const binLeafNames = (paths) => paths.map((path) => path.split('/').pop());
    const withTemp = binLeafNames((await libraryState()).bins).includes('Temp');
    await window.keyboard.press('Control+z'); // the rename
    await window.keyboard.press('Control+z'); // the new bin
    const afterBinUndo = (await libraryState()).bins;
    await window.keyboard.press('Control+Shift+z');
    const afterBinRedo = (await libraryState()).bins;
    await window.keyboard.press('Control+z');
    const afterBinSettle = (await libraryState()).bins;
    const unnamed = (paths) => binLeafNames(paths).some((name) => /^Bin \d+$/.test(name));
    check('Ctrl+Z takes back a new bin and its name, Ctrl+Shift+Z brings the bin back',
      withTemp && !binLeafNames(afterBinUndo).includes('Temp') && !unnamed(afterBinUndo) && unnamed(afterBinRedo) && !unnamed(afterBinSettle),
      `named Temp ${withTemp}; after two undos [${afterBinUndo.join(', ')}]; after redo [${afterBinRedo.join(', ')}]`);

    // Saved again, so the fresh session at the end has bins to restore.
    await app.evaluate(({ dialog }, project) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: project });
    }, projectPath);
    // Ctrl+S this time: the key and the menu are the same save.
    await window.keyboard.press('Control+s');
    let savedBins = 0;
    for (let attempt = 0; attempt < 50 && savedBins !== 6; attempt += 1) {
      await window.waitForTimeout(200);
      try {
        savedBins = (JSON.parse(await readFile(projectPath, 'utf8')).bins ?? []).length;
      } catch {
        savedBins = 0;
      }
    }
    check('bins are saved with the project', savedBins === 6, `${savedBins} bins in the file`);

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
    // By its role and name, not by text inside it: once finished, the settings
    // (and "Target bitrate" with them) fold out of view.
    const dialog = window.getByRole('dialog', { name: 'Export' });

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
    // Finished, the dialog reads as done: the result and its next steps on
    // top, no "Start export" inviting the same render again, and the settings
    // folded into a record below.
    const barBox = await dialog.getByRole('progressbar').boundingBox();
    const settingsUsed = dialog.getByRole('button', { name: /Settings used/ });
    const settingsUsedBox = await settingsUsed.boundingBox();
    const finishedState = {
      startExport: await dialog.getByRole('button', { name: 'Start export' }).count(),
      newExport: await dialog.getByRole('button', { name: 'New export' }).isVisible(),
      showInFolder: await dialog.getByRole('button', { name: 'Show in folder' }).isVisible(),
      play: await dialog.getByRole('button', { name: 'Play', exact: true }).isVisible(),
      folded: (await settingsUsed.getAttribute('aria-expanded')) === 'false'
        && !(await dialog.getByText('Format', { exact: true }).first().isVisible()),
    };
    check('a finished export reads as done: New export, Show in folder and Play, settings folded',
      finishedState.startExport === 0 && finishedState.newExport && finishedState.showInFolder
        && finishedState.play && finishedState.folded,
      JSON.stringify(finishedState));
    check('the finished render shows at the top, above the settings',
      Boolean(barBox && settingsUsedBox) && barBox.y < settingsUsedBox.y,
      `progress at y ${Math.round(barBox?.y ?? -1)}, settings at y ${Math.round(settingsUsedBox?.y ?? -1)}`);

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

    /* In and out, the shuttle, and three-point edits ------------------------- */
    // The export section leaves its dialog open, and its backdrop takes clicks.
    const openExport = window.getByRole('dialog', { name: 'Export' });
    if ((await openExport.count()) > 0) {
      await openExport.getByTitle('Close').click();
      await openExport.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    }

    // Keys go to the window, so focus something that is not a field first.
    await window.getByTestId('project-name').click();
    const markState = () => window.evaluate(() => {
      const { ui, project } = window.__scfStore.getState();
      const clips = Object.values(project.clips);
      return {
        in: ui.inFrame,
        out: ui.outFrame,
        rate: ui.playbackRate,
        playing: ui.isPlaying,
        count: clips.length,
        end: clips.reduce((last, clip) => Math.max(last, clip.startFrame + clip.durationFrames), 0),
        atTwenty: clips.filter((clip) => clip.startFrame === 20).map((clip) => ({ id: clip.id, length: clip.durationFrames })),
      };
    });

    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(20));
    await window.keyboard.press('i');
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(80));
    await window.keyboard.press('o');
    const marked = await markState();
    // Out sits one past the frame it keeps, so 20..80 inclusive is 61 frames.
    check('I and O mark a range, the out point keeping its own frame',
      marked.in === 20 && marked.out === 81, `in ${marked.in}, out ${marked.out}`);

    await window.keyboard.press('l');
    await window.keyboard.press('l');
    const shuttling = await markState();
    await window.keyboard.press('j');
    const slowed = await markState();
    await window.keyboard.press('k');
    const halted = await markState();
    check('L shuttles faster each press, J slows it, K stops',
      shuttling.rate === 2 && shuttling.playing && slowed.rate === 1 && !halted.playing,
      `L L = ${shuttling.rate}x, then J = ${slowed.rate}x, playing after K ${halted.playing}`);

    const beforeEdits = await markState();
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const video = store.assets.find((asset) => asset.kind === 'video');
      store.setUi({ selectedAssetId: video.id, selectedTrackId: store.project.tracks.find((t) => t.type === 'video').id });
      store.setCurrentFrame(20);
    });

    await window.keyboard.press(',');
    const inserted = await markState();
    check('comma inserts the marked length at the in point, pushing what follows',
      inserted.atTwenty.length === 1 && inserted.atTwenty[0].length === 61 && inserted.end === beforeEdits.end + 61,
      `clip at 20 is ${inserted.atTwenty[0]?.length} frames; timeline ${beforeEdits.end} -> ${inserted.end}`);

    await window.keyboard.press('.');
    const overwritten = await markState();
    check('full stop overwrites in place, leaving the length alone',
      overwritten.atTwenty.length === 1 && overwritten.atTwenty[0].length === 61
      && overwritten.atTwenty[0].id !== inserted.atTwenty[0]?.id && overwritten.end === inserted.end,
      `timeline ${inserted.end} -> ${overwritten.end}`);

    // The export renders exactly what is marked.
    await window.getByRole('button', { name: 'Export' }).click();
    const rangeDialog = window.getByRole('dialog', { name: 'Export' });
    await rangeDialog.getByText('This render:').waitFor({ timeout: 60_000 });
    await rangeDialog.getByRole('button', { name: 'In to out' }).click();
    const exportRange = {
      start: Number(await rangeDialog.getByLabel('Start frame').inputValue()),
      end: Number(await rangeDialog.getByLabel('End frame').inputValue()),
    };
    await rangeDialog.getByTitle('Close').click();
    await rangeDialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    check('the export can render the marked range only',
      exportRange.start === 20 && exportRange.end === 81, JSON.stringify(exportRange));

    // Put the timeline back: one undo each, and the marks cleared.
    await window.getByTestId('project-name').click();
    await window.keyboard.press('Control+z');
    await window.keyboard.press('Control+z');
    const undone = await markState();
    check('each three-point edit is a single undo step',
      undone.count === beforeEdits.count && undone.end === beforeEdits.end,
      `${undone.count} clips ending at ${undone.end}, was ${beforeEdits.count} ending at ${beforeEdits.end}`);
    await window.keyboard.press('Control+Shift+x');
    const cleared = await markState();
    check('Ctrl+Shift+X clears the marks', cleared.in === null && cleared.out === null);

    /* The trim tool: roll, slip, slide and ripple ---------------------------- */
    // Built on a track of its own so the rest of the timeline is left alone,
    // then undone at the end, step by step.
    const beforeTrims = await window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      return { clips: Object.keys(project.clips).length, tracks: project.tracks.length };
    });

    const trimSetup = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const video = store.assets.find((asset) => asset.kind === 'video');
      // Cut to the footage that exists: a clip longer than its source leaves
      // every trim pinned to the end of the media instead of moving.
      const fps = store.project.fps;
      const source = video.durationSeconds !== undefined
        ? Math.round(video.durationSeconds * fps)
        : video.durationFrames;
      const unit = Math.floor(source / 3);
      store.addTrack('video');
      const state = window.__scfStore.getState();
      const track = state.project.tracks.reduce((top, candidate) =>
        candidate.type === 'video' && candidate.order > top.order ? candidate : top,
        state.project.tracks.find((candidate) => candidate.type === 'video'));
      const id = store.addAssetToTimeline(video, track.id, 0);
      store.trimClip(id, 'end', unit * 3);
      store.razorAtFrame(unit, [id]);
      const middle = Object.values(window.__scfStore.getState().project.clips)
        .find((clip) => clip.trackId === track.id && clip.startFrame === unit);
      store.razorAtFrame(unit * 2, [middle.id]);
      store.setUi({ pixelsPerFrame: 2, scrollLeftPx: 0, tool: 'trim' });

      // Which row the canvas draws this track on: videos top down, then audio.
      const tracks = window.__scfStore.getState().project.tracks;
      const videos = tracks.filter((t) => t.type === 'video').sort((a, b) => b.order - a.order);
      const rest = tracks.filter((t) => t.type !== 'video').sort((a, b) => b.order - a.order);
      return { trackId: track.id, unit, row: [...videos, ...rest].findIndex((t) => t.id === track.id) };
    });

    const trimShape = () => window.evaluate((trackId) => Object.values(window.__scfStore.getState().project.clips)
      .filter((clip) => clip.trackId === trackId)
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((clip) => `${clip.startFrame}+${clip.durationFrames}@${clip.sourceOffsetFrames}`), trimSetup.trackId);

    // The timeline may be scrolled: put it back to the head and read where it
    // really sits, rather than assuming the canvas starts at frame zero.
    await window.evaluate(() => {
      const canvas = [...document.querySelectorAll('canvas')].pop();
      let element = canvas?.parentElement;
      while (element && element.scrollWidth <= element.clientWidth) element = element.parentElement;
      if (element) element.scrollLeft = 0;
    });
    await window.waitForTimeout(150);
    const trimView = await window.evaluate(() => {
      const { ui } = window.__scfStore.getState();
      return { perFrame: ui.pixelsPerFrame, scroll: ui.scrollLeftPx };
    });
    const trimBox = await surface.boundingBox();
    const trimRowTop = trimBox.y + 24 + trimSetup.row * 58;
    const atFrame = (frame) => trimBox.x + frame * trimView.perFrame - trimView.scroll;
    const trimDrag = async (fromFrame, y, toFrame) => {
      await window.mouse.move(atFrame(fromFrame), y);
      await window.mouse.down();
      await window.mouse.move(atFrame(toFrame), y, { steps: 8 });
      await window.mouse.up();
      await window.waitForTimeout(120);
    };

    const unit = trimSetup.unit;
    const step = Math.max(4, Math.round(unit / 3));
    const laid = await trimShape();
    check('the trim tool starts from three clips in a row',
      laid.join(' ') === `0+${unit}@0 ${unit}+${unit}@${unit} ${unit * 2}+${unit}@${unit * 2}`, laid.join('  '));

    await trimDrag(unit, trimRowTop + 28, unit + step);
    const rolled = await trimShape();
    check('dragging a shared join rolls it: one gives what the other takes',
      rolled[0] === `0+${unit + step}@0`
      && rolled[1] === `${unit + step}+${unit - step}@${unit + step}`
      && rolled[2] === laid[2],
      rolled.join('  '));

    const slipFrom = Math.round(unit * 1.5) + step;
    await trimDrag(slipFrom, trimRowTop + 14, slipFrom + step);
    const slipped = await trimShape();
    check('dragging the top of a clip slips the footage inside it, and nothing moves',
      slipped[1] === `${unit + step}+${unit - step}@${unit}` && slipped[0] === rolled[0] && slipped[2] === rolled[2],
      slipped.join('  '));

    await trimDrag(slipFrom, trimRowTop + 44, slipFrom + step);
    const slid = await trimShape();
    check('dragging the bottom slides it, and its neighbours give and take',
      slid[0] === `0+${unit + step * 2}@0`
      && slid[1] === `${unit + step * 2}+${unit - step}@${unit}`
      && slid[2] === `${unit * 2 + step}+${unit - step}@${unit * 2 + step}`,
      slid.join('  '));

    await trimDrag(unit * 3, trimRowTop + 28, unit * 3 - step);
    const rippled = await trimShape();
    check('dragging a free edge ripples it',
      rippled[2] === `${unit * 2 + step}+${unit - step * 2}@${unit * 2 + step}`, rippled.join('  '));

    // Each trim is one step, and so is each piece of the setup: nine in all.
    await window.getByTestId('project-name').click();
    for (let undoStep = 0; undoStep < 9; undoStep += 1) await window.keyboard.press('Control+z');
    const afterTrims = await window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      return { clips: Object.keys(project.clips).length, tracks: project.tracks.length };
    });
    await window.evaluate(() => window.__scfStore.getState().setTool('select'));
    check('every trim is a single undo step, and the timeline comes back',
      afterTrims.clips === beforeTrims.clips && afterTrims.tracks === beforeTrims.tracks,
      `${afterTrims.clips} clips on ${afterTrims.tracks} tracks, was ${beforeTrims.clips} on ${beforeTrims.tracks}`);

    /* Linked clips ---------------------------------------------------------- */
    // A shot and the title over it, linked: from then on they are one thing.
    const beforeLinks = await window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      return { clips: Object.keys(project.clips).length, tracks: project.tracks.length };
    });

    const linkSetup = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const video = store.assets.find((asset) => asset.kind === 'video');
      const length = Math.floor((video.durationSeconds
        ? Math.round(video.durationSeconds * store.project.fps)
        : video.durationFrames) / 2);

      store.addTrack('video');
      window.__scfStore.getState().addTrack('video');
      const tracks = window.__scfStore.getState().project.tracks
        .filter((track) => track.type === 'video')
        .sort((a, b) => a.order - b.order);
      const [lower, upper] = tracks.slice(-2);

      const lowerId = window.__scfStore.getState().addAssetToTimeline(video, lower.id, 0);
      const upperId = window.__scfStore.getState().addAssetToTimeline(video, upper.id, 0);
      const state = window.__scfStore.getState();
      state.trimClip(lowerId, 'end', length);
      window.__scfStore.getState().trimClip(upperId, 'end', length);
      window.__scfStore.getState().setUi({ pixelsPerFrame: 2, scrollLeftPx: 0, tool: 'select' });

      const ordered = window.__scfStore.getState().project.tracks;
      const videos = ordered.filter((t) => t.type === 'video').sort((a, b) => b.order - a.order);
      const rest = ordered.filter((t) => t.type !== 'video').sort((a, b) => b.order - a.order);
      const rows = [...videos, ...rest];
      return {
        lowerId,
        upperId,
        length,
        lowerRow: rows.findIndex((t) => t.id === lower.id),
        upperRow: rows.findIndex((t) => t.id === upper.id),
      };
    });

    const linkState = () => window.evaluate((ids) => {
      const { project, ui } = window.__scfStore.getState();
      const lower = project.clips[ids.lowerId];
      const upper = project.clips[ids.upperId];
      return {
        linked: Boolean(lower.linkGroup) && lower.linkGroup === upper.linkGroup,
        selected: ui.selectedClipIds.length,
        lower: `${lower.startFrame}+${lower.durationFrames}`,
        upper: `${upper.startFrame}+${upper.durationFrames}`,
      };
    }, linkSetup);

    await window.evaluate(() => {
      const canvas = [...document.querySelectorAll('canvas')].pop();
      let element = canvas?.parentElement;
      while (element && element.scrollWidth <= element.clientWidth) element = element.parentElement;
      if (element) element.scrollLeft = 0;
    });
    await window.waitForTimeout(150);
    const linkView = await window.evaluate(() => {
      const { ui } = window.__scfStore.getState();
      return { perFrame: ui.pixelsPerFrame, scroll: ui.scrollLeftPx };
    });
    const linkBox = await surface.boundingBox();
    const linkX = (frame) => linkBox.x + frame * linkView.perFrame - linkView.scroll;
    const linkY = (row) => linkBox.y + 24 + row * 58 + 28;
    const linkDrag = async (fromFrame, row, toFrame, modifiers = []) => {
      await window.mouse.move(linkX(fromFrame), linkY(row));
      await window.mouse.down();
      await window.mouse.move(linkX(toFrame), linkY(row), { steps: 8 });
      await window.mouse.up();
      await window.waitForTimeout(150);
    };

    const half = Math.round(linkSetup.length / 2);
    const nudge = Math.max(10, Math.round(linkSetup.length / 4));

    await window.evaluate((ids) => window.__scfStore.getState().selectClips([ids.lowerId, ids.upperId]), linkSetup);
    await window.keyboard.press('Control+l');
    await window.waitForTimeout(120);
    const linked = await linkState();
    check('Ctrl+L links the selected clips', linked.linked, JSON.stringify(linked));

    // Clicking one of them, with the mouse, selects the pair.
    await window.mouse.click(linkX(half), linkY(linkSetup.lowerRow));
    await window.waitForTimeout(120);
    const clicked = await linkState();
    check('clicking one linked clip selects both', clicked.selected === 2, `${clicked.selected} selected`);

    await linkDrag(half, linkSetup.lowerRow, half + nudge);
    const dragged = await linkState();
    check('dragging one linked clip moves the other with it',
      dragged.lower === `${nudge}+${linkSetup.length}` && dragged.upper === dragged.lower,
      `${dragged.lower} / ${dragged.upper}`);

    await window.evaluate((ids) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[ids.lowerId];
      store.trimClip(ids.lowerId, 'end', clip.startFrame + clip.durationFrames - 20);
    }, linkSetup);
    await window.waitForTimeout(120);
    const trimmed = await linkState();
    check('trimming one linked clip trims the other by the same amount',
      trimmed.lower === `${nudge}+${linkSetup.length - 20}` && trimmed.upper === trimmed.lower,
      `${trimmed.lower} / ${trimmed.upper}`);

    // Alt+click works on one half of the pair without breaking the link.
    await window.keyboard.down('Alt');
    await window.mouse.click(linkX(nudge + half), linkY(linkSetup.upperRow));
    await window.keyboard.up('Alt');
    await window.waitForTimeout(120);
    const isolated = await linkState();
    check('Alt+click holds just the one clip, and the link survives',
      isolated.selected === 1 && isolated.linked, JSON.stringify(isolated));

    await window.evaluate((ids) => window.__scfStore.getState().selectClips([ids.lowerId]), linkSetup);
    await window.keyboard.press('Control+Shift+l');
    await window.waitForTimeout(120);
    const unlinked = await linkState();
    check('Ctrl+Shift+L unlinks them again', !unlinked.linked, JSON.stringify(unlinked));

    await linkDrag(nudge + half, linkSetup.lowerRow, nudge + half + nudge);
    const apart = await linkState();
    check('once unlinked, one moves without the other',
      apart.lower !== apart.upper, `${apart.lower} / ${apart.upper}`);

    // Setup was six steps; linking, the drag, the trim, unlinking and the last
    // drag are five more.
    await window.getByTestId('project-name').click();
    for (let undoStep = 0; undoStep < 11; undoStep += 1) await window.keyboard.press('Control+z');
    const afterLinks = await window.evaluate(() => {
      const { project } = window.__scfStore.getState();
      return { clips: Object.keys(project.clips).length, tracks: project.tracks.length };
    });
    check('linking and unlinking are undo steps like any other',
      afterLinks.clips === beforeLinks.clips && afterLinks.tracks === beforeLinks.tracks,
      `${afterLinks.clips} clips on ${afterLinks.tracks} tracks, was ${beforeLinks.clips} on ${beforeLinks.tracks}`);

    /* Fades ------------------------------------------------------------------ */
    // A grip in each top corner, dragged inwards, as in Resolve. What matters
    // is the last check: the picture really comes up out of nothing.
    const fadeSetup = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const video = store.assets.find((asset) => asset.kind === 'video');
      store.addTrack('video');
      const state = window.__scfStore.getState();
      const track = state.project.tracks
        .filter((candidate) => candidate.type === 'video')
        .sort((a, b) => a.order - b.order)
        .slice(-1)[0];
      // Past everything else on the timeline, so the frames read here hold
      // this clip and nothing else.
      const id = window.__scfStore.getState().addAssetToTimeline(video, track.id, 1000);
      window.__scfStore.getState().trimClip(id, 'end', 1060);
      window.__scfStore.getState().setUi({ pixelsPerFrame: 4, scrollLeftPx: 0, tool: 'select' });

      const rows = window.__scfStore.getState().project.tracks;
      const videos = rows.filter((t) => t.type === 'video').sort((a, b) => b.order - a.order);
      const rest = rows.filter((t) => t.type !== 'video').sort((a, b) => b.order - a.order);
      return { id, track: track.id, row: [...videos, ...rest].findIndex((t) => t.id === track.id) };
    });
    await window.waitForTimeout(300);

    const fadesOf = () => window.evaluate((ids) => {
      const clip = window.__scfStore.getState().project.clips[ids.id];
      return { in: clip.fadeInFrames ?? 0, out: clip.fadeOutFrames ?? 0 };
    }, fadeSetup);

    const fadeBox = await surface.boundingBox();
    const fadeRowTop = fadeBox.y + 24 + fadeSetup.row * 58;
    // The clip sits past the others, so the canvas is scrolled to it - and the
    // scroll that actually took effect is what the clicks are measured from,
    // because the view clamps it to the content it has.
    await window.evaluate(() => window.__scfStore.getState().setUi({ scrollLeftPx: 1000 * 4 - 80 }));
    await window.waitForTimeout(250);
    const fadeScroll = await window.evaluate(() => window.__scfStore.getState().ui.scrollLeftPx);
    const fadeX = (frame) => fadeBox.x + frame * 4 - fadeScroll;

    await window.mouse.move(fadeX(1000) + 1, fadeRowTop + 6);
    await window.mouse.down();
    await window.mouse.move(fadeX(1020), fadeRowTop + 6, { steps: 8 });
    await window.mouse.up();
    await window.waitForTimeout(250);
    const afterHead = await fadesOf();

    await window.mouse.move(fadeX(1060) - 1, fadeRowTop + 6);
    await window.mouse.down();
    await window.mouse.move(fadeX(1048), fadeRowTop + 6, { steps: 8 });
    await window.mouse.up();
    await window.waitForTimeout(250);
    const afterTail = await fadesOf();

    check('a grip in each top corner sets the fade it is dragged to',
      afterHead.in === 20 && afterTail.out === 12 && afterTail.in === 20,
      `head ${afterHead.in}, tail ${afterTail.out}`);

    // The picture: nothing at the first frame, half way up in the middle of
    // the fade, whole once it is over. Read from the alpha channel, because a
    // faded white clip is still white - at less opacity.
    const opacity = await window.evaluate(async (ids) => {
      const renderer = window.__scfRenderer();
      const project = window.__scfStore.getState().project;
      const clip = project.clips[ids.id];
      const mean = async (frame) => {
        const rgba = await renderer.renderExact(project, frame, false);
        let total = 0;
        for (let at = 3; at < rgba.length; at += 4) total += rgba[at];
        return Math.round(total / (rgba.length / 4));
      };
      await renderer.renderExact(project, clip.startFrame + 30, false);
      return {
        first: await mean(clip.startFrame),
        halfway: await mean(clip.startFrame + 10),
        middle: await mean(clip.startFrame + 30),
        last: await mean(clip.startFrame + clip.durationFrames - 1),
      };
    }, fadeSetup);

    // Read as a fraction of the clip's own full opacity: this project is
    // 320x720 and the clip is fitted inside it, so "fully opaque" covers about
    // a third of the frame, not all of it.
    check('the picture comes up out of nothing and goes back down to it',
      opacity.first === 0
      && opacity.middle > 40
      && Math.abs(opacity.halfway - opacity.middle / 2) <= opacity.middle * 0.08
      && opacity.last < opacity.middle * 0.15,
      JSON.stringify(opacity));

    // Two drags, two undo steps, and the track goes back.
    // One undo takes back the tail fade, the next takes back the head one.
    await window.getByTestId('project-name').click();
    await window.keyboard.press('Control+z');
    await window.waitForTimeout(200);
    const afterOneUndo = await fadesOf();
    await window.keyboard.press('Control+z');
    await window.waitForTimeout(200);
    const afterTwoUndos = await fadesOf();
    check('each fade is one undo step',
      afterOneUndo.out === 0 && afterOneUndo.in === 20 && afterTwoUndos.in === 0,
      `after one ${JSON.stringify(afterOneUndo)}, after two ${JSON.stringify(afterTwoUndos)}`);

    await window.evaluate((ids) => {
      const store = window.__scfStore.getState();
      store.removeClips([ids.id]);
      window.__scfStore.getState().removeTrack(ids.track);
      window.__scfStore.getState().setUi({ scrollLeftPx: 0 });
    }, fadeSetup);
    await window.waitForTimeout(200);

    /* The viewer: transform mode, full screen, and the magnet ---------------- */
    const viewerClip = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const video = store.assets.find((asset) => asset.kind === 'video');
      const track = store.project.tracks.find((candidate) => candidate.type === 'video');
      const id = store.addAssetToTimeline(video, track.id, 3000);
      const state = window.__scfStore.getState();
      state.setCurrentFrame(3010);
      state.selectClips([id]);
      // An earlier check turned the mode on to drag a grip; this one is about
      // what happens before anyone asks for it.
      state.setUi({ transformMode: false });
      // Half size, so there is room to push it about inside the frame.
      window.__scfStore.getState().setTransformAt(id, 3010, { scale: { x: 0.5, y: 0.5 } });
      return id;
    });
    await window.waitForTimeout(400);

    const handleCount = () => window.evaluate(() =>
      document.querySelectorAll('[data-testid^="viewport-handle-"]').length);

    const beforeTransform = await handleCount();
    await window.getByTestId('project-name').click();
    await window.keyboard.press('Shift+T');
    await window.waitForTimeout(300);
    const withTransform = await handleCount();
    check('the handles wait to be asked for, and Shift+T asks',
      beforeTransform === 0 && withTransform > 0,
      `selected alone ${beforeTransform}, after Shift+T ${withTransform}`);

    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await window.waitForTimeout(250);
    const withoutSelection = await handleCount();
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), viewerClip);
    await window.waitForTimeout(250);
    check('with nothing selected there is nothing to transform', withoutSelection === 0, `${withoutSelection} handles`);

    // Full screen: the viewer takes the window, Escape gives it back.
    const viewerSize = () => window.evaluate(() => {
      const box = document.querySelector('[data-testid="preview-panel"]').getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height) };
    });
    const docked = await viewerSize();
    await window.keyboard.press('Shift+F');
    await window.waitForTimeout(400);
    const full = await viewerSize();
    await window.keyboard.press('Escape');
    await window.waitForTimeout(400);
    const backAgain = await viewerSize();
    check('Shift+F fills the window with the picture, and Escape comes back',
      full.w > docked.w && full.h > docked.h && backAgain.w === docked.w,
      `${docked.w}x${docked.h} -> ${full.w}x${full.h} -> ${backAgain.w}x${backAgain.h}`);

    // The magnet: a drag that lands near the middle is taken to it exactly.
    const positionOf = () => window.evaluate((id) => {
      const keys = window.__scfStore.getState().project.clips[id].transform.position;
      return keys.length ? keys[keys.length - 1].value : { x: 0, y: 0 };
    }, viewerClip);

    const canvasBox = await window.locator('canvas').first().boundingBox();
    const middle = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };

    // Modest steps: this project is 320px wide, and a drag of 150 screen px
    // takes the picture out from under the pointer, so the grab that follows
    // lands on empty surface instead of on the clip.
    await window.mouse.move(middle.x, middle.y);
    await window.mouse.down();
    await window.mouse.move(middle.x + 40, middle.y + 26, { steps: 8 });
    await window.mouse.up();
    await window.waitForTimeout(200);
    const movedAway = await positionOf();

    await window.mouse.move(middle.x + 40, middle.y + 26);
    await window.mouse.down();
    await window.mouse.move(middle.x + 3, middle.y + 2, { steps: 10 });
    await window.waitForTimeout(150);
    const guidesShown = await window.evaluate(() =>
      document.querySelectorAll('[data-testid^="viewport-guide-"]').length);
    await window.mouse.up();
    await window.waitForTimeout(200);
    const snapped = await positionOf();
    const guidesGone = await window.evaluate(() =>
      document.querySelectorAll('[data-testid^="viewport-guide-"]').length);

    check('a drag that lands near the middle is taken to it exactly, with guides while it is held',
      Math.abs(movedAway.x) > 10 && snapped.x === 0 && snapped.y === 0 && guidesShown === 2 && guidesGone === 0,
      `moved to ${Math.round(movedAway.x)},${Math.round(movedAway.y)} then ${snapped.x},${snapped.y}; guides ${guidesShown} held, ${guidesGone} after`);

    // Alt is the way out of the magnet.
    await window.mouse.move(middle.x, middle.y);
    await window.mouse.down();
    await window.keyboard.down('Alt');
    await window.mouse.move(middle.x + 4, middle.y + 3, { steps: 6 });
    await window.mouse.up();
    await window.keyboard.up('Alt');
    await window.waitForTimeout(200);
    const exact = await positionOf();
    check('holding Alt gives the pixel under the pointer instead',
      exact.x !== 0 && exact.y !== 0, `${exact.x.toFixed(1)},${exact.y.toFixed(1)}`);

    // Leave the editor as the rest of the checks expect it.
    await window.keyboard.press('Shift+T');
    await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      store.removeClips([id]);
      store.setCurrentFrame(0);
    }, viewerClip);
    await window.waitForTimeout(200);

    /* Showing and hiding the panels ------------------------------------------ */
    // Final Cut hides the browser and the inspector from buttons in its
    // toolbar; so does the title bar here. The point of hiding one is the
    // room it gives back, so that is what is measured rather than the button
    // having been clicked.
    const previewWidth = () => window.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const preview = canvas?.closest('section');
      return preview ? Math.round(preview.getBoundingClientRect().width) : 0;
    });

    const widthWithMedia = await previewWidth();
    const mediaWidthBefore = Math.round((await window.getByTestId('media-panel').boundingBox()).width);
    await window.getByTestId('toggle-media').click();
    const mediaGone = await window.getByTestId('media-panel').count();
    const widthWithout = await previewWidth();
    check('hiding the media panel gives its room to the picture',
      mediaGone === 0 && widthWithout > widthWithMedia,
      `preview ${widthWithMedia} -> ${widthWithout} px, media panel ${mediaGone === 0 ? 'gone' : 'still there'}`);

    await window.getByTestId('toggle-media').click();
    const mediaBack = await window.getByTestId('media-panel').count();
    const mediaWidthAfter = Math.round((await window.getByTestId('media-panel').boundingBox()).width);
    check('showing it again puts it back at the width it had',
      mediaBack === 1 && Math.abs(mediaWidthAfter - mediaWidthBefore) <= 2,
      `${mediaWidthAfter} px, was ${mediaWidthBefore} px`);

    // The same toggle from the menu, View > Inspector, and back with Ctrl+4.
    await appMenu(window, 'View', 'Inspector');
    const inspectorGone = await window.getByTestId('inspector-panel').count();
    await window.keyboard.press('Control+4');
    await window.waitForTimeout(250);
    const inspectorBack = await window.getByTestId('inspector-panel').count();
    check('the inspector hides and comes back the same way',
      inspectorGone === 0 && inspectorBack === 1,
      `hidden ${inspectorGone === 0}, back ${inspectorBack === 1}`);

    /* Readable, reachable interface ----------------------------------------- */
    // Contrast measured on the running editor rather than on a palette: what
    // matters is the colour a line of text ends up on after everything behind
    // it is composited, which only the browser knows.
    const readContrast = async () => window.evaluate(() => {
      const parse = (value) => {
        const match = /^rgba?\(([^)]+)\)$/.exec((value || '').trim().toLowerCase());
        if (!match) return null;
        const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number.parseFloat);
        if (parts.length < 3 || parts.some(Number.isNaN)) return null;
        return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
      };
      const luminance = ([r, g, b]) => {
        const channel = (eight) => {
          const v = Math.min(255, Math.max(0, eight)) / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const over = (top, alpha, bottom) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));
      const ratio = (a, b) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };

      /** What is really behind an element, walking up through transparency. */
      const backgroundFor = (element) => {
        let node = element;
        let stack = [];
        while (node) {
          const colour = parse(getComputedStyle(node).backgroundColor);
          if (colour && colour.alpha > 0) {
            if (colour.alpha >= 0.999) {
              let result = colour.rgb;
              for (const { rgb, alpha } of stack.reverse()) result = over(rgb, alpha, result);
              return result;
            }
            stack.push(colour);
          }
          node = node.parentElement;
        }
        return [13, 15, 20]; // the page itself
      };

      const worst = [];
      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (Number.parseFloat(style.opacity) < 0.95) continue;
        // Only elements with their own visible words.
        const own = [...element.childNodes]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent.trim())
          .join('');
        if (own.length === 0) continue;
        const box = element.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        // A disabled control is allowed to look disabled; WCAG exempts it.
        if (element.closest('[disabled], [aria-disabled="true"]')) continue;

        const colour = parse(style.color);
        if (!colour) continue;
        const background = backgroundFor(element);
        const value = ratio(over(colour.rgb, colour.alpha, background), background);
        const size = Number.parseFloat(style.fontSize);
        const bold = Number.parseInt(style.fontWeight, 10) >= 700;
        // 1.4.3: 3:1 only for 24px, or 18.66px bold. Everything here is small.
        const needed = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        if (value < needed) {
          worst.push({
            text: own.slice(0, 40),
            colour: style.color,
            size: Math.round(size * 10) / 10,
            ratio: Math.round(value * 100) / 100,
            needed,
          });
        }
      }
      return worst;
    });

    const lowContrast = await readContrast();
    check('every line of text on screen reads at 4.5:1 or better',
      lowContrast.length === 0,
      lowContrast.length === 0
        ? 'measured on the running editor'
        : lowContrast.slice(0, 4).map((entry) => `"${entry.text}" ${entry.ratio}:1 (${entry.colour}, ${entry.size}px)`).join(' | '));

    // The keyboard: Tab has to leave a ring you can see. Pressed for real,
    // because the ring is :focus-visible - focusing by script shows nothing,
    // which is the point of that selector.
    await window.evaluate(() => document.body.focus());
    await window.keyboard.press('Tab');
    await window.waitForTimeout(150);
    const focusRing = await window.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return { found: false };
      const style = getComputedStyle(element);
      const rgb = /rgba?\(([^)]+)\)/.exec(style.outlineColor);
      return {
        found: true,
        on: element.getAttribute('data-testid') ?? element.getAttribute('aria-label') ?? element.tagName,
        width: Number.parseFloat(style.outlineWidth),
        style: style.outlineStyle,
        colour: style.outlineColor,
        // Against the darkest panel it could sit on, by the 3:1 of 1.4.11.
        ratio: rgb
          ? (() => {
              const channel = (eight) => {
                const v = Math.min(255, Math.max(0, eight)) / 255;
                return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
              };
              const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number.parseFloat);
              const lum = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
              const [hi, lo] = [lum(parts), lum([26, 31, 46])].sort((a, b) => b - a);
              return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
            })()
          : 0,
      };
    });
    check('tabbing leaves a ring at least 2px thick, visible against the panel',
      focusRing.found && focusRing.style !== 'none' && focusRing.width >= 2 && focusRing.ratio >= 3,
      JSON.stringify(focusRing));

    // "?" brings up the list of keys, and Escape puts it away.
    await window.getByTestId('project-name').click();
    await window.keyboard.press('?');
    await window.waitForTimeout(300);
    const shortcutsShown = await window.getByTestId('shortcuts-dialog').count();
    const shortcutLines = await window.evaluate(() =>
      document.querySelectorAll('[data-testid="shortcuts-dialog"] kbd').length);
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);
    const shortcutsGone = await window.getByTestId('shortcuts-dialog').count();
    // What the list claims for the tools, pressed one at a time. The other
    // claims - the marks, J/K/L, the trims, linking, speed - have checks of
    // their own further up; this is the part nothing else covers.
    const toolKeys = [['v', 'select'], ['c', 'razor'], ['h', 'hand'], ['t', 'trim'], ['v', 'select']];
    const toolResults = [];
    for (const [key, expected] of toolKeys) {
      await window.keyboard.press(key);
      await window.waitForTimeout(80);
      const tool = await window.evaluate(() => window.__scfStore.getState().ui.tool);
      toolResults.push(`${key}->${tool}${tool === expected ? '' : ` (wanted ${expected})`}`);
    }
    check('the tool keys the list promises really pick those tools',
      toolResults.every((entry) => !entry.includes('wanted')), toolResults.join(' '));

    check('"?" opens the keyboard shortcuts, Escape closes them',
      shortcutsShown === 1 && shortcutLines > 20 && shortcutsGone === 0,
      `open ${shortcutsShown}, ${shortcutLines} keys listed, closed ${shortcutsGone === 0}`);

    /* Clip speed ------------------------------------------------------------- */
    // Retiming, on a track of its own. The checks that matter are the two
    // about the picture: a retimed clip has to show the frame of footage the
    // sum says it shows, and a reversed one has to start at the end.
    const speedSetup = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const video = store.assets.find((asset) => asset.kind === 'video');
      store.addTrack('video');
      const state = window.__scfStore.getState();
      const track = state.project.tracks
        .filter((candidate) => candidate.type === 'video')
        .sort((a, b) => a.order - b.order)
        .slice(-1)[0];

      const length = 40;
      const first = window.__scfStore.getState().addAssetToTimeline(video, track.id, 0);
      window.__scfStore.getState().trimClip(first, 'end', length);
      const second = window.__scfStore.getState().addAssetToTimeline(video, track.id, length);
      window.__scfStore.getState().trimClip(second, 'end', length * 2);
      // A third clip of the same footage, parked further along, to compare
      // pictures against: it is trimmed into the film rather than retimed.
      const witness = window.__scfStore.getState().addAssetToTimeline(video, track.id, 400);
      window.__scfStore.getState().trimClip(witness, 'end', 400 + length);
      window.__scfStore.getState().setUi({ selectedClipIds: [first] });
      return { first, second, witness, track: track.id, length };
    });

    const speedShape = () => window.evaluate((ids) => Object.values(window.__scfStore.getState().project.clips)
      .filter((clip) => clip.trackId === ids.track)
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((clip) => `${clip.startFrame}+${clip.durationFrames}@${clip.sourceOffsetFrames}x${clip.speed ?? 1}${clip.reversed ? 'R' : ''}`), speedSetup);

    // Only the retimed clip's own track is visible while its picture is
    // measured: every other track lies under it at some of these frames, and
    // a composited frame would be comparing the whole timeline instead.
    const onlySpeedTrack = (visible) => window.evaluate(({ ids, on }) => {
      const store = window.__scfStore.getState();
      for (const track of store.project.tracks) {
        if (track.id !== ids.track) store.updateTrack(track.id, { visible: on });
      }
    }, { ids: speedSetup, on: visible });

    await window.getByTestId('project-name').click();
    await window.evaluate((ids) => window.__scfStore.getState().selectClips([ids.first]), speedSetup);
    await window.keyboard.press('Control+r');
    await window.waitForTimeout(400);
    const dialogOpen = await window.getByTestId('speed-dialog').count();
    await window.getByTestId('speed-percent').fill('200');
    await window.waitForTimeout(200);
    const durationShown = await window.getByTestId('speed-duration').inputValue();
    // The duration reads as a timecode, HH:MM:SS:FF, as Premiere's does.
    const halfLength = await window.evaluate((frames) => {
      const rate = Math.round(window.__scfStore.getState().project.fps);
      const pad = (n) => String(n).padStart(2, '0');
      const seconds = Math.floor(frames / rate);
      return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(frames % rate)}`;
    }, speedSetup.length / 2);
    check('Ctrl+R opens Speed/Duration, and the two numbers move together',
      dialogOpen === 1 && durationShown === halfLength,
      `dialog ${dialogOpen}, duration ${durationShown} (expected ${halfLength})`);

    await window.getByTestId('speed-apply').click();
    await window.waitForTimeout(400);
    const halved = await speedShape();
    check('200% halves the clip and moves what follows',
      halved[0] === `0+${speedSetup.length / 2}@0x2` && halved[1].startsWith(`${speedSetup.length / 2}+`),
      halved.join('  '));

    // The picture: frame 10 of a clip at 200% is frame 20 of the footage, and
    // the witness clip trimmed to frame 20 shows exactly that.
    await onlySpeedTrack(false);
    const sampled = await window.evaluate(async (ids) => {
      const renderer = window.__scfRenderer();
      const digest = async (bytes) => {
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      };

      const store = window.__scfStore.getState();
      // The witness shows footage frame 20 at its own first frame.
      store.updateClip(ids.witness, { sourceOffsetFrames: 20 });
      const project = window.__scfStore.getState().project;

      // Warm each one: the first exact render of a file lands before its seek.
      await renderer.renderExact(project, project.clips[ids.first].startFrame + 10, false);
      const retimed = await digest(await renderer.renderExact(project, project.clips[ids.first].startFrame + 10, false));
      await renderer.renderExact(project, project.clips[ids.witness].startFrame, false);
      const plain = await digest(await renderer.renderExact(project, project.clips[ids.witness].startFrame, false));
      return { retimed, plain };
    }, speedSetup);
    await onlySpeedTrack(true);
    check('a clip at 200% shows the frame of footage the sum says it does',
      sampled.retimed === sampled.plain,
      `${sampled.retimed.slice(0, 16)} vs ${sampled.plain.slice(0, 16)}`);

    // Reversed: the first frame on the timeline is the last frame of footage.
    await onlySpeedTrack(false);
    const backwards = await window.evaluate(async (ids) => {
      const store = window.__scfStore.getState();
      store.setClipSpeed(ids.first, { speed: 1, reversed: true, ripple: true });

      const renderer = window.__scfRenderer();
      const digest = async (bytes) => {
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      };

      const after = window.__scfStore.getState();
      const clip = after.project.clips[ids.first];
      const lastFootageFrame = clip.sourceOffsetFrames + Math.round(clip.durationFrames * (clip.speed ?? 1)) - 1;
      after.updateClip(ids.witness, { sourceOffsetFrames: lastFootageFrame });
      const project = window.__scfStore.getState().project;

      await renderer.renderExact(project, clip.startFrame, false);
      const reversedFirst = await digest(await renderer.renderExact(project, clip.startFrame, false));
      await renderer.renderExact(project, project.clips[ids.witness].startFrame, false);
      const lastOfFootage = await digest(await renderer.renderExact(project, project.clips[ids.witness].startFrame, false));
      return { reversedFirst, lastOfFootage, length: clip.durationFrames };
    }, speedSetup);
    await onlySpeedTrack(true);
    check('a reversed clip starts at the last frame of its footage',
      backwards.reversedFirst === backwards.lastOfFootage,
      `${backwards.reversedFirst.slice(0, 16)} vs ${backwards.lastOfFootage.slice(0, 16)}`);

    // Without the ripple, a clip that grows stops at its neighbour.
    const held = await window.evaluate((ids) => {
      const store = window.__scfStore.getState();
      store.setClipSpeed(ids.first, { speed: 0.25, reversed: false, ripple: false });
      const after = window.__scfStore.getState().project.clips;
      return {
        first: after[ids.first].durationFrames,
        nextStart: after[ids.second].startFrame,
      };
    }, speedSetup);
    check('with the ripple off, a slowed clip stops where its neighbour begins',
      held.first === held.nextStart, `${held.first} frames, neighbour at ${held.nextStart}`);

    // Four changes of speed, four undos, and the track is as it was.
    for (let step = 0; step < 6; step += 1) await window.keyboard.press('Control+z');
    await window.waitForTimeout(300);
    const speedClipsLeft = await window.evaluate((ids) => Object.values(window.__scfStore.getState().project.clips)
      .filter((clip) => clip.trackId === ids.track).length, speedSetup);
    check('every change of speed is one undo step', speedClipsLeft === 3, `${speedClipsLeft} clips left`);

    // Out of the way of the checks that count clips further down.
    await window.evaluate((ids) => {
      const store = window.__scfStore.getState();
      const clips = Object.values(store.project.clips).filter((clip) => clip.trackId === ids.track);
      store.removeClips(clips.map((clip) => clip.id));
      store.removeTrack(ids.track);
    }, speedSetup);
    await window.waitForTimeout(200);

    /* Proxies ---------------------------------------------------------------- */
    // Heavy footage is edited from a small stand-in and delivered from the
    // original. The check that matters is the last one: the same frame,
    // rendered the way an export renders it, is identical either way.
    const heavySource = join(workDir, 'uhd.mp4');
    if (!(await stat(heavySource).then(() => true, () => false))) {
      await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi',
        '-i', 'testsrc2=size=3840x2160:rate=30:duration=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '300', '-pix_fmt', 'yuv420p', heavySource]);
    }

    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, heavySource);
    const assetsBefore = await window.evaluate(() => window.__scfStore.getState().assets.length);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(
      (count) => window.__scfStore.getState().assets.length > count,
      assetsBefore,
      { timeout: 120_000 },
    );

    const heavyId = await window.evaluate(() => {
      const { assets } = window.__scfStore.getState();
      const heavy = assets.find((asset) => asset.name === 'uhd.mp4');
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video');
      store.addAssetToTimeline(heavy, track.id, 2000);
      return heavy.id;
    });

    const barShown = await window.getByTestId('proxy-bar').count();
    check('4K footage brings up the proxy strip', barShown === 1, `${barShown} strips`);

    await window.getByTestId('build-proxies').click();
    await window.waitForFunction(
      (id) => window.__scfStore.getState().assets.find((asset) => asset.id === id)?.proxyUri !== undefined,
      heavyId,
      { timeout: 300_000 },
    );

    const proxyShape = await window.evaluate(async (id) => {
      const asset = window.__scfStore.getState().assets.find((candidate) => candidate.id === id);
      const measure = (url) => new Promise((resolve) => {
        const video = document.createElement('video');
        video.addEventListener('loadedmetadata', () => resolve(`${video.videoWidth}x${video.videoHeight}`), { once: true });
        video.addEventListener('error', () => resolve('error'), { once: true });
        video.src = url;
      });
      return { original: await measure(asset.uri), proxy: await measure(asset.proxyUri) };
    }, heavyId);
    check('the proxy is a quarter-size copy of the 4K file',
      proxyShape.original === '3840x2160' && proxyShape.proxy === '960x540',
      `${proxyShape.original} -> ${proxyShape.proxy}`);

    const drawing = await window.evaluate((id) => {
      const renderer = window.__scfRenderer();
      const asset = window.__scfStore.getState().assets.find((candidate) => candidate.id === id);
      renderer.useProxies(true);
      const on = renderer.previewSourceFor(asset.uri);
      renderer.useProxies(false);
      const off = renderer.previewSourceFor(asset.uri);
      renderer.useProxies(true);
      return { usesProxy: on === asset.proxyUri, usesOriginal: off === asset.uri };
    }, heavyId);
    check('the preview draws the proxy, and the original when proxies are off',
      drawing.usesProxy && drawing.usesOriginal, JSON.stringify(drawing));

    const rendered = await window.evaluate(async (id) => {
      const renderer = window.__scfRenderer();
      const { project, assets } = window.__scfStore.getState();
      const asset = assets.find((candidate) => candidate.id === id);
      const clip = Object.values(project.clips).find((candidate) => candidate.sourceUri === asset.uri);
      const frame = clip.startFrame + 20;

      const digest = async (bytes) => {
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      };

      // One render to let the 4K decoder land on the frame: the first exact
      // render of a fresh file arrives before its seek does, proxies or no
      // proxies.
      renderer.useProxies(true);
      await renderer.renderExact(project, frame, false);
      const withProxies = await digest(await renderer.renderExact(project, frame, false));

      renderer.useProxies(false);
      const withoutProxies = await digest(await renderer.renderExact(project, frame, false));
      renderer.useProxies(true);
      return { withProxies, withoutProxies };
    }, heavyId);
    check('an export renders the same picture whether proxies are on or off',
      rendered.withProxies === rendered.withoutProxies,
      `${rendered.withProxies.slice(0, 16)} vs ${rendered.withoutProxies.slice(0, 16)}`);

    // Built once, found again: the next session does not re-encode the file.
    const foundAgain = await window.evaluate((path) => window.filmora.proxiesFind(path), heavySource);
    check('a proxy built once is found again rather than built twice',
      typeof foundAgain === 'string' && foundAgain.length > 0, String(foundAgain));

    // Out of the way of the checks that follow, which count clips.
    await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      const asset = store.assets.find((candidate) => candidate.id === id);
      const clip = Object.values(store.project.clips).find((candidate) => candidate.sourceUri === asset.uri);
      store.removeClips([clip.id]);
      store.removeAsset(id);
    }, heavyId);
    await window.waitForTimeout(200);

    /* Autosave, backups and recovery ---------------------------------------- */
    // The project has a file by now, so an automatic save writes back to it -
    // and keeps what was there as a copy. The timer's own decision is driven
    // here rather than waited out; it is the same function the timer calls.
    const beforeAutosave = await window.evaluate(() => ({
      clips: Object.keys(window.__scfStore.getState().project.clips).length,
      hook: Boolean(window.__scfAutosave),
    }));
    check('the editor has autosave running', beforeAutosave.hook, JSON.stringify(beforeAutosave));

    // Something to save that was not there at the last save.
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video');
      const video = store.assets.find((asset) => asset.kind === 'video');
      store.addAssetToTimeline(video, track.id, 4000);
    });
    await window.evaluate(async () => {
      window.__scfAutosave.due();
      await window.__scfAutosave.tick();
    });
    await window.waitForTimeout(600);
    const autosaved = await window.evaluate(() => ({
      status: document.body.innerText.match(/Autosaved[^\n]*/)?.[0] ?? '',
      dirty: document.querySelectorAll('[data-testid="unsaved-indicator"]').length,
    }));
    check('autosave writes the project back to its own file, and it is saved afterwards',
      /^Autosaved to ui-project\.scf at /.test(autosaved.status) && autosaved.dirty === 0,
      JSON.stringify(autosaved));

    const kept = await window.evaluate((path) => window.filmora.projectsBackups(path), projectPath);
    check('the save kept the previous version as a backup', kept.length >= 1,
      `${kept.length} copies, newest ${kept[0]?.savedAt ?? 'none'}`);

    // The backups are listed in Settings, and one can be put back on screen.
    await appMenu(window, 'File', /^Project settings/);
    await window.waitForTimeout(400);
    const listed = await window.getByTestId('backup-list').count();
    const intervalShown = await window.getByTestId('autosave-interval').inputValue().catch(() => 'none');
    check('Settings lists the earlier versions and the autosave interval',
      listed === 1 && intervalShown === '5', `list ${listed}, every ${intervalShown} min`);

    const clipsBeforeRestore = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    await window.getByRole('button', { name: 'Restore' }).first().click();
    await window.waitForTimeout(900);
    const restored = await window.evaluate(() => ({
      clips: Object.keys(window.__scfStore.getState().project.clips).length,
      dirty: document.querySelectorAll('[data-testid="unsaved-indicator"]').length,
    }));
    check('restoring an earlier version puts it on screen, unsaved, without touching the file',
      restored.clips === clipsBeforeRestore - 1 && restored.dirty === 1,
      `${restored.clips} clips (was ${clipsBeforeRestore}), unsaved ${restored.dirty === 1}`);

    // Back to where the rest of the checks expect the project to be.
    await window.keyboard.press('Control+z');
    await window.waitForTimeout(200);
    await window.keyboard.press('Control+s');
    await window.waitForTimeout(600);

    /* Unsaved changes ------------------------------------------------------ */
    // The export section leaves its dialog open, and its dimmed backdrop takes
    // the clicks meant for the toolbar.
    const exportStillOpen = window.getByRole('dialog', { name: 'Export' });
    if ((await exportStillOpen.count()) > 0) {
      await exportStillOpen.getByTitle('Close').click();
      await exportStillOpen.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    }

    await window.evaluate(() => window.__scfStore.getState().addTrack('video'));
    // Timed, not just awaited: this runs right after a full export, and how
    // long the header takes to catch up is worth seeing in the log.
    const dirtyAt = Date.now();
    let dirtyError = '';
    const markedDirty = await window.getByTestId('unsaved-indicator')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true, (error) => {
        dirtyError = String(error.message).split('\n').slice(0, 2).join(' ');
        return false;
      });
    const dirtyMs = Date.now() - dirtyAt;
    if (!markedDirty) await window.screenshot({ path: join(workDir, 'dirty-dot-failure.png') }).catch(() => undefined);
    check('an edit after saving shows the unsaved-changes dot', markedDirty,
      markedDirty ? `${dirtyMs} ms after the edit` : `${dirtyError} | ` + await window.evaluate(() => JSON.stringify({
        dots: document.querySelectorAll('[data-testid="unsaved-indicator"]').length,
        dotRects: [...document.querySelectorAll('[data-testid="unsaved-indicator"]')]
          .map((dot) => { const r = dot.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${r.width}x${r.height}`; }),
        roots: document.querySelectorAll('#root').length,
        tracks: Object.keys(window.__scfStore.getState().project.tracks).length,
        title: document.title,
        onHome: Boolean(document.querySelector('main[aria-label="Start screen"]')),
        header: document.querySelector('[data-testid="project-name"]')?.textContent ?? null,
      })).catch(() => 'could not read the page'));

    await window.getByRole('button', { name: 'Home', exact: true }).click();
    const prompt = window.getByRole('alertdialog');
    const asked = await prompt.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    await prompt.getByRole('button', { name: 'Cancel' }).click().catch(() => undefined);
    await prompt.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    const stayed = (await window.getByRole('main', { name: 'Start screen' }).count()) === 0
      && await window.getByTestId('unsaved-indicator').isVisible();
    check('going home with unsaved changes asks first, and Cancel stays in the editor with the change', asked && stayed);

    // Closing the window asks too - natively, from the main process.
    const closeAsk = await app.evaluate(async ({ dialog, BrowserWindow }) => {
      const asks = [];
      dialog.showMessageBox = async (_window, options) => {
        asks.push(options.message);
        return { response: 2 };
      };
      BrowserWindow.getAllWindows()[0].close();
      await new Promise((done) => setTimeout(done, 700));
      return { asks, windows: BrowserWindow.getAllWindows().length };
    });
    check('closing the window with unsaved changes asks, and Cancel keeps it open',
      closeAsk.asks.length === 1 && /Save changes to/.test(closeAsk.asks[0]) && closeAsk.windows === 1,
      JSON.stringify(closeAsk));
    // Don't save, for the close below.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
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
    await closeApp(app);
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
    // No close prompt in this session. The prompt itself is checked in the
    // first one; here the run ends holding recovered, unsaved work, and a
    // native dialog nobody answers leaves a window sitting on the desktop
    // with the whole run stuck behind it.
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  try {
    const window = await second.firstWindow();
    // No dialog this time: the start screen lists the project the first
    // session saved, with a picture of it, and one click reopens it.
    const recentCard = window.getByRole('button', { name: 'Open ui-project', exact: true });
    const listed = await recentCard.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    const thumbnailShown = await window.waitForFunction(() => [...document.querySelectorAll('main[aria-label="Start screen"] img')]
      .some((image) => image.src.startsWith('media') && image.complete && image.naturalWidth > 0), null, { timeout: 15_000 })
      .then(() => true, () => false);
    check('a new session starts on a list with the saved project and its thumbnail', listed && thumbnailShown,
      `listed ${listed}, thumbnail ${thumbnailShown}`);
    await recentCard.click();
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
      reopenedBins.count === 6 && reopenedBins.dayOne === 'Day 1',
      `${reopenedBins.count} bins; still-a.png in ${reopenedBins.dayOne}`);

    const reopenedMediaWidth = Math.round(
      (await window.getByTestId('media-panel').boundingBox()).width,
    );
    const reopenedTitle = await second.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    check('the window is titled after the open project', reopenedTitle === 'ui-project - STOOK CREATOR FILMS', reopenedTitle);

    // Work that was never saved: written by the running app the way the timer
    // writes it, then offered back here after the window closed.
    await window.evaluate(async () => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video');
      const video = store.assets.find((asset) => asset.kind === 'video');
      store.addAssetToTimeline(video, track.id, 6000);
      await window.filmora.projectsRecoveryWrite({
        name: 'left behind',
        path: null,
        contents: JSON.stringify(window.__scfStore.getState().toDocument()),
      });
    });
    const snapshotClips = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    // The snapshot has the extra clip; the project on screen goes back to what
    // the file holds, so leaving for the start screen asks nothing.
    await window.keyboard.press('Control+z');
    await window.waitForTimeout(300);

    await window.getByRole('button', { name: 'Home' }).click();
    await window.waitForTimeout(700);
    const offered = await window.getByTestId('recovery-card').count();
    check('unsaved work is offered back on the start screen', offered === 1, `${offered} cards`);

    await window.getByRole('button', { name: 'Recover' }).click();
    await window.waitForTimeout(1500);
    const recovered = await window.evaluate(() => {
      const { assets, project } = window.__scfStore.getState();
      return {
        clips: Object.keys(project.clips).length,
        missing: assets.filter((asset) => asset.missing).length,
        dirty: document.querySelectorAll('[data-testid="unsaved-indicator"]').length,
      };
    });
    check('recovered work comes back whole, with its media, and still unsaved',
      recovered.clips === snapshotClips && recovered.missing === 0 && recovered.dirty === 1,
      JSON.stringify(recovered));

    check('panel sizes are remembered in a new session',
      persistedMediaWidth !== null && Math.abs(reopenedMediaWidth - persistedMediaWidth) <= 2,
      `media panel ${reopenedMediaWidth} px (left at ${persistedMediaWidth})`);
  } finally {
    await closeApp(second);
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
