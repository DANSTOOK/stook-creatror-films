import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The keyframe editor, a window of its own: `node tests/ui/keyframes.mjs`
 *
 *   1. Shift+K opens it on the selected clip: the transform's rows and the
 *      blur's radius; with no clip, it says to select one;
 *   2. the stopwatch and the diamond put keyframes at the playhead; ◀ ▶ go
 *      from one to the next;
 *   3. a diamond dragged in time lands where it was dropped, as one undo step;
 *      a box picks several;
 *   4. the move's shape: Ease changes the picture the export draws (measured,
 *      a quarter of the way), Hold keeps the value to the next keyframe, and a
 *      handle dragged in the curve box makes a curve of one's own;
 *   5. Curves draws the values; a point dragged up changes the value;
 *   6. Delete removes the picked keyframes; Close closes the window;
 *   7. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The windows are never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'keyframes');
const logs = join(work, 'logs');
const shots = process.env.KEYFRAME_SHOTS ?? '';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(Boolean(passed));
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // A bright, flat picture: its opacity over the black frame is its brightness.
  const file = join(work, 'white.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=30', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [file]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const store = (fn, arg) => window.evaluate(fn, arg);

    /* 1. opening it --------------------------------------------------------------------------- */
    await window.locator('[data-testid="viewer-timecode"]').click();
    await window.keyboard.press('Shift+K');
    await window.waitForFunction(() => true, null, { timeout: 1000 });
    let editor = null;
    for (let wait = 0; wait < 40 && !editor; wait += 1) {
      await sleep(150);
      editor = app.windows().find((page) => page !== window) ?? null;
    }
    const empty = editor ? await editor.getByTestId('keyframe-editor').textContent({ timeout: 10_000 }).catch(() => '') : '';
    check('Shift+K opens the keyframe editor in a window of its own; with no clip it says to select one', editor !== null && /Select a clip to animate it/.test(empty), empty.slice(0, 80));

    const clipId = await store(() => {
      const s = window.__scfStore.getState();
      const main = s.project.tracks.find((track) => track.type === 'video' && track.order === 0);
      const id = s.addAssetToTimeline(s.assets[0], main.id, 0);
      window.__scfStore.getState().updateClip(id, { effects: [{ id: 'fx-blur', type: 'gaussianBlur', enabled: true, params: { radius: 10 } }] });
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().setCurrentFrame(0);
      return id;
    });
    await editor.getByTestId('kf-rows').waitFor({ state: 'visible', timeout: 10_000 });
    const rowIds = await editor.evaluate(() => [...document.querySelectorAll('[data-testid^="kf-row-"]')].map((row) => row.dataset.testid.replace('kf-row-', '')));
    check('on the selected clip: position, scale, rotation, opacity and the blur’s radius',
      JSON.stringify(rowIds) === JSON.stringify(['transform:position', 'transform:scale', 'transform:rotation', 'transform:opacity', 'effect:fx-blur:radius']), rowIds.join(', '));

    /* 2. stopwatch, diamond, ◀ ▶ -------------------------------------------------------------- */
    const opacity = () => store((id) => window.__scfStore.getState().project.clips[id].transform.opacity.map((key) => ({ frame: key.frame, value: key.value, easing: key.easing, bezier: key.bezierParams ?? null })), clipId);
    await editor.getByTestId('kf-stopwatch-transform:opacity').click();
    await store(() => window.__scfStore.getState().setCurrentFrame(90));
    await sleep(150);
    await editor.getByTestId('kf-diamond-transform:opacity').click();
    await store((id) => window.__scfStore.getState().setNumberKeyframe(id, 'opacity', 90, 0.2), clipId);
    await sleep(200);
    const placed = await opacity();
    check('the stopwatch starts the animation with a keyframe at the playhead, the diamond adds another', placed.length === 2 && placed[0].frame === 0 && placed[1].frame === 90, JSON.stringify(placed));
    await editor.getByTestId('kf-previous').click();
    const backTo = await store(() => window.__scfStore.getState().project.currentFrame);
    await editor.getByTestId('kf-next').click();
    const onTo = await store(() => window.__scfStore.getState().project.currentFrame);
    check('◀ and ▶ go from keyframe to keyframe', backTo === 0 && onTo === 90, `${backTo} then ${onTo}`);

    /* 3. a drag in time, a box ------------------------------------------------------------------- */
    const keyBox = (frame) => editor.evaluate((f) => {
      const g = document.querySelector(`[data-testid="kf-key-transform:opacity-${f}"]`);
      const box = g?.getBoundingClientRect();
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    }, frame);
    const area = await editor.evaluate(() => {
      const svg = document.querySelector('[data-testid="kf-sheet"]').getBoundingClientRect();
      return { x: svg.x, width: svg.width };
    });
    const frames = 180;
    const depth = () => store(() => window.__scfHistory.getState().undoStack.length);
    const before = await depth();
    const from = await keyBox(90);
    // The span is drawn between 12 px margins at either end (KeyframeEditor EDGE).
    const to = { x: from.x + (30 / frames) * (area.width - 24), y: from.y };
    await editor.mouse.move(from.x, from.y);
    await editor.mouse.down();
    for (let step = 1; step <= 10; step += 1) await editor.mouse.move(from.x + ((to.x - from.x) * step) / 10, from.y);
    await editor.mouse.up();
    await sleep(250);
    const dragged = await opacity();
    check('a diamond dragged 30 frames later lands there, as one undo step', Math.abs(dragged[1].frame - 120) <= 1 && (await depth()) === before + 1, `${dragged[1].frame}; ${(await depth()) - before} steps`);
    if (shots) await editor.screenshot({ path: join(shots, 'keyframes-hoja.png') });
    const first = await keyBox(0);
    const second = await keyBox(dragged[1].frame);
    // From above and left of the first diamond to past the second.
    await editor.mouse.move(first.x - 10, first.y - 12);
    await editor.mouse.down();
    await editor.mouse.move(second.x + 12, second.y + 12, { steps: 8 });
    await editor.mouse.up();
    await sleep(200);
    const boxed = await editor.evaluate(() => [...document.querySelectorAll('[data-testid^="kf-key-transform:opacity-"]')].filter((g) => g.dataset.picked === 'true').length);
    check('a box drawn over both picks them both', boxed === 2, `${boxed} picked`);

    /* 4. the shape of the move ------------------------------------------------------------------------- */
    // The brightness of the frame a quarter of the way, as the export draws it.
    const brightnessAt = (frame) => store(async (f) => {
      const s = window.__scfStore.getState();
      const rgba = await window.__scfRenderer().renderExact(s.project, f, false);
      // Straight alpha: what is seen over black is the colour times its alpha.
      let sum = 0;
      for (let i = 0; i < rgba.length; i += 4 * 97) sum += (rgba[i] * rgba[i + 3]) / 255;
      return sum / Math.ceil(rgba.length / (4 * 97)) / 255;
    }, frame);
    const end = dragged[1].frame;
    const quarter = Math.round(end / 4);
    const linear = await brightnessAt(quarter);
    await (await editor.getByTestId('kf-key-transform:opacity-0')).click();
    await editor.getByTestId('kf-easing-easeInOut').click();
    await sleep(200);
    const eased = await brightnessAt(quarter);
    // Linear: 1 - 0.8 x 0.25 = 0.8; ease in and out has gone 13 % of the way there: 0.9.
    check('Ease changes the picture the export draws: a quarter of the way, brighter than linear (still easing in)',
      Math.abs(linear - 0.8) < 0.04 && eased > linear + 0.05 && (await opacity())[0].easing === 'easeInOut', `linear ${linear.toFixed(3)}, eased ${eased.toFixed(3)}`);
    await editor.getByTestId('kf-easing-hold').click();
    await sleep(200);
    const held = [await brightnessAt(quarter), await brightnessAt(end - 1), await brightnessAt(end)];
    check('Hold keeps the value to the next keyframe, then jumps', held[0] > 0.97 && held[1] > 0.97 && held[2] < 0.25, held.map((v) => v.toFixed(3)).join(' / '));
    await editor.getByTestId('kf-easing-linear').click();
    await sleep(150);
    const handle = await editor.evaluate(() => {
      const circle = document.querySelector('[data-testid="kf-handle-cp1"]')?.getBoundingClientRect();
      return circle ? { x: circle.x + circle.width / 2, y: circle.y + circle.height / 2 } : null;
    });
    if (handle) {
      await editor.mouse.move(handle.x, handle.y);
      await editor.mouse.down();
      await editor.mouse.move(handle.x - 8, handle.y - 25, { steps: 6 });
      await editor.mouse.up();
    }
    await sleep(200);
    const custom = (await opacity())[0];
    check('a handle dragged in the curve box makes a curve of one’s own', custom.easing === 'bezier' && custom.bezier && custom.bezier.cp1.y > 0.5, JSON.stringify(custom.bezier));

    /* 5. curves ------------------------------------------------------------------------------------- */
    await editor.getByTestId('kf-row-transform:opacity').click();
    await editor.getByTestId('kf-mode-curves').click();
    await sleep(250);
    const curve = await editor.evaluate(() => document.querySelector('[data-testid="kf-curve-value"]')?.getAttribute('points')?.split(' ').length ?? 0);
    if (shots) await editor.screenshot({ path: join(shots, 'keyframes-curvas.png') });
    const point = await editor.evaluate((f) => {
      const circle = document.querySelector(`[data-testid="kf-point-value-${f}"]`)?.getBoundingClientRect();
      return circle ? { x: circle.x + circle.width / 2, y: circle.y + circle.height / 2 } : null;
    }, end);
    if (point) {
      await editor.mouse.move(point.x, point.y);
      await editor.mouse.down();
      await editor.keyboard.down('Shift');
      await editor.mouse.move(point.x, point.y - 40, { steps: 6 });
      await editor.keyboard.up('Shift');
      await editor.mouse.up();
    }
    await sleep(200);
    const raised = (await opacity())[1];
    check('Curves draws the values, and a point dragged up raises its value (Shift: the time kept)', curve > 50 && raised.value > 0.3 && raised.frame === end, `${curve} points; ${JSON.stringify(raised)}`);

    /* 6. delete, close ------------------------------------------------------------------------------ */
    await editor.getByTestId('kf-mode-sheet').click();
    await sleep(150);
    await (await editor.getByTestId(`kf-key-transform:opacity-${end}`)).click();
    await editor.keyboard.press('Delete');
    await sleep(200);
    const left = await opacity();
    check('Delete removes the picked keyframe', left.length === 1 && left[0].frame === 0, JSON.stringify(left));
    // The window goes as the click lands.
    await editor.getByTestId('kf-close').click().catch(() => undefined);
    await sleep(800);
    const closed = app.windows().every((page) => page === window || page.isClosed());
    check('Close closes the window', closed);

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const errors = existsSync(logs)
    ? readdirSync(logs).flatMap((name) => readFileSync(join(logs, name), 'utf8').split('\n')).filter((line) => / ERROR /.test(line))
    : [];
  check('nothing in the app\'s log', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
