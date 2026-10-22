import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Following an object, in the running app: `node tests/ui/tracking.mjs`
 *
 * A clip of a test pattern square sliding right and bobbing over grey, with a
 * sticker over it:
 *   1. the sticker's Effects tab offers to follow the video under it;
 *   2. a box drawn round the square in the viewer, and Follow, gives the
 *      sticker a path that moves as the square did - within a few pixels -
 *      with its pop and its pulse still on, and the export draws it there;
 *   3. one undo takes the follow off, and Stop following does too.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tracking');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Where the square's centre is at `t` seconds, in pixels of the 1280x720 picture. */
const square = (t) => ({ x: 200 + 60 + 150 * t, y: 300 + 60 + 100 * Math.sin(2 * t) });

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'moving.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x606060:s=1280x720:r=30:d=4',
    '-f', 'lavfi', '-i', 'testsrc2=s=120x120:r=30:d=4',
    '-filter_complex', "[0:v][1:v]overlay=x='200+150*t':y='300+100*sin(2*t)'[v]",
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', video,
  ]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().setCurrentFrame(0);
    });
    await sleep(300);
    await window.getByTestId('library-tab-stickers').click();
    await window.getByTestId('library-sticker-heart').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 30_000 });
    const stickerId = await window.evaluate(() => window.__scfStore.getState().ui.selectedClipIds[0]);
    await sleep(400);

    console.log('1. the card');
    const card = window.getByTestId('clip-fx-follow');
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    const offers = await window.getByTestId('clip-fx-follow-mark').isVisible().catch(() => false);
    check('the sticker’s Effects tab offers to follow the video under it', offers);

    console.log('2. marking and following');
    await window.getByTestId('clip-fx-follow-mark').click();
    const overlay = window.getByTestId('track-box-overlay');
    await overlay.waitFor({ state: 'visible', timeout: 5_000 });
    const box = await overlay.boundingBox();
    const start = square(0);
    const px = (x, y) => ({ x: box.x + (x / 1280) * box.width, y: box.y + (y / 720) * box.height });
    const a = px(start.x - 58, start.y - 58);
    const b = px(start.x + 58, start.y + 58);
    // Drawn on the picture outside the box already there: a new one.
    await window.mouse.move(a.x, a.y);
    await window.mouse.down();
    await window.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await window.mouse.move(b.x, b.y, { steps: 4 });
    await window.mouse.up();
    const drawn = await window.getByTestId('track-box').boundingBox();
    check('a box drawn round the square in the viewer is the box marked',
      Math.abs(drawn.x + drawn.width / 2 - (a.x + b.x) / 2) < 4 && Math.abs(drawn.width - (b.x - a.x)) < 6,
      `${Math.round(drawn.width)}x${Math.round(drawn.height)}`);
    await window.screenshot({ path: join(work, 'marking.png') });
    await window.getByTestId('clip-fx-follow-run').click();
    const done = await window.waitForFunction((id) => Boolean(window.__scfStore.getState().project.clips[id]?.tracking), stickerId, { timeout: 60_000 }).then(() => true).catch(() => false);
    const result = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const keys = (clip.fx?.base ?? clip.transform).position;
      const at = (frame) => {
        if (keys.length === 0) return { x: 0, y: 0 };
        if (frame <= keys[0].frame) return keys[0].value;
        for (let i = 1; i < keys.length; i += 1) {
          if (frame <= keys[i].frame) {
            const k0 = keys[i - 1];
            const k1 = keys[i];
            const u = (frame - k0.frame) / (k1.frame - k0.frame);
            return { x: k0.value.x + (k1.value.x - k0.value.x) * u, y: k0.value.y + (k1.value.y - k0.value.y) * u };
          }
        }
        return keys.at(-1).value;
      };
      return {
        keys: keys.length,
        origin: keys[0]?.value ?? { x: 0, y: 0 },
        path: [0, 30, 60, 90, 110].map((f) => at(f)),
        fx: { in: clip.fx?.in?.id, loop: clip.fx?.loop?.id },
        overlay: Boolean(document.querySelector('[data-testid="track-box-overlay"]')),
        state: document.querySelector('[data-testid="clip-fx-follow-state"]')?.textContent ?? '',
      };
    }, stickerId);
    let worst = 0;
    [0, 30, 60, 90, 110].forEach((frame, i) => {
      const want = { x: square(frame / 30).x - start.x, y: square(frame / 30).y - start.y };
      const got = { x: result.path[i].x - result.path[0].x, y: result.path[i].y - result.path[0].y };
      worst = Math.max(worst, Math.hypot(want.x - got.x, want.y - got.y));
    });
    check('Follow gives the sticker a path that moves as the square did, within a few pixels', done && worst < 8, `worst ${worst.toFixed(1)} px, ${result.keys} keyframes`);
    check('it keeps its pop and its pulse, and the mark is put away',
      result.fx.in === 'popIn' && result.fx.loop === 'pulse' && !result.overlay && /frame 0/.test(result.state),
      JSON.stringify({ ...result.fx, overlay: result.overlay, state: result.state }));
    const heart = await window.evaluate(async (id) => {
      // The sticker's red, in the export's own picture, at 3 s - drawn alone, as the pattern under it has red of its own.
      const renderer = window.__scfRenderer();
      const whole = window.__scfStore.getState().project;
      const project = { ...whole, clips: { [id]: whole.clips[id] } };
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, 90, true);
        let sx = 0;
        let n = 0;
        for (let y = 0; y < project.height; y += 2) {
          for (let x = 0; x < project.width; x += 2) {
            const i = (y * project.width + x) * 4;
            if (rgba[i] > 190 && rgba[i + 1] < 90 && rgba[i + 2] < 120) {
              sx += x;
              n += 1;
            }
          }
        }
        return { n, cx: n ? sx / n : -1 };
      } finally {
        renderer.endExclusive();
      }
    }, stickerId);
    const expected = 640 + result.origin.x + square(3).x - start.x;
    check('in the export’s own picture the heart has gone right with the square', heart.n > 200 && Math.abs(heart.cx - expected) < 40, `heart at ${Math.round(heart.cx)}, expected about ${Math.round(expected)}`);

    console.log('3. taking it off');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const undone = await window.evaluate((id) => window.__scfStore.getState().project.clips[id]?.tracking, stickerId);
    check('one undo takes the follow off', undone === undefined);
    await window.evaluate(() => window.__scfStore.getState().redo());
    await sleep(300);
    await window.getByTestId('clip-fx-follow-remove').click();
    await sleep(200);
    const removed = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { tracking: clip.tracking, keys: (clip.fx?.base ?? clip.transform).position.length, loop: clip.fx?.loop?.id };
    }, stickerId);
    check('Stop following puts it back where it was, its pulse still on', removed.tracking === undefined && removed.keys <= 1 && removed.loop === 'pulse', JSON.stringify(removed));

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
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
