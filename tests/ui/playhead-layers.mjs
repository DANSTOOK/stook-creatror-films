import { execFile, execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Layers, the viewer's edges and the playback clock, in the running app:
 * `npm run test:playhead-layers:ui`
 *
 *   1. Layers: a title on Video 1 under a picture is hidden, the inspector
 *      says by what, and "Move above" puts it on top - checked by the track
 *      order and by the pixels of the export's own frame (renderExact). A
 *      cover in screen mode does not hide it, and the inspector agrees. With
 *      several hidden titles selected, one click lifts them all.
 *   2. The viewer's edges: a stretched picture stops at the frame's edge and
 *      a moved one lands flush on it, by real mouse drags; the guide is
 *      there while the drag is held and gone after. Alt lets go. The safe
 *      areas stay drawn alongside. The same drag works in the viewer's own
 *      window.
 *   3. The clock: a tick that throws once does not stop the playhead.
 *
 * Every check collects console errors along the way: there must be none
 * beyond the one the clock is expected to report. The window is never
 * shown (SCF_BACKGROUND). Screenshots go to PLAYHEAD_LAYERS_SHOTS when set.
 *
 * Needs a build (npm run build): it runs dist-electron as it is.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'playhead-layers');
const shotsDir = process.env.PLAYHEAD_LAYERS_SHOTS ?? '';
/** A short, light screen recording; any small video will do. */
const lightVideo = process.env.PLAYHEAD_LAYERS_VIDEO ?? resolve(projectRoot, '../../filmora-engine/.bench-media/screencast95.mp4');
const W = 1920;
const H = 1080;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const shot = async (page, name) => {
  if (shotsDir) await page.screenshot({ path: join(shotsDir, name) }).catch(() => undefined);
};

/** The page whose window title starts with `prefix`, or null. */
async function pageTitled(app, prefix) {
  for (const page of app.windows()) {
    const title = await page.title().catch(() => '');
    if (title.startsWith(prefix)) return page;
  }
  return null;
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  if (!existsSync(join(projectRoot, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');

  // Full-frame stills of one colour each, the frame's own size and shape.
  const stills = { red: join(workDir, 'red.png'), blue: join(workDir, 'blue.png') };
  for (const [colour, path] of Object.entries(stills)) {
    await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=${W}x${H}`, '-frames:v', '1', path]);
  }
  let video = lightVideo;
  if (!existsSync(video)) {
    video = join(workDir, 'clip.mp4');
    await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, `profile-${process.pid}-${Date.now()}`)}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const pid = app.process().pid;
  const window = await app.firstWindow();
  const issues = [];
  const watch = (page) => {
    page.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    page.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
  };
  watch(window);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

  const store = (fn, arg) => window.evaluate(fn, arg);
  /** White pixels in the middle of the frame, where a new title's text is, in the export's frame. */
  const whiteInTitle = () =>
    store(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, project.currentFrame, false);
        let white = 0;
        for (let y = 470; y < 610; y += 2) {
          for (let x = 660; x < 1260; x += 2) {
            const i = (y * project.width + x) * 4;
            if (rgba[i] > 230 && rgba[i + 1] > 230 && rgba[i + 2] > 230) white += 1;
          }
        }
        return white;
      } finally {
        renderer.endExclusive();
      }
    });
  /** Pixels of the export's frame at the given points. */
  const exactPixels = (points) =>
    store(async (at) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, project.currentFrame, false);
        return at.map(({ x, y }) => {
          const i = (y * project.width + x) * 4;
          return [rgba[i], rgba[i + 1], rgba[i + 2]];
        });
      } finally {
        renderer.endExclusive();
      }
    }, points);
  const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
  const isBlack = ([r, g, b]) => r < 30 && g < 30 && b < 30;
  const undoDepth = () => store(() => window.__scfHistory?.getState?.().undoStack.length ?? null);
  const pictureRowsTopFirst = () =>
    store(() => window.__scfStore.getState().project.tracks.filter((t) => t.type === 'video').sort((a, b) => b.order - a.order).map((t) => ({ id: t.id, name: t.name })));

  try {
    await store(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [video, stills.red, stills.blue]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 3, null, { timeout: 60_000 });
    // The project keeps 1920x1080 at 30 fps whatever the first import was.
    await store(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));
    const hasHistory = (await undoDepth()) !== null;

    /* 1. Layers ---------------------------------------------------------- */
    console.log('1. layers: what hides a clip, and "Move above"');
    const setup = await store(() => {
      const s = window.__scfStore.getState();
      const v1 = s.project.tracks.find((t) => t.name === 'Video 1');
      const v2 = s.project.tracks.find((t) => t.name === 'Video 2');
      const blue = s.addAssetToTimeline(s.assets.find((a) => a.name === 'blue.png'), v2.id, 0);
      window.__scfStore.getState().updateClip(blue, { durationFrames: 300 });
      const title = window.__scfStore.getState().addTitle('title', { trackId: v1.id, startFrame: 0 });
      window.__scfStore.getState().setCurrentFrame(45);
      window.__scfStore.getState().selectClips([title]);
      return { blue, title, v1: v1.id };
    });
    await sleep(600);
    const onV1 = await store((id) => window.__scfStore.getState().project.clips[id].trackId, setup.title);
    const layerText = await window.getByTestId('inspector-layer-text').innerText();
    const covered = await window.getByTestId('inspector-layer-covered').innerText().catch(() => '');
    const hiddenWhite = await whiteInTitle();
    check('a title on Video 1 under a full-frame picture is hidden, and the inspector says by what',
      onV1 === setup.v1 && layerText === 'Video 1 · under Video 2' && covered.includes('"blue.png"') && covered.includes('Video 2') && hiddenWhite === 0,
      `"${layerText}" / "${covered.replace(/\s+/g, ' ')}" / ${hiddenWhite} white samples in the export frame`);
    await shot(window, '1-title-hidden.png');

    // Blend modes: a screen layer does not hide what is under it - white
    // screened over blue is white - and the inspector must not say it does.
    await store((id) => window.__scfStore.getState().updateClip(id, { blendMode: 'screen' }), setup.blue);
    await sleep(400);
    const screenWarning = await window.getByTestId('inspector-layer-covered').count();
    const screenWhite = await whiteInTitle();
    await store((id) => window.__scfStore.getState().updateClip(id, { blendMode: undefined }), setup.blue);
    await sleep(400);
    const normalWarning = await window.getByTestId('inspector-layer-covered').count();
    check('a cover in screen mode lets the title through, and the inspector says nothing; back in normal, it warns again',
      screenWarning === 0 && screenWhite > 200 && normalWarning === 1,
      `screen: ${screenWarning} warnings, ${screenWhite} white samples; normal: ${normalWarning} warnings`);

    const rowsBefore = await pictureRowsTopFirst();
    const depthBefore = await undoDepth();
    await window.getByTestId('inspector-layer-raise').click();
    await sleep(600);
    const rowsAfter = await pictureRowsTopFirst();
    const moved = await store((id) => window.__scfStore.getState().project.clips[id], setup.title);
    const depthAfter = await undoDepth();
    const raisedWhite = await whiteInTitle();
    const stillWarned = await window.getByTestId('inspector-layer-covered').count();
    const textAfter = await window.getByTestId('inspector-layer-text').innerText();
    check('"Move above" puts it on a new top track, at the same frames, in one undo step',
      rowsAfter.length === rowsBefore.length + 1 && rowsAfter[0].id === moved.trackId && moved.startFrame === 0 &&
        (!hasHistory || depthAfter === depthBefore + 1) && textAfter === 'Video 3 · on top of Video 2' && stillWarned === 0,
      `rows ${rowsAfter.map((row) => row.name).join(', ')}; on ${rowsAfter.find((row) => row.id === moved.trackId)?.name}; undo ${depthBefore} -> ${depthAfter}; "${textAfter}"`);
    check('...and the export frame draws it over the picture', raisedWhite > 200, `${raisedWhite} white samples, 0 before`);
    await shot(window, '2-title-moved-above.png');

    // Several hidden titles, one click.
    await store(() => window.__scfStore.getState().undo());
    await sleep(300);
    const many = await store((ids) => {
      const s = window.__scfStore.getState();
      const second = s.addTitle('lowerThird', { trackId: ids.v1, startFrame: 150 });
      window.__scfStore.getState().setCurrentFrame(45);
      window.__scfStore.getState().selectClips([ids.title, second]);
      return second;
    }, setup);
    await sleep(500);
    const manyText = await window.getByTestId('inspector-layer-covered').innerText().catch(() => '');
    await window.getByTestId('inspector-layer-raise').click();
    await sleep(500);
    const lifted = await store((ids) => {
      const { project } = window.__scfStore.getState();
      const top = project.tracks.filter((t) => t.type === 'video').sort((a, b) => b.order - a.order)[0];
      return { both: [ids.title, ids.second].every((id) => project.clips[id].trackId === top.id), tracks: project.tracks.filter((t) => t.type === 'video').length };
    }, { title: setup.title, second: many });
    const manyWhite = await whiteInTitle();
    check('with two hidden titles selected the inspector counts them, and "Move above" lifts both',
      manyText.includes('2 of 2') && lifted.both && lifted.tracks === 3 && manyWhite > 200,
      `"${manyText.replace(/\s+/g, ' ')}"; both on top ${lifted.both}, ${lifted.tracks} picture tracks, ${manyWhite} white samples`);

    /* 2. The viewer's edges ---------------------------------------------- */
    console.log("2. the viewer's edges");
    const stillId = await store(() => {
      const s = window.__scfStore.getState();
      s.removeClips(Object.keys(s.project.clips));
      const v1 = window.__scfStore.getState().project.tracks.find((t) => t.name === 'Video 1');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.name === 'red.png'), v1.id, 0);
      window.__scfStore.getState().setCurrentFrame(10);
      window.__scfStore.getState().setTransformAt(id, 10, { scale: { x: 0.5, y: 0.5 }, position: { x: 0, y: 0 } });
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().setUi({ transformMode: true, snappingEnabled: true });
      return id;
    });
    await sleep(500);
    const reset = async () => {
      await store((id) => window.__scfStore.getState().setTransformAt(id, 10, { scale: { x: 0.5, y: 0.5 }, position: { x: 0, y: 0 } }), stillId);
      await sleep(250);
    };
    const transformOf = () =>
      store((id) => {
        const clip = window.__scfStore.getState().project.clips[id];
        const last = (keys, fallback) => (keys.length ? keys[keys.length - 1].value : fallback);
        return { scale: last(clip.transform.scale, { x: 1, y: 1 }), position: last(clip.transform.position, { x: 0, y: 0 }) };
      }, stillId);
    const guidesIn = (page) =>
      page.evaluate(() => [...document.querySelectorAll('[data-testid^="viewport-guide-"]')].map((line) => line.getAttribute('data-testid')).sort().join(','));
    const screenOf = async (page) => {
      const canvas = await page.locator('[data-testid="preview-panel"] canvas').first().boundingBox();
      return (x, y) => ({ x: canvas.x + (x / W) * canvas.width, y: canvas.y + (y / H) * canvas.height });
    };

    /** Press at `from`, move to `to` in steps, read the guides while held, let go and read them again. */
    const drag = async (page, from, to, { alt = false, name = '' } = {}) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      if (alt) await page.keyboard.down('Alt');
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await sleep(150);
      const held = await guidesIn(page);
      if (name) await shot(page, name);
      await page.mouse.up();
      if (alt) await page.keyboard.up('Alt');
      await sleep(250);
      return { held, after: await guidesIn(page) };
    };

    let toScreen = await screenOf(window);
    // The right grip, pulled to 4 screen px short of the right edge.
    const grip = await window.getByTestId('viewport-handle-right').boundingBox();
    const nearRight = toScreen(W, H / 2);
    const scaleDrag = await drag(window, { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: nearRight.x - 4, y: nearRight.y }, { name: '3-scale-stops-at-edge.png' });
    const scaled = await transformOf();
    const scaledPixels = await exactPixels([{ x: 1917, y: 540 }, { x: 478, y: 540 }]);
    check("a picture stretched by its grip stops exactly at the frame's right edge, with its guide while held",
      Math.abs(scaled.scale.x - 0.75) < 1e-9 && Math.abs(scaled.scale.y - 0.5) < 1e-9 && scaleDrag.held === 'viewport-guide-right' && scaleDrag.after === '' &&
        isRed(scaledPixels[0]) && isBlack(scaledPixels[1]),
      `scale ${scaled.scale.x} x ${scaled.scale.y}; guides held: ${scaleDrag.held || 'none'}, after: ${scaleDrag.after || 'none'}; pixels ${JSON.stringify(scaledPixels)}`);

    // The same pull with Alt held: the exact pointer, no guide.
    await reset();
    const grip2 = await window.getByTestId('viewport-handle-right').boundingBox();
    const altDrag = await drag(window, { x: grip2.x + grip2.width / 2, y: grip2.y + grip2.height / 2 }, { x: nearRight.x - 4, y: nearRight.y }, { alt: true });
    const altScaled = await transformOf();
    check('with Alt held the grip goes exactly where the pointer is, with no guide',
      altScaled.scale.x < 0.75 - 1e-4 && altScaled.scale.x > 0.7 && altDrag.held === '' && altDrag.after === '',
      `scale ${altScaled.scale.x.toFixed(5)}, guides ${altDrag.held || 'none'}`);

    // Moved towards the left edge with the safe areas showing: flush on the
    // edge, the left guide and not the centre one, the safe areas still drawn.
    await reset();
    await store(() => window.__scfStore.getState().setUi({ showSafeAreas: true }));
    await sleep(250);
    const moveDrag = await drag(window, toScreen(W / 2, H / 2), toScreen(W / 2 - 480 + 6, H / 2 + 120), { name: '4-move-flush-left.png' });
    const movedTransform = await transformOf();
    const safeRects = await window.locator('[data-testid="viewport-safe-action"], [data-testid="viewport-safe-title"]').count();
    const movedPixels = await exactPixels([{ x: 1, y: 660 }, { x: 957, y: 660 }, { x: 963, y: 660 }]);
    check('a picture moved near the left edge lands flush on it, with the left guide while held and none after',
      movedTransform.position.x === -480 && moveDrag.held.includes('viewport-guide-left') && !moveDrag.held.includes('viewport-guide-vertical') && moveDrag.after === '' &&
        isRed(movedPixels[0]) && isRed(movedPixels[1]) && isBlack(movedPixels[2]),
      `x ${movedTransform.position.x}, guides held: ${moveDrag.held || 'none'}, after: ${moveDrag.after || 'none'}; pixels ${JSON.stringify(movedPixels)}`);
    check('the safe areas stay drawn alongside the guides', safeRects === 2, `${safeRects} safe-area boxes`);
    await store(() => window.__scfStore.getState().setUi({ showSafeAreas: false }));

    // The viewer in its own window: the same drag, the same stop, the same guide.
    await reset();
    await window.getByTestId('detach-viewer').click();
    let viewerPage = null;
    for (let tries = 0; tries < 40 && !viewerPage; tries += 1) {
      await sleep(250);
      viewerPage = await pageTitled(app, 'Viewer');
    }
    if (!viewerPage) {
      check('the viewer opens in a window of its own', false, 'no window titled Viewer');
    } else {
      watch(viewerPage);
      await viewerPage.waitForSelector('[data-testid="viewport-handle-right"]', { timeout: 15_000 });
      await sleep(500);
      toScreen = await screenOf(viewerPage);
      const detachedDrag = await drag(viewerPage, toScreen(W / 2, H / 2), toScreen(W / 2 + 480 - 6, H / 2 - 120), { name: '5-detached-move-flush-right.png' });
      const detachedTransform = await transformOf();
      check("in the viewer's own window a move lands flush on the right edge, with the right guide while held",
        detachedTransform.position.x === 480 && detachedDrag.held.includes('viewport-guide-right') && detachedDrag.after === '',
        `x ${detachedTransform.position.x}, guides held: ${detachedDrag.held || 'none'}, after: ${detachedDrag.after || 'none'}`);
      // Back into the editor, so the app closes as it normally does.
      // Clicked from inside the page: the click closes the window it is in,
      // which Playwright's own click reports as a failure.
      await viewerPage.evaluate(() => document.querySelector('[data-testid="dock-viewer"]')?.click()).catch(() => undefined);
      await window.waitForSelector('[data-testid="detach-viewer"]', { timeout: 10_000 });
    }

    /* 3. The clock -------------------------------------------------------- */
    console.log('3. the playback clock');
    await store(() => {
      const s = window.__scfStore.getState();
      s.removeClips(Object.keys(s.project.clips));
      const v1 = window.__scfStore.getState().project.tracks.find((t) => t.name === 'Video 1');
      const clip = s.assets.find((a) => a.kind === 'video');
      window.__scfStore.getState().addAssetToTimeline(clip, v1.id, 0);
      window.__scfStore.getState().selectClips([]);
      window.__scfStore.getState().setCurrentFrame(0);
      let thrown = false;
      window.__off = window.__scfStore.subscribe((state) => {
        if (!thrown && state.ui.isPlaying && state.project.currentFrame > 5) {
          thrown = true;
          throw new Error('test: one failing listener');
        }
      });
      window.__scfStore.getState().setPlaying(true);
    });
    await sleep(1500);
    const afterThrow = await store(() => ({ frame: window.__scfStore.getState().project.currentFrame, playing: window.__scfStore.getState().ui.isPlaying }));
    await store(() => {
      window.__off();
      window.__scfStore.getState().setPlaying(false);
    });
    const reports = issues.filter((text) => text.includes('Playback clock: a tick failed'));
    check('a tick that throws once does not stop the playhead, and is reported once',
      afterThrow.playing && afterThrow.frame > 30 && reports.length === 1, `frame ${afterThrow.frame} after 1.5 s, playing ${afterThrow.playing}, ${reports.length} reports`);
    for (let i = issues.length - 1; i >= 0; i -= 1) if (issues[i].includes('Playback clock: a tick failed')) issues.splice(i, 1);

    check('no errors in the console throughout', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await Promise.race([app.close().catch(() => undefined), sleep(15_000)]);
    // Only the app this script started, and only if it is still there.
    try {
      process.kill(pid, 0);
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
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
