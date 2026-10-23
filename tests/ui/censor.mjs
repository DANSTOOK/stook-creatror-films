import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Blurring or pixelating a thing that moves, in the running app:
 * `node tests/ui/censor.mjs`
 *
 * A detailed square (a test pattern) sliding right and bobbing over grey:
 *   1. "Blur or pixelate an area" from the Effects panel goes on the clip,
 *      with a way to follow what it hides;
 *   2. put over the square, it blurs it - the detail inside all but gone -
 *      and leaves the grey around it as it was; switched to pixelate, the
 *      inside turns to flat blocks;
 *   3. a box drawn round the square in the viewer, and Follow: three seconds
 *      later the area is where the square went (within a few pixels), and the
 *      export's picture there is hidden.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'censor');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Where the square's centre is at `seconds`, in project pixels (the overlay below). */
const squareAt = (seconds) => ({ x: 260 + 150 * seconds, y: 360 + 100 * Math.sin(2 * seconds) });

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
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    window.on('console', (message) => { if (message.type() === 'error') issues.push(`console ${message.text().slice(0, 200)}`); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      const id = s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video').id, 0);
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().setCurrentFrame(0);
      return id;
    });
    await sleep(500);

    /** Detail (the spread of grey levels) inside a box of the export's picture at `frame`, and the mean outside it. */
    const look = (frame, box) => window.evaluate(async ([at, area]) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, at, false);
        const grey = (x, y) => {
          const i = (Math.round(y) * project.width + Math.round(x)) * 4;
          return (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
        };
        let steps = 0;
        let same = 0;
        let detail = 0;
        for (let y = area.y - 40; y < area.y + 40; y += 2) {
          for (let x = area.x - 40; x < area.x + 40; x += 2) {
            const value = grey(x, y);
            steps += 1;
            if (Math.abs(value - grey(x + 1, y)) < 1) same += 1;
            detail += Math.abs(value - grey(x + 2, y)) + Math.abs(value - grey(x, y + 2));
          }
        }
        return { spread: +(detail / steps).toFixed(1), flat: +(same / steps).toFixed(2), outside: Math.round(grey(1100, 100)) };
      } finally {
        renderer.endExclusive();
      }
    }, [frame, box]);
    const start = squareAt(0);
    const plain = await look(0, start);

    console.log('1. the effect');
    await window.getByTestId('library-tab-effects').click();
    await window.getByTestId('library-effect-censor').scrollIntoViewIfNeeded();
    await window.getByTestId('library-effect-censor').click();
    await sleep(500);
    const on = await window.evaluate((id) => (window.__scfStore.getState().project.clips[id].effects ?? []).map((e) => e.type), clipId);
    const offersFollow = await window.getByTestId('censor-follow-mark').isVisible().catch(() => false);
    check('"Blur or pixelate an area" goes on the clip, with a way to follow what it hides', on.includes('censor') && offersFollow, JSON.stringify(on));

    console.log('2. blurred, then pixelated');
    const setArea = (patch) => window.evaluate(([id, change]) => {
      const s = window.__scfStore.getState();
      const clip = s.project.clips[id];
      s.updateClip(id, { effects: clip.effects.map((e) => (e.type === 'censor' ? { ...e, params: { ...e.params, ...change } } : e)) });
    }, [clipId, patch]);
    await setArea({ centerX: start.x / 1280, centerY: start.y / 720, width: 150 / 1280, height: 150 / 720, round: 0, pixelate: 0 });
    const blurred = await look(0, start);
    check('over the square, it blurs it - the fine detail inside all but gone - and leaves the grey around it', blurred.spread < plain.spread * 0.35 && blurred.outside === plain.outside,
      JSON.stringify({ plain, blurred }));
    await setArea({ pixelate: 1, amount: 24 });
    const blocks = await look(0, start);
    check('switched to pixelate, the inside turns to flat blocks', blocks.flat > 0.85 && plain.flat < 0.7, JSON.stringify({ plain: plain.flat, pixelated: blocks.flat }));
    await setArea({ pixelate: 0 });

    console.log('3. following it');
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(0));
    await sleep(300);
    await window.getByTestId('censor-follow-mark').click();
    const overlay = window.getByTestId('track-box-overlay');
    await overlay.waitFor({ state: 'visible', timeout: 5_000 });
    // The box starts as the area - already round the square.
    await window.getByTestId('censor-follow-run').click();
    const followed = await window.waitForFunction((id) => {
      const effect = window.__scfStore.getState().project.clips[id].effects.find((e) => e.type === 'censor');
      return (effect.keyframes?.centerX?.length ?? 0) > 2;
    }, clipId, { timeout: 120_000 }).then(() => true).catch(() => false);
    const later = squareAt(3);
    const where = await window.evaluate(([id, frame]) => {
      const effect = window.__scfStore.getState().project.clips[id].effects.find((e) => e.type === 'censor');
      const at = (keys) => {
        const sorted = [...keys].sort((m, n) => m.frame - n.frame);
        if (frame <= sorted[0].frame) return sorted[0].value;
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i].frame >= frame) {
            const p = sorted[i - 1];
            const q = sorted[i];
            return p.value + ((q.value - p.value) * (frame - p.frame)) / (q.frame - p.frame);
          }
        }
        return sorted[sorted.length - 1].value;
      };
      return { x: at(effect.keyframes.centerX) * 1280, y: at(effect.keyframes.centerY) * 720 };
    }, [clipId, 90]);
    check('three seconds later the area is where the square went, within a few pixels', followed && Math.abs(where.x - later.x) < 10 && Math.abs(where.y - later.y) < 10,
      JSON.stringify({ area: { x: Math.round(where.x), y: Math.round(where.y) }, square: { x: Math.round(later.x), y: Math.round(later.y) } }));
    const plainLater = await window.evaluate((id) => {
      const s = window.__scfStore.getState();
      const clip = s.project.clips[id];
      window.__kept = clip.effects;
      s.updateClip(id, { effects: [] });
    }, clipId).then(() => look(90, later));
    await window.evaluate((id) => window.__scfStore.getState().updateClip(id, { effects: window.__kept }), clipId);
    const hiddenLater = await look(90, later);
    check('the export’s picture there is hidden', hiddenLater.spread < plainLater.spread * 0.35, JSON.stringify({ plain: plainLater.spread, hidden: hiddenLater.spread }));

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
