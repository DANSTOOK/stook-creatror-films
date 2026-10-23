import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Stabilize, in the running app: `node tests/ui/stabilize.mjs`
 *
 * A still, detailed scene filmed by a shaking hand (a crop that jumps a few
 * pixels every frame), with a tone:
 *   1. the inspector's Video tab offers Stabilize; Medium shows its progress
 *      and then the file is stabilized;
 *   2. in the export's own picture, the frame-to-frame jump falls to under
 *      half of what it was - steadied, not just softened - and the sound is
 *      still there;
 *   3. the original file is untouched, the stabilized one kept in the app's
 *      folder; Off brings the shake back.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'stabilize');
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
  const shaky = join(work, 'shaky.mp4');
  // A detailed still seen through a crop that shakes: a hand that cannot keep still.
  const still = join(work, 'still.png');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=800x450', '-frames:v', '1', still]);
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-loop', '1', '-framerate', '30', '-t', '5', '-i', still,
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=5',
    '-vf', 'crop=640:360:80+18*sin(n*1.9)+11*sin(n*4.3):45+14*cos(n*2.3)+9*sin(n*5.1)',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', shaky,
  ]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);
  const before = execFileSync(ffmpeg, ['-v', 'error', '-i', shaky, '-f', 'md5', '-']).toString().trim();

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [shaky]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 640, height: 360, fps: 30 });
      const id = s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video').id, 0);
      window.__scfStore.getState().selectClips([id]);
    });
    await sleep(800);

    /** The mean jump from frame to frame, in the export's picture (grey levels, 0..255), over a second. */
    const jump = () => window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        let previous = null;
        let total = 0;
        let count = 0;
        // Away from the edges, where a zoom-in crops.
        for (let frame = 40; frame < 70; frame += 1) {
          const rgba = await renderer.renderExact(project, frame, false);
          const grey = [];
          for (let y = 60; y < 300; y += 4) for (let x = 100; x < 540; x += 4) {
            const at = (y * project.width + x) * 4;
            grey.push((rgba[at] + rgba[at + 1] + rgba[at + 2]) / 3);
          }
          if (previous) {
            total += grey.reduce((sum, value, i) => sum + Math.abs(value - previous[i]), 0) / grey.length;
            count += 1;
          }
          previous = grey;
        }
        return +(total / count).toFixed(2);
      } finally {
        renderer.endExclusive();
      }
    });
    const shake = await jump();

    console.log('1. stabilizing');
    const offered = await window.getByTestId('inspector-stabilize').isVisible().catch(() => false);
    check('the inspector’s Video tab offers Stabilize', offered);
    await window.getByTestId('inspector-stabilize-medium').click();
    const showedProgress = await window.getByTestId('inspector-stabilize-progress').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const done = await window.waitForFunction(() => window.__scfStore.getState().assets[0].stabilize === 'medium', null, { timeout: 240_000 }).then(() => true).catch(() => false);
    await sleep(1500);
    check('Medium shows its progress, then the file is stabilized', showedProgress && done);

    console.log('2. the picture');
    const steady = await jump();
    check('in the export’s picture the frame-to-frame jump falls to under half', steady < shake * 0.5, `${shake} → ${steady}`);
    const stableFolder = join(profile, 'scf', 'stable');
    const made = existsSync(stableFolder) ? readdirSync(stableFolder).filter((name) => name.endsWith('.mp4')) : [];
    const sound = made[0] ? execFileSync(ffmpeg, ['-hide_banner', '-i', join(stableFolder, made[0]), '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() : '';
    const probe = made[0] ? (() => { try { execFileSync(ffmpeg, ['-hide_banner', '-i', join(stableFolder, made[0])], { stdio: ['ignore', 'pipe', 'pipe'] }); return ''; } catch (error) { return String(error.stderr ?? ''); } })() : '';
    void sound;
    check('the stabilized file keeps the sound', /Audio: aac/.test(probe), (probe.match(/Stream[^\n]*/g) ?? []).join(' | '));

    console.log('3. the original, and Off');
    const after = execFileSync(ffmpeg, ['-v', 'error', '-i', shaky, '-f', 'md5', '-']).toString().trim();
    check('the original is untouched, the stabilized one kept in the app’s folder', before === after && made.length === 1, `${made.length} kept`);
    await window.getByTestId('inspector-stabilize-off').click();
    await window.waitForFunction(() => !window.__scfStore.getState().assets[0].stabilize, null, { timeout: 30_000 }).catch(() => undefined);
    await sleep(1500);
    const back = await jump();
    check('Off brings the original back', Math.abs(back - shake) < shake * 0.15, `${shake} → ${back}`);

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
