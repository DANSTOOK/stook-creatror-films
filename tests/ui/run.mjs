import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
const projectPath = join(workDir, 'ui-project.fep');

// Two seconds, so the export crosses a change of testsrc's seconds counter: a
// picture from the wrong moment is then unmistakable.
const EXPORT_FRAMES = 60;

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
    ['-v', 'error', '-i', file, '-frames:v', String(frames), '-vf', 'scale=160:120',
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
  ? join(projectRoot, 'release/win-unpacked/Filmora Engine.exe')
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
      ? { executablePath: packagedExe }
      : { args: [join(projectRoot, 'dist-electron/main/index.js')] }),
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
          const local = /^(file|blob|data|devtools|chrome|chrome-extension):/i.test(details.url);
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
      BrowserWindow.getAllWindows()[0]?.getTitle())) === 'Filmora Engine');

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
    await window.locator('canvas').last().click({ position: { x: 60, y: 80 } });
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

    // Onto the timeline, on the second track, well past the export range so the
    // frame-accuracy check below still compares the source video alone.
    await dropFiles(
      [timelineDropImage],
      'timeline',
      { x: 1100, y: 24 + 58 + 20 },
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

    /* LUT survives save and reopen ------------------------------------------- */
    await surface.click({ position: { x: 60, y: 80 } });
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
    await surface.click({ position: { x: 60, y: 80 } });
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

    /* Export --------------------------------------------------------------- */
    // Restore the export path stub, which the project dialogs overwrote.
    await app.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
    }, exportPath);

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


    await dialog.getByLabel('Start frame').fill('0');
    await dialog.getByLabel('End frame').fill(String(EXPORT_FRAMES));

    check('export range fields accept input',
      (await dialog.getByLabel('End frame').inputValue()) === String(EXPORT_FRAMES));

    await dialog.getByRole('button', { name: 'Browse' }).click();
    await window.waitForTimeout(500);

    await dialog.getByRole('button', { name: 'Start export' }).click();
    await window.getByText('Export finished', { exact: false })
      .waitFor({ state: 'visible', timeout: 180_000 });
    check('export completes through the dialog', true);

    /* The file itself ------------------------------------------------------- */
    const info = await stat(exportPath).catch(() => null);
    check('export produced a file', info !== null && info.size > 1000,
      info ? `${info.size} bytes` : 'missing');

    if (info) {
      const summary = await probe(exportPath);
      check('exported file has a video stream', /Video: h264/.test(summary));
      check('exported file has an audio stream', /Audio: aac/.test(summary));

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
      ? { executablePath: packagedExe }
      : { args: [join(projectRoot, 'dist-electron/main/index.js')] }),
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
