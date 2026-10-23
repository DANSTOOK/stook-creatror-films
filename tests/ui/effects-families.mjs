import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The Effects panel's two families, the new effects and the previews, in the
 * running app: `node tests/ui/effects-families.mjs`
 *
 *   1. Camera and movement first, then Visual effects, each with its own
 *      heading and its own colour on every tile's badge; the drop-down picks a
 *      whole family or a group (Glitch holds its seven).
 *   2. Each of the fifteen new effects, put on a clip, changes the export's own
 *      picture; the ones that move by themselves differ from frame to frame.
 *   3. The camera shake moves the frame and never shows an edge.
 *   4. Pointed at, a moving effect's tile plays and a still one wipes between
 *      before and after; the transitions' tiles are two places, not letters.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'effects-families');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const NEW = ['vhs', 'blockGlitch', 'sliceGlitch', 'rgbSplit', 'staticNoise', 'crt', 'cameraShake', 'handheld', 'zoomPulse', 'posterize', 'duotone', 'mirror', 'fisheye', 'glow', 'flash'];
const MOVING = ['vhs', 'blockGlitch', 'sliceGlitch', 'rgbSplit', 'staticNoise', 'cameraShake', 'handheld', 'zoomPulse', 'flash'];

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'scene.mp4');
  // Detail everywhere, bright and dark, so every effect has something to change.
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);

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
      s.setProjectSettings({ width: 640, height: 360, fps: 30 });
      s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video').id, 0);
      return Object.keys(window.__scfStore.getState().project.clips)[0];
    });

    console.log('1. the two families');
    await window.getByTestId('library-tab-effects').click();
    await window.getByTestId('library-effects').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(800);
    const families = await window.evaluate(() => {
      const order = [...document.querySelectorAll('[data-testid^="library-effects-family-"]')].map((el) => el.getAttribute('data-testid').replace('library-effects-family-', ''));
      const familyOf = (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-family');
      const badge = (id) => getComputedStyle(document.querySelector(`[data-testid="${id}"] span[aria-hidden].absolute`)).backgroundColor;
      return {
        order,
        zoom: familyOf('library-motion-zoomIn'),
        shake: familyOf('library-effect-cameraShake'),
        anim: familyOf('library-anim-fadeIn') ?? familyOf(document.querySelector('[data-testid^="library-anim-"]')?.getAttribute('data-testid')),
        vhs: familyOf('library-effect-vhs'),
        sepia: familyOf('library-effect-sepia'),
        badges: [badge('library-motion-zoomIn'), badge('library-effect-sepia')],
      };
    });
    check('camera and movement first, then visual effects, each tile in its family, the badges in two colours',
      JSON.stringify(families.order) === '["camera","look"]' && families.zoom === 'camera' && families.shake === 'camera' && families.anim === 'camera' && families.vhs === 'look' && families.sepia === 'look' && families.badges[0] !== families.badges[1],
      JSON.stringify(families));
    const pick = async (id) => {
      await window.getByTestId('library-effects-filter-menu').click();
      await window.getByTestId(`library-effects-filter-${id}`).click();
      await sleep(300);
      return window.evaluate(() => [...document.querySelectorAll('[data-testid="library-effects"] li button')].map((b) => b.getAttribute('data-family')));
    };
    const camera = await pick('family:camera');
    const glitch = await pick('glitch');
    const glitchIds = await window.evaluate(() => [...document.querySelectorAll('[data-testid^="library-effect-"]')].map((b) => b.getAttribute('data-testid').replace('library-effect-', '')));
    await pick('all');
    check('the drop-down picks a whole family, or a group: Glitch holds its seven', camera.length === 29 && camera.every((f) => f === 'camera') && glitch.length === 7 && glitchIds.includes('vhs') && glitchIds.includes('glitch'),
      `${camera.length} camera tiles; glitch: ${glitchIds.join(', ')}`);

    console.log('2. the new effects in the export picture');
    // Each put on the clip as the panel puts it: a click on its tile, at its defaults.
    const renderTwo = () => window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      renderer.beginExclusive();
      try {
        const project = window.__scfStore.getState().project;
        const a = await renderer.renderExact(project, 15, false);
        const b = await renderer.renderExact(project, 27, false);
        return [Array.from(a.filter((_, i) => i % 16 < 3)), Array.from(b.filter((_, i) => i % 16 < 3))];
      } finally {
        renderer.endExclusive();
      }
    });
    const differ = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
    await window.evaluate((id) => { window.__scfStore.getState().updateClip(id, { effects: [] }); window.__scfStore.getState().selectClips([id]); }, clipId);
    const [plain] = await renderTwo();
    const results = {};
    for (const type of NEW) {
      await window.evaluate((id) => { window.__scfStore.getState().updateClip(id, { effects: [] }); window.__scfStore.getState().selectClips([id]); }, clipId);
      await window.getByTestId(`library-effect-${type}`).scrollIntoViewIfNeeded();
      await window.getByTestId(`library-effect-${type}`).click();
      await sleep(150);
      const applied = await window.evaluate((id) => (window.__scfStore.getState().project.clips[id].effects ?? []).map((e) => e.type), clipId);
      const [a, b] = await renderTwo();
      results[type] = { applied: applied.includes(type), change: +differ(plain, a).toFixed(1), moves: +differ(a, b).toFixed(1) };
    }
    await window.evaluate((id) => window.__scfStore.getState().updateClip(id, { effects: [] }), clipId);
    const unchanged = NEW.filter((type) => !(results[type]?.applied && results[type]?.change > 2));
    check('each of the fifteen new effects changes the export’s picture', unchanged.length === 0, unchanged.length ? `unchanged: ${unchanged.join(', ')}` : JSON.stringify(results));
    const still = MOVING.filter((type) => !(results[type]?.moves > 0.5));
    check('the ones that move by themselves differ from frame to frame', still.length === 0, still.length ? `still: ${still.join(', ')}` : MOVING.map((type) => `${type} ${results[type].moves}`).join(', '));

    console.log('3. the camera shake keeps the frame filled');
    const edges = await window.evaluate(async (id) => {
      const renderer = window.__scfRenderer();
      const store = window.__scfStore;
      store.getState().updateClip(id, { effects: [{ id: 'shake', type: 'cameraShake', enabled: true, params: { intensity: 60, speed: 12, rotation: 4 } }] });
      renderer.beginExclusive();
      try {
        const { width, height } = store.getState().project;
        let worst = 255;
        for (const frame of [3, 9, 17, 25, 33, 41, 57, 73]) {
          const rgba = await renderer.renderExact(store.getState().project, frame, false);
          for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [width / 2, 0], [0, height / 2]]) {
            worst = Math.min(worst, rgba[(Math.floor(y) * width + Math.floor(x)) * 4 + 3]);
          }
        }
        return worst;
      } finally {
        renderer.endExclusive();
        store.getState().updateClip(id, { effects: [] });
      }
    }, clipId);
    check('shaking hard (60 px, 4°), no frame shows an edge: every corner and edge stays opaque', edges === 255, `lowest alpha ${edges}`);

    console.log('4. the previews');
    const tileChanges = async (testId) => {
      const tile = window.getByTestId(testId);
      await tile.scrollIntoViewIfNeeded();
      const grab = () => tile.locator('canvas').evaluate((canvas) => canvas.toDataURL());
      await window.mouse.move(5, 5);
      await sleep(400);
      const before = await grab();
      await tile.hover();
      await sleep(500);
      const a = await grab();
      await sleep(450);
      const b = await grab();
      await window.mouse.move(5, 5);
      return { plays: a !== before && b !== a };
    };
    const vhs = await tileChanges('library-effect-vhs');
    const sepia = await tileChanges('library-effect-sepia');
    check('pointed at, a moving effect plays and a still one wipes between before and after', vhs.plays && sepia.plays, JSON.stringify({ vhs, sepia }));
    await window.getByTestId('library-tab-transitions').click();
    await sleep(1200);
    // Cross dissolve at rest is half one place, half the other: warm and bright mixed with dark and cool,
    // with detail (stars, windows, trees), not two flat gradients with a letter.
    const tile = await window.getByTestId('library-transition-crossDissolve').locator('canvas').evaluate((canvas) => {
      const context = canvas.getContext('2d');
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const colours = new Set();
      for (let i = 0; i < data.length; i += 4) colours.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
      return colours.size;
    });
    // Two diagonal gradients with a letter vary along one line: a few hundred colours at most.
    check('the transitions’ tiles are two places, full of detail', tile > 600, `${tile} distinct colours`);

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
