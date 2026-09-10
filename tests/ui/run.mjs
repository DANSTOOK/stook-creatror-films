import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
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

/** Frames the UI test asks the dialog to render. */
const EXPORT_FRAMES = 12;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push({ name, passed, detail });
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const run = (file, args) =>
  execFileAsync(file, args, { maxBuffer: 32 * 1024 * 1024 });

async function prepare() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

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

/** Read the stream summary ffmpeg prints for a file. */
async function probe(file) {
  try {
    await run(ffmpeg, ['-hide_banner', '-i', file]);
    return '';
  } catch (error) {
    return String(error.stderr ?? '');
  }
}

async function main() {
  console.log('1. preparing media and building the app');
  await prepare();
  await run(process.execPath, [
    join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build',
  ]);

  console.log('2. launching the real Electron app');
  const app = await electron.launch({
    args: [join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
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
    await assetRow.getByTitle('Add to timeline').click();

    // The inspector is the observable proof a clip exists and is selectable.
    await window.locator('canvas').last().click({ position: { x: 60, y: 80 } });
    const inspectorHasClip = await window.getByText('TRANSFORM').isVisible().catch(() => false);
    check('clip lands on the timeline and can be selected', inspectorHasClip);

    /* Export --------------------------------------------------------------- */
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
    }

    check('no console errors during the whole session', consoleIssues.length === 0,
      consoleIssues.length ? consoleIssues[0] : 'clean');
  } finally {
    await app.close().catch(() => undefined);
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
