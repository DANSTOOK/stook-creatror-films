import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Speed ramps, in the running app: `node tests/ui/speed-ramp.mjs`
 *
 * A three-second clip whose every frame is a grey of its own (frame n is
 * n x 2.5 out of 255), so the export's picture says which frame it shows:
 *   1. the Speed dialog draws each curve; Hero is chosen and applied;
 *   2. the clip keeps its length and its footage;
 *   3. in the export's own picture it starts on its first frame, ends near its
 *      last, and goes slow through the middle - far fewer frames of footage a
 *      frame of timeline there than at its start;
 *   4. one undo takes the ramp off.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'speed-ramp');
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
  const video = join(work, 'greys.mp4');
  // Full-range grey, n * 2.5 at frame n: 90 frames, 0 to 222.
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=3', '-vf', "geq=lum='N*2.5':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', video]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 320, height: 180, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().setUi({ selectedClipIds: [id] });
      return id;
    });
    await sleep(500);
    const before = await window.evaluate((id) => {
      const c = window.__scfStore.getState().project.clips[id];
      return { length: c.durationFrames, offset: c.sourceOffsetFrames };
    }, clipId);

    console.log('1. the dialog');
    await window.locator('[data-panel="timeline"] canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await window.evaluate((id) => window.__scfStore.getState().setUi({ selectedClipIds: [id] }), clipId);
    await window.keyboard.press('Control+r');
    await window.getByTestId('speed-dialog').waitFor({ state: 'visible', timeout: 5_000 });
    const curves = await window.getByTestId('speed-dialog').locator('[data-testid^="speed-ramp-"] svg polyline').count();
    await window.getByTestId('speed-ramp-hero').click();
    await window.getByTestId('speed-apply').click();
    await sleep(400);
    const after = await window.evaluate((id) => {
      const c = window.__scfStore.getState().project.clips[id];
      return { ramp: c.speedRamp, length: c.durationFrames, offset: c.sourceOffsetFrames };
    }, clipId);
    check('the dialog draws each curve; Hero is applied', curves === 13 && after.ramp === 'hero', `${curves} curves, ramp ${after.ramp}`);
    check('the clip keeps its length and its footage', after.length === before.length && after.offset === before.offset, JSON.stringify({ before, after }));

    console.log('2. in the export');
    const shown = await window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const frameAt = async (frame) => {
          const rgba = await renderer.renderExact(project, frame, true);
          const i = (90 * project.width + 160) * 4;
          return Math.round(rgba[i] / 2.5);
        };
        const out = {};
        for (const frame of [0, 10, 40, 50, 89]) out[frame] = await frameAt(frame);
        return out;
      } finally {
        renderer.endExclusive();
      }
    });
    const startStep = shown[10] - shown[0];
    const middleStep = shown[50] - shown[40];
    check('it starts on its first frame and ends near its last', shown[0] <= 1 && shown[89] >= 85, JSON.stringify(shown));
    check('slow through the middle: far fewer frames of footage a frame there than at the start', middleStep * 3 < startStep, `start ${startStep} frames in 10, middle ${middleStep} in 10`);

    console.log('3. undo');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const undone = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].speedRamp, clipId);
    check('one undo takes the ramp off', undone === undefined, String(undone));

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
