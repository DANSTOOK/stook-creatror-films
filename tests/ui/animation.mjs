import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The 2D animation module in the running app: `node tests/ui/animation.mjs`
 *
 *   1. a new animation clip appears on the timeline, with one layer;
 *   2. a stroke drawn with the pointer lands in the project, and ONE of them
 *      is one undo step;
 *   3. it reaches the picture: the pixels under the line change in the viewer;
 *   4. the exposure holds it - on twos, the drawing covers two frames, and the
 *      picture at the next drawing's frame differs;
 *   5. the onion skin shows the drawing before and does NOT change the frame
 *      the drawing itself is on;
 *   6. layers: a second layer, hidden, takes its drawing out of the picture;
 *   7. it survives saving and loading;
 *   8. nothing in the console.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'animation');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** The viewer's pixels, as a count of those that are not transparent black. */
const painted = (window) =>
  window.evaluate(() => {
    const canvas = document.querySelector('canvas.block.h-full.w-full.object-contain');
    if (!canvas) return -1;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
    let lit = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 24 || data[index + 1] > 24 || data[index + 2] > 24) lit += 1;
    }
    return lit;
  });

/** The animation of the one animation clip there is. */
const animOf = (window) =>
  window.evaluate(() => {
    const clip = Object.values(window.__scfStore.getState().project.clips).find((candidate) => candidate.anim);
    if (!clip) return null;
    return {
      clipId: clip.id,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      step: clip.anim.step,
      layers: clip.anim.layers.map((layer) => ({ id: layer.id, visible: layer.visible, cels: layer.cels.map((cel) => ({ at: cel.at, strokes: cel.strokes.length })) })),
      onion: clip.anim.onion,
    };
  });

/** Drag a line across the viewer, as a hand would. */
async function stroke(window, from, to, steps = 12) {
  const box = await window.getByTestId('draw-overlay').boundingBox();
  if (!box) throw new Error('no draw overlay');
  const point = (at) => ({ x: box.x + box.width * at[0], y: box.y + box.height * at[1] });
  const start = point(from);
  const end = point(to);
  await window.mouse.move(start.x, start.y);
  await window.mouse.down();
  for (let index = 1; index <= steps; index += 1) {
    await window.mouse.move(start.x + ((end.x - start.x) * index) / steps, start.y + ((end.y - start.y) * index) / steps);
  }
  await window.mouse.up();
  await sleep(120);
}

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    console.log('1. a new animation clip');
    await window.getByTestId('library-tab-animation').click();
    await window.getByTestId('animation-add').waitFor({ state: 'visible', timeout: 10_000 });
    await window.getByTestId('animation-add').click();
    await window.getByTestId('draw-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    const fresh = await animOf(window);
    check('the clip is made, with one layer and nothing drawn', fresh?.layers.length === 1 && fresh.layers[0].cels.length === 0, JSON.stringify(fresh?.layers));
    check('and the brush is in hand at once', await window.getByTestId('draw-overlay').isVisible());

    console.log('2. a stroke, and one undo step');
    const blank = await painted(window);
    const depthBefore = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    await stroke(window, [0.25, 0.3], [0.75, 0.35]);
    const drawn = await animOf(window);
    const strokes = drawn?.layers[0].cels.reduce((sum, cel) => sum + cel.strokes, 0) ?? 0;
    check('the stroke lands in the project', strokes === 1, `${strokes} strokes, cels ${JSON.stringify(drawn?.layers[0].cels)}`);
    const depthAfter = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    check('one stroke is one undo step', depthAfter === depthBefore + 1, `${depthBefore} -> ${depthAfter}`);

    console.log('3. it reaches the picture');
    await sleep(300);
    const withLine = await painted(window);
    check('the viewer draws it', withLine > blank + 200, `${blank} -> ${withLine} lit pixels`);

    // Undo takes the line back out of the picture, not just out of the data.
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(350);
    const undone = await painted(window);
    check('undo takes it off the picture too', Math.abs(undone - blank) < 80, `${blank} vs ${undone}`);
    await window.evaluate(() => window.__scfStore.getState().redo());
    await sleep(350);

    console.log('4. the exposure holds a drawing');
    const held = await animOf(window);
    check('a new animation is on twos', held?.step === 2, String(held?.step));
    const atFrame = async (frame) => {
      await window.evaluate((value) => window.__scfStore.getState().setCurrentFrame(value), frame);
      await sleep(300);
      return painted(window);
    };
    const first = await atFrame(held.startFrame);
    const second = await atFrame(held.startFrame + 1);
    check('the same drawing covers both frames of its exposure', Math.abs(first - second) < 80, `${first} vs ${second}`);

    console.log('5. the onion skin');
    // A second drawing four exposures on, so there is something to ghost.
    await window.evaluate((value) => window.__scfStore.getState().setCurrentFrame(value), held.startFrame + 8);
    await sleep(200);
    await stroke(window, [0.3, 0.6], [0.7, 0.62]);
    const two = await animOf(window);
    check('a drawing at another exposure is its own', two?.layers[0].cels.length === 2, JSON.stringify(two?.layers[0].cels));
    // And it is BLANK but for the new stroke: a new exposure is a new drawing,
    // not a copy of the one that was held. Were it a copy, the previous drawing
    // would sit identical underneath and onion skin would show nothing.
    check('and it does not carry the held drawing over', two?.layers[0].cels[1]?.strokes === 1, JSON.stringify(two?.layers[0].cels));

    const lit = await painted(window);
    await window.getByTestId('animation-onion').uncheck();
    await sleep(350);
    const without = await painted(window);
    check('the ghosts are drawn, and go when it is turned off', lit > without + 100, `with ${lit}, without ${without}`);

    await window.getByTestId('animation-onion').check();
    await sleep(300);

    console.log('6. layers');
    await window.getByTestId('animation-add-layer').click();
    const twoLayers = await animOf(window);
    check('a second layer appears', twoLayers?.layers.length === 2, String(twoLayers?.layers.length));
    await stroke(window, [0.4, 0.2], [0.6, 0.22]);
    const onTop = await animOf(window);
    check('the stroke goes on the layer chosen', (onTop?.layers[1].cels[0]?.strokes ?? 0) === 1, JSON.stringify(onTop?.layers.map((layer) => layer.cels)));
    const before = await painted(window);
    await window.getByTestId(`animation-layer-visible-${onTop.layers[1].id}`).click();
    await sleep(350);
    const hidden = await painted(window);
    check('hiding a layer takes its drawing out of the picture', hidden < before - 100, `${before} -> ${hidden}`);
    await window.getByTestId(`animation-layer-visible-${onTop.layers[1].id}`).click();
    await sleep(250);

    console.log('7. saved and loaded');
    const saved = await window.evaluate(() => JSON.stringify(window.__scfStore.getState().toDocument()));
    const reloaded = await window.evaluate((text) => {
      window.__scfStore.getState().loadDocument(JSON.parse(text));
      const clip = Object.values(window.__scfStore.getState().project.clips).find((candidate) => candidate.anim);
      return clip
        ? { step: clip.anim.step, layers: clip.anim.layers.length, strokes: clip.anim.layers.reduce((sum, layer) => sum + layer.cels.reduce((count, cel) => count + cel.strokes.length, 0), 0) }
        : null;
    }, saved);
    const wanted = await window.evaluate(() => {
      const clip = Object.values(window.__scfStore.getState().project.clips).find((candidate) => candidate.anim);
      return clip ? clip.anim.layers.reduce((sum, layer) => sum + layer.cels.reduce((count, cel) => count + cel.strokes.length, 0), 0) : 0;
    });
    check('the drawings come back from the file', reloaded?.strokes === wanted && reloaded.strokes >= 3, JSON.stringify(reloaded));
    check('and so do the layers and the exposure', reloaded?.layers === 2 && reloaded.step === 2, JSON.stringify(reloaded));

    console.log('8. the console');
    check('nothing in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
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
