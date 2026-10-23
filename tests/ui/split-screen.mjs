import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Split screen and picture-in-picture, in the running app:
 * `node tests/ui/split-screen.mjs`
 *
 * Four colours, one after another on one track - red, green, blue, yellow,
 * the yellow one a 4:3 picture:
 *   1. with all four selected, the clip's menu offers Split screen ▸ Grid of
 *      four; it puts them all at the first one's start, each on a track of
 *      its own, as one undo step;
 *   2. the export's own picture: red top-left, green top-right, blue bottom-
 *      left, yellow bottom-right - every cell filled to its edges, the 4:3
 *      picture not stretched (it covers its cell), a thin line between;
 *   3. undo puts them back as they were;
 *   4. two of them as picture in picture: the second in the bottom-right
 *      corner, above the first, which fills the frame.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'split-screen');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const colourVideo = (path, colour, size) =>
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:r=30:d=3`, '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const files = [
    ['red', '0xe02020', '640x360'],
    ['green', '0x20c040', '640x360'],
    ['blue', '0x2040e0', '640x360'],
    ['yellow', '0xe0d020', '480x360'],
  ].map(([name, colour, size]) => {
    const path = join(work, `${name}.mp4`);
    colourVideo(path, colour, size);
    return path;
  });

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
    await app.evaluate(({ dialog }, list) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list }); }, files);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 4, null, { timeout: 60_000 });
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 640, height: 360, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      const out = {};
      let at = 0;
      for (const name of ['red', 'green', 'blue', 'yellow']) {
        const asset = window.__scfStore.getState().assets.find((a) => a.name.startsWith(name));
        out[name] = window.__scfStore.getState().addAssetToTimeline(asset, track.id, at);
        at += 90;
      }
      window.__scfStore.getState().selectClips(Object.values(out));
      return out;
    });
    await sleep(600);
    const layoutOf = () => window.evaluate(() => {
      const s = window.__scfStore.getState();
      return Object.values(s.project.clips).map((c) => ({ id: c.id, start: c.startFrame, track: c.trackId, order: s.project.tracks.find((t) => t.id === c.trackId)?.order })).sort((a, b) => a.id.localeCompare(b.id));
    });
    const before = JSON.stringify(await layoutOf());

    const rightClick = async (clipId) => {
      const canvas = await window.locator('[data-panel="timeline"] canvas').first().boundingBox();
      const spot = await window.evaluate((id) => {
        const s = window.__scfStore.getState();
        const clip = s.project.clips[id];
        const rows = [...document.querySelectorAll('[data-panel="timeline"] .group.relative.flex')];
        const track = s.project.tracks.find((t) => t.id === clip.trackId);
        const box = rows[rows.findIndex((row) => (row.textContent ?? '').includes(track.name))].getBoundingClientRect();
        return { x: (clip.startFrame + 20) * s.ui.pixelsPerFrame - s.ui.scrollLeftPx, y: box.top + box.height / 2 };
      }, clipId);
      await window.mouse.click(canvas.x + spot.x, spot.y, { button: 'right' });
    };

    console.log('1. the grid');
    await rightClick(ids.red);
    const menu = window.getByRole('menuitem', { name: /Split screen/ });
    const offered = await menu.isVisible().catch(() => false);
    if (offered) await menu.hover();
    await sleep(300);
    const grid = window.getByRole('menuitem', { name: 'Grid of four' });
    const gridOffered = await grid.isVisible().catch(() => false);
    check('with four selected, Split screen ▸ Grid of four is offered', offered && gridOffered);
    const steps = await window.evaluate(() => window.__scfHistory?.getState?.().undoStack.length ?? null);
    if (gridOffered) await grid.click();
    await sleep(500);
    const placed = await layoutOf();
    const afterSteps = await window.evaluate(() => window.__scfHistory?.getState?.().undoStack.length ?? null);
    check('all four at the first one’s start, each on a track of its own, as one undo step',
      placed.every((c) => c.start === 0) && new Set(placed.map((c) => c.track)).size === 4 && (steps === null || afterSteps === steps + 1),
      JSON.stringify({ starts: placed.map((c) => c.start), tracks: new Set(placed.map((c) => c.track)).size, steps: `${steps} → ${afterSteps}` }));

    console.log('2. the picture');
    const sample = (points) => window.evaluate(async (list) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, 30, true);
        const name = ([r, g, b]) => (r > 150 && g > 150 && b < 100 ? 'yellow' : r > 150 && g < 100 ? 'red' : g > 120 && r < 100 && b < 120 ? 'green' : b > 150 && r < 100 ? 'blue' : r + g + b < 40 ? 'black' : `${r},${g},${b}`);
        return list.map(([x, y]) => name([...rgba.slice((y * project.width + x) * 4, (y * project.width + x) * 4 + 3)]));
      } finally {
        renderer.endExclusive();
      }
    }, points);
    // Cell centres, cell corners at the frame's edges, and the line between them.
    const seen = await sample([[160, 90], [480, 90], [160, 270], [480, 270], [1, 1], [638, 1], [1, 358], [638, 358], [320, 90], [160, 180]]);
    check('red top-left, green top-right, blue bottom-left, yellow bottom-right', JSON.stringify(seen.slice(0, 4)) === '["red","green","blue","yellow"]', JSON.stringify(seen.slice(0, 4)));
    check('each cell filled to the frame’s edges (the 4:3 picture covers its cell), a thin line between', JSON.stringify(seen.slice(4, 8)) === '["red","green","blue","yellow"]' && seen[8] === 'black' && seen[9] === 'black',
      JSON.stringify(seen.slice(4)));
    const yellow = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].transform.scale[0].value, ids.yellow);
    check('the 4:3 picture is not stretched: drawn at its own shape', Math.abs((yellow.x * 640) / (yellow.y * 360) - 4 / 3) < 0.01, JSON.stringify(yellow));

    console.log('3. undo');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const undone = JSON.stringify((await layoutOf()).map(({ order, ...rest }) => rest));
    check('one undo puts them back as they were', undone === JSON.stringify(JSON.parse(before).map(({ order, ...rest }) => rest)), undone);

    console.log('4. picture in picture');
    await window.evaluate((list) => window.__scfStore.getState().selectClips(list), [ids.red, ids.green]);
    await rightClick(ids.red);
    await window.getByRole('menuitem', { name: /Split screen/ }).hover();
    await sleep(300);
    await window.getByRole('menuitem', { name: 'Picture in picture' }).click();
    await sleep(500);
    const pip = await sample([[100, 100], [520, 290], [300, 180]]);
    const orders = await window.evaluate((list) => list.map((id) => {
      const s = window.__scfStore.getState();
      return s.project.tracks.find((t) => t.id === s.project.clips[id].trackId).order;
    }), [ids.red, ids.green]);
    check('the second in the bottom-right corner, above the first, which fills the frame', JSON.stringify(pip) === '["red","green","red"]' && orders[1] > orders[0], JSON.stringify({ pip, orders }));

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
