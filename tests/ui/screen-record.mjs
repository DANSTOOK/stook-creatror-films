import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Screen recording, in the running app: `node tests/ui/screen-record.mjs`
 *
 * With Chromium's stand-in camera and microphone, and the real desktop:
 *   1. "Record the screen…" in the library's + menu lists the screens (each
 *      with its picture) and the windows;
 *   2. with the microphone and the webcam on, about three seconds are
 *      recorded, then stopped the way Ctrl+Shift+F9 stops it from another app;
 *   3. the screen goes on a track at the playhead as an MP4 at 30 fps, with
 *      the microphone's sound; the webcam on a track above it, a quarter of
 *      the frame, in the bottom-right corner - both real pictures, not black;
 *      one undo takes both off.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'screen-record');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const probe = (path) => spawnSync(ffmpeg, ['-hide_banner', '-i', path], { encoding: 'utf8' }).stderr;
/** The mean brightness of the middle frame, 0..255. */
const brightness = (path) => {
  const pixels = execFileSync(ffmpeg, ['-v', 'error', '-ss', '1', '-i', path, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  let sum = 0;
  for (const value of pixels) sum += value;
  return sum / Math.max(1, pixels.length);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const app = await electron.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.evaluate(() => {
      window.__scfStore.getState().setProjectSettings({ width: 1280, height: 720, fps: 30 });
      window.__scfStore.getState().setCurrentFrame(15);
    });

    console.log('1. the sources');
    await window.getByTestId('media-add-menu').click();
    await window.getByRole('menuitem', { name: /Record the screen/ }).click();
    await window.getByTestId('capture-dialog').waitFor({ state: 'visible', timeout: 5_000 });
    await window.getByTestId('capture-source-screen').first().waitFor({ state: 'visible', timeout: 15_000 });
    const screens = await window.getByTestId('capture-source-screen').count();
    const pictured = await window.getByTestId('capture-source-screen').first().locator('img').evaluate((img) => img.src.startsWith('data:image/png') && img.naturalWidth > 0);
    check('it lists the screens, each with its picture', screens >= 1 && pictured, `${screens} screen(s)`);

    console.log('2. recording');
    await window.getByTestId('capture-camera').check();
    await window.getByTestId('capture-minimise').uncheck();
    await window.getByTestId('capture-record').click();
    await window.getByTestId('capture-stop').waitFor({ state: 'visible', timeout: 15_000 });
    await sleep(3000);
    // As Ctrl+Shift+F9 does, from the main process.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('capture:stop-pressed'));
    const done = await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 120_000 }).then(() => true).catch(() => false);
    await sleep(800);
    check('it records, and stops the way Ctrl+Shift+F9 stops it', done);

    console.log('3. on the timeline');
    const placed = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      return Object.values(s.project.clips).map((clip) => {
        const asset = s.assets.find((a) => a.uri === clip.sourceUri);
        const track = s.project.tracks.find((t) => t.id === clip.trackId);
        return { name: asset?.name, path: asset?.sourcePath, start: clip.startFrame, order: track?.order, type: track?.type, scale: clip.transform.scale[0]?.value.x ?? 1, position: clip.transform.position[0]?.value ?? { x: 0, y: 0 }, audio: asset?.hasAudio };
      });
    });
    const screen = placed.find((clip) => /Screen recording/.test(clip.name ?? '') && clip.type === 'video');
    const camera = placed.find((clip) => /Webcam/.test(clip.name ?? ''));
    const screenInfo = screen ? probe(screen.path) : '';
    check('the screen goes at the playhead as an MP4 at 30 fps with the microphone’s sound',
      Boolean(screen) && screen.start === 15 && /Video: h264/.test(screenInfo) && /30 fps/.test(screenInfo) && /Audio: aac/.test(screenInfo),
      `${screen?.name}; ${(screenInfo.match(/Stream[^\n]*/g) ?? []).join(' | ')}`);
    check('the webcam on a track above it, a quarter of the frame, in the bottom-right corner',
      Boolean(camera && screen) && camera.order > screen.order && Math.abs(camera.scale - 0.25) < 0.01 && camera.position.x > 300 && camera.position.y > 150,
      JSON.stringify({ camera: camera && { scale: camera.scale, position: camera.position, order: camera.order }, screenOrder: screen?.order }));
    const lights = { screen: screen ? brightness(screen.path) : 0, camera: camera ? brightness(camera.path) : 0 };
    check('both are real pictures, not black', lights.screen > 3 && lights.camera > 3, JSON.stringify(lights));
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const left = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    check('one undo takes both off the timeline', left === 0, `${left} clips`);

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
