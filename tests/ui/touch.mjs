import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The editor under a finger: `node tests/ui/touch.mjs`
 *
 * For a touch laptop. Touch is emulated through the browser's own input, so
 * what happens here is what happens under a real finger:
 *
 *   1. a tap on a clip selects it, and a tap on the ruler moves the playhead;
 *   2. a finger dragging a clip moves it, by the frames it was dragged - the
 *      browser used to take that gesture for a scroll and send pointercancel,
 *      and nothing moved at all;
 *   3. a finger on an empty stretch slides the timeline, sideways and down;
 *   4. two fingers spreading zoom in around the time between them, and closing
 *      zoom out;
 *   5. a finger held still on a clip opens its menu, where a mouse right-clicks;
 *   6. in the viewer, a finger drags a title about;
 *   7. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'touch');
const logs = join(work, 'logs');
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
  const media = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', media]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, 'profile')}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: /Blank project|Proyecto en blanco/ }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [media]);
    await window.getByRole('button', { name: /^(Import|Importar)$/ }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });

    const store = (fn, arg) => window.evaluate(fn, arg);
    const clipId = await store(() => {
      const s = window.__scfStore.getState();
      const main = s.project.tracks.find((track) => track.type === 'video' && track.order === 0);
      const id = s.addAssetToTimeline(s.assets[0], main.id, 30);
      // Tracks enough that the timeline has somewhere to slide down to.
      for (let index = 0; index < 8; index += 1) window.__scfStore.getState().addTrack('audio');
      window.__scfStore.getState().selectClips([]);
      return id;
    });
    await sleep(900);

    /* A finger, as a touch laptop has one ------------------------------------------------------- */
    const cdp = await app.context().newCDPSession(window);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const at = (points) => points.map((point, index) => ({ x: Math.round(point.x), y: Math.round(point.y), id: point.id ?? index + 1 }));
    const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at(points) });
    /** One finger from `from` to `to`, lifted at the end. */
    const drag = async (from, to, { steps = 14, hold = 0 } = {}) => {
      await send('touchStart', [from]);
      if (hold) await sleep(hold);
      for (let step = 1; step <= steps; step += 1) {
        await send('touchMove', [{ x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps }]);
        await sleep(16);
      }
      await send('touchEnd', []);
      await sleep(300);
    };
    const tap = async (point, hold = 70) => {
      await send('touchStart', [point]);
      await sleep(hold);
      await send('touchEnd', []);
      await sleep(350);
    };

    const place = () => window.evaluate((id) => {
      const state = window.__scfStore.getState();
      const clip = state.project.clips[id];
      const row = window.__scfTimelineRow(clip.trackId);
      const canvas = document.querySelector('[data-testid="timeline-canvas"]').getBoundingClientRect();
      const scroller = (() => { let e = document.querySelector('[data-testid="timeline-canvas"]').parentElement; while (e && !/auto|scroll/.test(getComputedStyle(e).overflowY)) e = e.parentElement; return e; })();
      return {
        clip: { x: canvas.x + (clip.startFrame + clip.durationFrames / 2) * state.ui.pixelsPerFrame - state.ui.scrollLeftPx, y: canvas.top + row.top + row.height / 2 },
        // Inside the canvas, well past the clip's end: whatever row is there has
        // nothing on it at that time.
        empty: { x: canvas.right - 120, y: canvas.top + canvas.height / 2 },
        ruler: { x: canvas.x + 320, y: canvas.top + 10 },
        canvas: { left: canvas.x, right: canvas.right, top: canvas.top },
        startFrame: clip.startFrame,
        pixelsPerFrame: state.ui.pixelsPerFrame,
        scroll: { top: scroller?.scrollTop ?? 0, left: scroller?.scrollLeft ?? 0 },
        range: { down: (scroller?.scrollHeight ?? 0) - (scroller?.clientHeight ?? 0), across: (scroller?.scrollWidth ?? 0) - (scroller?.clientWidth ?? 0) },
        emptyUnder: (() => { const el = document.elementFromPoint(canvas.right - 120, canvas.top + canvas.height / 2); return el?.dataset?.testid ?? el?.tagName ?? "nada"; })(),
      };
    }, clipId);

    /* 1. Taps ----------------------------------------------------------------------------------- */
    let where = await place();
    await tap(where.clip);
    const selected = await store(() => window.__scfStore.getState().ui.selectedClipIds);
    check('a tap on a clip selects it', selected.includes(clipId), `${selected.length} seleccionado(s)`);
    const frameBefore = await store(() => window.__scfStore.getState().project.currentFrame);
    await tap(where.ruler);
    const frameAfter = await store(() => window.__scfStore.getState().project.currentFrame);
    check('a tap on the ruler moves the playhead', frameAfter !== frameBefore, `${frameBefore} -> ${frameAfter}`);

    /* 2. Dragging a clip ------------------------------------------------------------------------ */
    where = await place();
    const pixels = 224;
    await drag(where.clip, { x: where.clip.x + pixels, y: where.clip.y });
    const moved = await store((id) => window.__scfStore.getState().project.clips[id].startFrame, clipId);
    const expected = where.startFrame + Math.round(pixels / where.pixelsPerFrame);
    check('a finger drags a clip, by the frames it was dragged', Math.abs(moved - expected) <= 1, `del ${where.startFrame} al ${moved}, esperado ${expected}`);

    /* 3. One finger on an empty stretch slides the view ----------------------------------------- */
    where = await place();
    await drag(where.empty, { x: where.empty.x - 200, y: where.empty.y - 120 });
    const after = (await place()).scroll;
    check('a finger on an empty stretch slides the timeline sideways and down',
      after.left > where.scroll.left + 20 && after.top > where.scroll.top + 20,
      `de (${where.scroll.left}, ${where.scroll.top}) a (${after.left}, ${after.top}); sitio para deslizar: ${where.range.across} a lo ancho y ${where.range.down} a lo alto; bajo el dedo: ${where.emptyUnder}`);

    /* 4. Two fingers zoom ------------------------------------------------------------------------ */
    const zoomBefore = await store(() => window.__scfStore.getState().ui.pixelsPerFrame);
    const middle = { x: where.canvas.left + 500, y: where.canvas.top + 120 };
    await send('touchStart', [{ x: middle.x - 80, y: middle.y, id: 1 }, { x: middle.x + 80, y: middle.y, id: 2 }]);
    for (let step = 1; step <= 10; step += 1) {
      await send('touchMove', [{ x: middle.x - 80 - step * 12, y: middle.y, id: 1 }, { x: middle.x + 80 + step * 12, y: middle.y, id: 2 }]);
      await sleep(16);
    }
    await send('touchEnd', []);
    await sleep(350);
    const zoomOut = await store(() => window.__scfStore.getState().ui.pixelsPerFrame);
    check('two fingers spreading zoom in', zoomOut > zoomBefore * 1.5, `${zoomBefore.toFixed(2)} -> ${zoomOut.toFixed(2)} px por fotograma`);
    await send('touchStart', [{ x: middle.x - 200, y: middle.y, id: 1 }, { x: middle.x + 200, y: middle.y, id: 2 }]);
    for (let step = 1; step <= 10; step += 1) {
      await send('touchMove', [{ x: middle.x - 200 + step * 16, y: middle.y, id: 1 }, { x: middle.x + 200 - step * 16, y: middle.y, id: 2 }]);
      await sleep(16);
    }
    await send('touchEnd', []);
    await sleep(350);
    const zoomIn = await store(() => window.__scfStore.getState().ui.pixelsPerFrame);
    check('and closing them zooms out again', zoomIn < zoomOut * 0.8, `${zoomOut.toFixed(2)} -> ${zoomIn.toFixed(2)} px por fotograma`);

    /* 5. A long press opens the menu -------------------------------------------------------------- */
    // Back where we started: the steps above left the view zoomed and slid along.
    await window.evaluate(() => {
      let element = document.querySelector('[data-testid="timeline-canvas"]').parentElement;
      while (element && !/auto|scroll/.test(getComputedStyle(element).overflowY)) element = element.parentElement;
      if (element) { element.scrollTop = 0; element.scrollLeft = 0; }
      window.__scfStore.getState().setUi({ pixelsPerFrame: 2, scrollLeftPx: 0 });
    });
    await sleep(500);
    where = await place();
    await send('touchStart', [where.clip]);
    await sleep(800);
    const menuUp = await window.getByRole('menuitem').first().isVisible({ timeout: 3000 }).catch(() => false);
    const items = menuUp ? await window.getByRole('menuitem').count() : 0;
    await send('touchEnd', []);
    await window.keyboard.press('Escape');
    await sleep(250);
    check('a finger held on a clip opens its menu', menuUp && items > 5, `${items} opciones`);

    /* 6. The viewer ------------------------------------------------------------------------------- */
    const titleId = await store(() => window.__scfStore.getState().addTitle('title'));
    await sleep(700);
    const viewer = await window.evaluate((id) => {
      const state = window.__scfStore.getState();
      const clip = state.project.clips[id];
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().setCurrentFrame(clip.startFrame + 5);
      const canvas = document.querySelector('[data-testid="preview-panel"] canvas').getBoundingClientRect();
      return { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2, position: { ...(clip.transform.position[0]?.value ?? { x: 0, y: 0 }) }, touchAction: getComputedStyle(document.querySelector('[data-testid="preview-panel"] canvas')).touchAction };
    }, titleId);
    await sleep(500);
    await drag({ x: viewer.x, y: viewer.y }, { x: viewer.x + 120, y: viewer.y - 60 });
    const titleNow = await store((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const key = clip.transform.position[clip.transform.position.length - 1];
      return key ? { ...key.value } : null;
    }, titleId);
    check('in the viewer, a finger drags a title about',
      viewer.touchAction === 'none' && titleNow !== null && (Math.abs(titleNow.x - viewer.position.x) > 10 || Math.abs(titleNow.y - viewer.position.y) > 10),
      `de (${Math.round(viewer.position.x)}, ${Math.round(viewer.position.y)}) a ${titleNow ? `(${Math.round(titleNow.x)}, ${Math.round(titleNow.y)})` : 'ninguna'}; touch-action ${viewer.touchAction}`);

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
