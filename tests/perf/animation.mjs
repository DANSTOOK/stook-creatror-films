import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Does a held drawing cost what a still image costs?
 * `node tests/perf/animation.mjs`
 *
 * The animation module has claimed so since the day it was built. The only
 * honest check is to count REAL texture uploads while the playhead crosses a
 * hold and then crosses it again:
 *
 *   1. Within one hold the count must not move at all.
 *   2. Across a run it must rise once per DRAWING, not once per frame.
 *   3. A second lap over the same frames must cost nothing, because looping a
 *      scene is what one does while animating.
 *
 * The third of those failed when it was first measured - the cache held one
 * texture for the whole clip, so every lap rasterized all twelve drawings
 * again. It is keyed per exposure now.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const app = await electron.launch({
  args: [`--user-data-dir=${join(root, '.ui-tmp', `anim-perf-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
});
const pid = app.process().pid;
const window = await app.firstWindow();
const issues = [];
window.on('pageerror', (error) => issues.push(error.message));
window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));

let info = { drawings: 0 };
let holdCost = -1;
let runCost = -1;
let secondLap = -1;

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
  await window.getByTestId('library-tab-animation').click();
  await window.getByTestId('animation-add').waitFor({ state: 'visible', timeout: 15_000 });
  await window.getByTestId('animation-add').click();
  await sleep(600);

  // Twelve drawings on twos: a second of animation at 24, which is the real case.
  info = await window.evaluate(() => {
    const state = window.__scfStore.getState();
    const clip = Object.values(state.project.clips).find((candidate) => candidate.anim);
    const layerId = clip.anim.layers[0].id;
    for (let drawing = 0; drawing < 12; drawing += 1) {
      const y = 0.3 + (drawing % 4) * 0.1;
      const points = [];
      // A drawing with some weight to it, not one line: as a hand would make.
      for (let step = 0; step <= 20; step += 1) points.push(0.2 + step * 0.03, y + Math.sin(step / 3) * 0.05, 1);
      window.__scfStore.getState().drawStroke(clip.id, layerId, drawing, { id: `s${drawing}`, brush: 'pencil', color: '#ffffff', size: 0.012, opacity: 1, points });
    }
    // The ghosts off: they are an editing aid and would redraw on every move.
    window.__scfStore.getState().setOnionSkin(clip.id, { enabled: false });
    const after = window.__scfStore.getState().project.clips[clip.id];
    return { start: after.startFrame, step: after.anim.step, drawings: after.anim.layers[0].cels.length };
  });
  await sleep(500);
  console.log(`fixture: ${info.drawings} drawings on ${info.step}s`);

  const uploads = () => window.evaluate(() => window.__scfTextureUploads?.() ?? -1);
  const seek = async (frame) => {
    await window.evaluate((value) => window.__scfStore.getState().setCurrentFrame(value), frame);
    await sleep(220);
  };

  await seek(info.start);
  const atFirst = await uploads();
  await seek(info.start + 1);
  holdCost = (await uploads()) - atFirst;

  const before = await uploads();
  for (let frame = 0; frame < 24; frame += 1) await seek(info.start + frame);
  runCost = (await uploads()) - before;

  const second = await uploads();
  for (let frame = 0; frame < 24; frame += 1) await seek(info.start + frame);
  secondLap = (await uploads()) - second;
} finally {
  await app.close().catch(() => undefined);
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}

const checks = [
  ['a hold costs nothing', holdCost === 0, `${holdCost} uploads across the two frames of one drawing`],
  ['a run uploads once per DRAWING, not per frame', runCost > 0 && runCost <= info.drawings, `${runCost} uploads for ${info.drawings} drawings over 24 frames`],
  ['a second lap costs nothing at all', secondLap === 0, `${secondLap} uploads`],
  ['nothing in the console', issues.length === 0, issues.slice(0, 2).join(' | ')],
];
for (const [name, passed, detail] of checks) {
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
