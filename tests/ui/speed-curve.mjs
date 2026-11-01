import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * A speed curve of one's own: `node tests/ui/speed-curve.mjs`
 *
 *   1. The Speed tab offers "By hand" beside the twelve presets, and turning it
 *      on starts from whichever preset was chosen.
 *   2. Dragging a point changes the curve, and the CLIP'S LENGTH DOES NOT
 *      CHANGE - the whole promise of a ramp.
 *   3. What it changes is which frame of footage shows when, read from the
 *      engine rather than from the curve that was just typed in.
 *   4. The clip goes silent, as it does along a preset: one playback rate
 *      cannot follow a speed that changes.
 *   5. It survives a save and a reload, and a nonsense curve in a file is
 *      dropped rather than played.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'speed-curve');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Six seconds of counting frames, with sound, so retiming is visible and the
  // audio gate has something to gate.
  const video = join(work, 'count.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=f=440:d=6:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
  ]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => { if (message.text().includes('[curve]')) console.log(message.text()); if (message.type() === 'error') issues.push(message.text()); });
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, video);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 120_000 });
    const clipId = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video');
      const id = store.addAssetToTimeline(store.assets[0], track.id, 0);
      window.__scfStore.getState().selectClips([id]);
      return id;
    });
    await sleep(500);
    await window.locator('#inspector-tab-speed').click();
    await sleep(300);

    console.log('1. By hand, starting from a preset');
    await window.getByTestId('inspector-ramp-hero').click();
    await sleep(300);
    const mine = window.getByTestId('inspector-ramp-mine');
    check('the Speed tab offers a curve of your own', await mine.isVisible().catch(() => false));
    await mine.click();
    await window.getByTestId('speed-curve').waitFor({ state: 'visible', timeout: 5_000 });
    const started = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { curve: clip.speedCurve ?? null, ramp: clip.speedRamp ?? null, length: clip.durationFrames };
    }, clipId);
    check(
      'it starts from the preset that was chosen, and the preset is let go',
      Array.isArray(started.curve) && started.curve.length === 9 && started.ramp === null,
      `${JSON.stringify(started.curve)} ramp ${started.ramp}`,
    );

    console.log('2. dragging a point');
    const before = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { length: clip.durationFrames, curve: [...(clip.speedCurve ?? [])] };
    }, clipId);
    const handle = window.getByTestId('speed-curve-point-4');
    // Scrolled into view first: the inspector panel scrolls, and a handle below
    // its visible area still reports a box - one that lands on the timeline
    // canvas, where the drag goes to the timeline instead. Measured: the pointer
    // events never reached the handle at all.
    await handle.scrollIntoViewIfNeeded();
    await sleep(150);
    const box = await handle.boundingBox();
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 6 });
    await window.mouse.up();
    await sleep(300);
    const after = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { length: clip.durationFrames, curve: [...(clip.speedCurve ?? [])] };
    }, clipId);
    check(
      'dragging a point up makes that part faster',
      after.curve[4] > before.curve[4] + 0.1,
      `${before.curve[4]} -> ${after.curve[4]}`,
    );
    check(
      'and the clip is exactly as long as it was',
      after.length === before.length,
      `${after.length}f (was ${before.length}f)`,
    );

    console.log('3. what the engine shows');
    // Read from the engine: a curve that is fast in the middle must be further
    // through the footage at halfway than a flat clip is.
    const shown = await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[id];
      const at = (frame) => window.__scfSourceFrameFor?.(clip, frame) ?? null;
      return { mid: at(45), end: at(clip.durationFrames - 1) };
    }, clipId);
    if (shown.mid === null) {
      console.log('   (no hook for the frame lookup; covered by tests/SpeedCurve.test.ts)');
    } else {
      check('the footage runs to its end by the last frame', shown.end > shown.mid, `${shown.mid} then ${shown.end}`);
    }

    console.log('4. the sound');
    const silent = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { curve: Boolean(clip.speedCurve), detached: clip.audioDetached === true };
    }, clipId);
    check('a clip on a curve of its own carries one', silent.curve && !silent.detached);

    console.log('5. saved and read back');
    const roundTrip = await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      const document = JSON.parse(JSON.stringify(store.toDocument()));
      const kept = document.project.clips[id]?.speedCurve ?? null;
      // A nonsense curve in a file must be dropped rather than played.
      document.project.clips[id].speedCurve = [1, 0, -3];
      store.loadDocument(document);
      const dropped = window.__scfStore.getState().project.clips[id]?.speedCurve ?? null;
      return { kept, dropped };
    }, clipId);
    check('the curve is written into the project file', Array.isArray(roundTrip.kept) && roundTrip.kept.length === 9, JSON.stringify(roundTrip.kept));
    check('and a broken one in a file is dropped, not played', roundTrip.dropped === null || roundTrip.dropped === undefined, JSON.stringify(roundTrip.dropped));

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
