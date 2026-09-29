import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Titles, phase 2, in the running app: `npm run test:titles:motion`
 *
 *   1. animations measured on the rendered frame: Fade's opacity, Rise's
 *      travel, Pop's size and Wipe's edge at given frames, against the
 *      curves they come from; the exit kept at the end when the clip is
 *      trimmed; the credits roll's speed in pixels a frame;
 *   2. the pivot: a scaled title stays centred on its text;
 *   3. a title saved before origins opens drawing exactly the same bytes;
 *   4. the viewer: the title's box is its text, a click beside it picks the
 *      picture under it, a drag moves it with the safe area shown, and a
 *      double-click types into it - keys kept out of the shortcuts, Escape
 *      and Ctrl+Enter finishing, one undo step - with the typed lines laid
 *      over the drawn ones;
 *   5. playback cadence with three animated titles against none;
 *   6. the same editing in Spanish.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to TITLES_SHOTS.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'titles-motion');
const shotsDir = process.env.TITLES_SHOTS ?? '';

const W = 1920;
const H = 1080;
const FPS = 30;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** The curves, written out again from their definitions: cubic-bezier(0.2, 0, 0, 1) and (0.4, 0, 1, 1). */
function bezier(x1, y1, x2, y2) {
  const axis = (t, p1, p2) => 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3;
  return (x) => {
    let low = 0;
    let high = 1;
    for (let i = 0; i < 60; i += 1) {
      const mid = (low + high) / 2;
      if (axis(mid, x1, x2) < x) low = mid;
      else high = mid;
    }
    return axis((low + high) / 2, y1, y2);
  };
}
const easeStandard = bezier(0.2, 0, 0, 1);

async function appMenu(window, menu, item) {
  await window.getByTestId('app-menu-button').click();
  await window.getByRole('menuitem', { name: menu, exact: true }).click();
  await window.getByRole('menuitem', { name: item }).click();
  await window.waitForTimeout(250);
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const still = join(workDir, 'grey.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}`, '-frames:v', '1', still]);
  const video = join(workDir, 'clip.mp4');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}:duration=8`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const projectPath = join(workDir, 'motion.scf');
  const legacyPath = join(workDir, 'legacy.scf');

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [still, video]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const stillId = await window.evaluate(([w, h, fps]) => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: w, height: h, fps });
      const track = s.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      const asset = s.assets.find((candidate) => candidate.kind === 'image');
      const id = s.addAssetToTimeline(asset, track.id, 0);
      window.__scfStore.getState().updateClip(id, { durationFrames: 400 });
      return id;
    }, [W, H, FPS]);

    /** An exact render (the export's frame) of timeline frame `at`, as RGBA. */
    const exact = (at) => window.evaluate(async (frame) => {
      const renderer = window.__scfRenderer();
      const project = window.__scfStore.getState().project;
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, frame, false);
        let binary = '';
        for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
        return btoa(binary);
      } finally {
        renderer.endExclusive();
      }
    }, at).then((b64) => Buffer.from(b64, 'base64'));

    const background = (await exact(10)).subarray(0, 3)[0];
    /**
     * The green title's box on a rendered frame: rows and columns where the
     * red channel has fallen at least halfway from the grey to the box's
     * darkest - so a half-covered pixel counts half, and edges are found to
     * the pixel - and its opacity, from the red at its centre.
     */
    const greenBox = (buffer) => {
      let minR = 255;
      for (let i = 0; i < buffer.length; i += 4) if (buffer[i + 1] > buffer[i] + 20) minR = Math.min(minR, buffer[i]);
      if (minR === 255) return null;
      const threshold = (background + minR) / 2;
      let left = W;
      let right = -1;
      let top = H;
      let bottom = -1;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const at = (y * W + x) * 4;
          if (buffer[at] < threshold && buffer[at + 1] > buffer[at]) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      const centre = ((Math.round((top + bottom) / 2) * W + Math.round((left + right) / 2)) * 4);
      return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1, opacity: 1 - buffer[centre] / background };
    };

    const makeTitle = (preset, start, duration, style, animation) => window.evaluate(([p, s, d, st, an]) => {
      const store = window.__scfStore.getState();
      store.setCurrentFrame(s);
      const id = store.addTitle(p);
      const clip = window.__scfStore.getState().project.clips[id];
      window.__scfStore.getState().updateClip(id, { startFrame: s, durationFrames: d, trackId: clip.trackId });
      window.__scfStore.getState().updateTitle(id, { text: 'I', style: st, animation: an });
      return id;
    }, [preset, start, duration, style, animation]);
    const green = {
      fontFamily: 'Inter', fontWeight: 900, fontSize: 200, color: '#00ff00', align: 'center', anchor: 'center', letterSpacing: 0, lineHeight: 1.15,
      stroke: { enabled: false, color: '#000000', width: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0, distance: 0, angle: 90, blur: 0 },
      box: { enabled: true, color: '#00ff00', opacity: 1, padding: 60, radius: 0 },
    };
    const remove = (id) => window.evaluate((clipId) => window.__scfStore.getState().removeClips([clipId]), id);
    const none = { in: 'none', out: 'none', roll: false };

    console.log('1. animations on the rendered frame');
    const fadeId = await makeTitle('title', 30, 150, green, { ...none, in: 'fade', inSeconds: 0.5 });
    await sleep(600);
    const rest = greenBox(await exact(30 + 20));
    const fades = [];
    for (const k of [0, 3, 5, 10]) fades.push({ k, measured: greenBox(await exact(30 + k))?.opacity ?? 0, wanted: easeStandard(k / 15) });
    check('Fade: the opacity at frames 0, 3, 5 and 10 of 15 is the standard curve\'s (within 1/95)',
      fades.every((row) => Math.abs(row.measured - row.wanted) <= 1.5 / background),
      fades.map((row) => `${row.k}: ${row.measured.toFixed(3)} vs ${row.wanted.toFixed(3)}`).join(', '));
    check('and at rest it is fully on', Math.abs(rest.opacity - 1) < 0.02, rest.opacity.toFixed(3));

    await window.evaluate((id) => window.__scfStore.getState().updateTitle(id, { animation: { in: 'rise' } }), fadeId);
    const rises = [];
    for (const k of [3, 6, 10]) {
      const box = greenBox(await exact(30 + k));
      rises.push({ k, measured: box.top - rest.top, wanted: (1 - easeStandard(k / 15)) * 0.04 * H });
    }
    check('Rise: comes up from 4% of the frame (43.2 px) on the standard curve (within 1 px)',
      rises.every((row) => Math.abs(row.measured - row.wanted) <= 1), rises.map((row) => `${row.k}: ${row.measured} vs ${row.wanted.toFixed(1)}`).join(', '));

    await window.evaluate((id) => window.__scfStore.getState().updateTitle(id, { animation: { in: 'pop' } }), fadeId);
    const pops = [];
    // From the fourth frame, when it is opaque enough to measure its edges.
    for (let k = 4; k < 15; k += 1) pops.push((greenBox(await exact(30 + k))?.width ?? 0) / rest.width);
    const largest = Math.max(...pops);
    check('Pop: still growing on its fourth frame, then past full size with the bounce, and settled at the end',
      pops[0] > 0.85 && pops[0] < 0.98 && largest > 1.002 && largest < 1.02 && Math.abs(pops[pops.length - 1] - 1) < 0.01,
      pops.map((value) => value.toFixed(3)).join(', '));

    await window.evaluate((id) => window.__scfStore.getState().updateTitle(id, { animation: { in: 'wipe' } }), fadeId);
    const wipeMiddle = greenBox(await exact(30 + 4));
    check('Wipe: part way in, the left of the title is drawn and its right is not yet', Boolean(wipeMiddle) && wipeMiddle.left === rest.left && wipeMiddle.right < rest.right - 20,
      wipeMiddle ? `${wipeMiddle.left}-${wipeMiddle.right} of ${rest.left}-${rest.right}` : 'nothing drawn');

    await window.evaluate((id) => window.__scfStore.getState().updateTitle(id, { animation: { in: 'none', out: 'fade', outSeconds: 0.33 } }), fadeId);
    const exitLong = [];
    for (const k of [1, 3, 6]) exitLong.push(greenBox(await exact(30 + 150 - k))?.opacity ?? 0);
    await window.evaluate((id) => window.__scfStore.getState().updateClip(id, { durationFrames: 120 }), fadeId);
    const exitTrimmed = [];
    for (const k of [1, 3, 6]) exitTrimmed.push(greenBox(await exact(30 + 120 - k))?.opacity ?? 0);
    check('the exit is kept at the end: trimmed 30 frames shorter, its last frames fade the same',
      exitLong.every((value, index) => Math.abs(value - exitTrimmed[index]) < 0.011) && exitLong[0] < exitLong[2],
      `${exitLong.map((v) => v.toFixed(3)).join(',')} / ${exitTrimmed.map((v) => v.toFixed(3)).join(',')}`);
    await remove(fadeId);

    // The credits roll, measured in pixels a frame.
    const rollId = await makeTitle('credits', 200, 90, { ...green, fontSize: 120 }, { ...none, roll: true });
    await sleep(500);
    const tops = [];
    for (const k of [10, 11, 12, 40]) tops.push(greenBox(await exact(200 + k))?.top ?? NaN);
    const blockHeight = rest.height === undefined ? 0 : (greenBox(await exact(200 + 45))?.height ?? 0);
    const speed = (H + blockHeight) / 90;
    const perFrame = [tops[1] - tops[0], tops[2] - tops[1], (tops[3] - tops[2]) / 28];
    check('the credits roll at one speed: the frame\'s height and the text\'s over the clip, per frame (within 1 px)',
      perFrame.every((value) => Math.abs(-value - speed) <= 1), `${perFrame.map((v) => (-v).toFixed(2)).join(', ')} px a frame; ${speed.toFixed(2)} wanted`);
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), rollId);
    await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Title' }).click();
    await window.locator('section[data-section="titleAnimation"]').scrollIntoViewIfNeeded();
    const rollNote = await window.locator('section[data-section="titleAnimation"] p').last().innerText();
    const shownSpeed = Number(/([\d.]+) px/.exec(rollNote)?.[1]);
    check('the Title tab says the same speed', Math.abs(shownSpeed - speed) < 1.5, rollNote);
    if (shotsDir) {
      await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(230));
      await sleep(500);
      await window.screenshot({ path: join(shotsDir, 'motion-roll-en.png') });
    }
    await remove(rollId);

    console.log('2. the pivot');
    // Pinned to the left edge, off the frame's centre, with room to grow inside the frame.
    const pivotId = await makeTitle('title', 30, 150, { ...green, anchor: 'left' }, none);
    await sleep(400);
    const unscaled = greenBox(await exact(60));
    await window.evaluate((id) => window.__scfStore.getState().setTransformAt(id, 60, { scale: { x: 1.5, y: 1.5 } }), pivotId);
    const scaled = greenBox(await exact(60));
    const centre = (box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
    check('a title scaled 1.5x grows about its own centre, which stays put (within 1 px)',
      Math.abs(centre(scaled).x - centre(unscaled).x) <= 1 && Math.abs(centre(scaled).y - centre(unscaled).y) <= 1 && Math.abs(scaled.width / unscaled.width - 1.5) < 0.02,
      `centre ${centre(unscaled).x},${centre(unscaled).y} -> ${centre(scaled).x},${centre(scaled).y}; width x${(scaled.width / unscaled.width).toFixed(3)}`);
    await remove(pivotId);

    console.log('3. a title saved before origins');
    const plainId = await makeTitle('title', 30, 150, { ...green, anchor: 'topRight' }, none);
    const scaledId = await makeTitle('lowerThird', 30, 150, { ...green, anchor: 'bottomLeft', color: '#ffffff' }, none);
    await window.evaluate((id) => window.__scfStore.getState().setTransformAt(id, 30, { scale: { x: 1.3, y: 1.3 } }), scaledId);
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, projectPath);
    await appMenu(window, 'File', /^Save$/);
    await window.getByText('Saved to', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
    const saved = JSON.parse(await readFile(projectPath, 'utf8'));
    // As phase 1 saved them: no origin, no animation.
    for (const clip of Object.values(saved.project.clips)) {
      if (!clip.title) continue;
      delete clip.title.origin;
      delete clip.title.animation;
    }
    await writeFile(legacyPath, JSON.stringify(saved));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, legacyPath);
    await window.evaluate(() => { window.__beforeOpen = window.__scfStore.getState().project; });
    await appMenu(window, 'File', /^Open project/);
    await window.waitForFunction(() => window.__scfStore.getState().project !== window.__beforeOpen, null, { timeout: 30_000 });
    await sleep(1200);
    const origins = await window.evaluate(([a, b]) => {
      const clips = window.__scfStore.getState().project.clips;
      return [clips[a]?.title?.origin, clips[b]?.title?.origin];
    }, [plainId, scaledId]);
    check('opened, the unscaled title moves to its text centre and the scaled one keeps the frame\'s', origins.join(',') === 'text,frame', origins.join(','));
    let opened = await exact(60);
    for (let tries = 0; tries < 20; tries += 1) {
      await sleep(250);
      const again = await exact(60);
      if (again.equals(opened)) break;
      opened = again;
    }
    // The old way of drawing, put back by hand, for comparison.
    await window.evaluate((id) => window.__scfStore.getState().updateTitle(id, { origin: 'frame' }), plainId);
    const oldWay = await exact(60);
    check('and draws exactly the same bytes as before the change', opened.equals(oldWay));
    await window.evaluate((id) => window.__scfStore.getState().updateTitle(id, { origin: 'text' }), scaledId);
    const moved = await exact(60);
    check('(the scaled one would have moved had it changed: which is why it keeps the frame\'s centre)', !moved.equals(oldWay));
    await window.evaluate(() => { window.__scfStore.getState().undo(); window.__scfStore.getState().undo(); });
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), scaledId);
    await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Title' }).click();
    const note = window.getByTestId('title-origin-frame');
    check('its Title tab says so, with the change a click away', await note.isVisible().catch(() => false) && await window.getByTestId('title-use-text-origin').isVisible());
    await window.evaluate(([a, b]) => window.__scfStore.getState().removeClips([a, b]), [plainId, scaledId]);

    console.log('4. the viewer');
    const titleId = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      store.setCurrentFrame(60);
      const id = store.addTitle('lowerThird');
      window.__scfStore.getState().updateTitle(id, { text: 'Ana López\nDirectora' });
      window.__scfStore.getState().setCurrentFrame(90);
      return id;
    });
    await sleep(700);
    const canvasBox = await window.locator('[data-testid="preview-panel"] canvas').first().boundingBox();
    const cssPerPx = canvasBox.width / W;
    const titleBox = window.getByTestId('viewport-title-box');
    // The outline's own corners, on screen: its points through the SVG's matrix (a
    // bounding box would count the stroke too).
    const outlineOnScreen = () => titleBox.locator('polygon').last().evaluate((polygon) => {
      const matrix = polygon.getScreenCTM();
      const points = [...polygon.points].map((point) => new DOMPoint(point.x, point.y).matrixTransform(matrix));
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    });
    const boxOnScreen = await outlineOnScreen();
    const drawn = await window.evaluate(async () => {
      // The drawn lower third's dark band, on the viewer's own frame.
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.drawViewport(project, false, false);
      const rgba = renderer.compositor.readPixels(false);
      const w = project.width;
      let left = w;
      let right = -1;
      let top = project.height;
      let bottom = -1;
      for (let y = 0; y < project.height; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const at = (y * w + x) * 4;
          if (rgba[at] < 70 && rgba[at + 1] < 70 && rgba[at + 2] < 70) {
            left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
      }
      return { left, right, top, bottom };
    });
    const onScreen = {
      left: canvasBox.x + drawn.left * cssPerPx,
      right: canvasBox.x + (drawn.right + 1) * cssPerPx,
      top: canvasBox.y + drawn.top * cssPerPx,
      bottom: canvasBox.y + (drawn.bottom + 1) * cssPerPx,
    };
    const within = (a, b) => Math.abs(a - b) <= 2;
    check('selected, a title\'s box is its text\'s (the band), not the frame (within 2 CSS px)',
      within(boxOnScreen.x, onScreen.left) && within(boxOnScreen.x + boxOnScreen.width, onScreen.right)
        && within(boxOnScreen.y, onScreen.top) && within(boxOnScreen.y + boxOnScreen.height, onScreen.bottom),
      `box ${Math.round(boxOnScreen.x)}-${Math.round(boxOnScreen.x + boxOnScreen.width)} x ${Math.round(boxOnScreen.y)}-${Math.round(boxOnScreen.y + boxOnScreen.height)}, band ${Math.round(onScreen.left)}-${Math.round(onScreen.right)} x ${Math.round(onScreen.top)}-${Math.round(onScreen.bottom)}`);

    // In the transform mode too, with its grips round the text; a click beside it picks the picture.
    await window.evaluate(() => window.__scfStore.getState().setUi({ transformMode: true }));
    await sleep(300);
    const grip = await window.getByTestId('viewport-handle-topRight').boundingBox();
    check('in the transform mode the grips sit on the text\'s corners', within(grip.x + grip.width / 2, onScreen.right) && within(grip.y + grip.height / 2, onScreen.top),
      `${Math.round(grip.x + grip.width / 2)},${Math.round(grip.y + grip.height / 2)} vs ${Math.round(onScreen.right)},${Math.round(onScreen.top)}`);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'motion-transform-box-en.png') });
    await window.mouse.click(canvasBox.x + canvasBox.width * 0.75, canvasBox.y + canvasBox.height * 0.3);
    await sleep(200);
    const picked = await window.evaluate(() => window.__scfStore.getState().ui.selectedClipIds);
    check('a click on the picture beside the title picks the picture, not the title', picked.length === 1 && picked[0] === stillId, picked.join(','));
    await window.evaluate(() => window.__scfStore.getState().setUi({ transformMode: false }));
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), titleId);
    await sleep(300);

    // A drag moves it, without the transform mode, and shows the safe area.
    const positionOf = () => window.evaluate((id) => {
      const track = window.__scfStore.getState().project.clips[id].transform.position;
      return track.length ? track[0].value : { x: 0, y: 0 };
    }, titleId);
    const depthNow = () => window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    let depth = await depthNow();
    const grab = { x: (onScreen.left + onScreen.right) / 2, y: (onScreen.top + onScreen.bottom) / 2 };
    await window.mouse.move(grab.x, grab.y);
    await window.mouse.down();
    await window.mouse.move(grab.x + 120, grab.y - 60, { steps: 12 });
    await sleep(150);
    const safeShown = await window.getByTestId('viewport-safe-area').isVisible().catch(() => false);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'motion-drag-safe-area-en.png') });
    await window.mouse.up();
    await sleep(200);
    const afterDrag = await positionOf();
    check('a drag moves the title without the transform mode, the safe area shown while it is held',
      safeShown && Math.abs(afterDrag.x - 120 / cssPerPx) < 12 && Math.abs(afterDrag.y + 60 / cssPerPx) < 12,
      `safe area ${safeShown}; moved ${Math.round(afterDrag.x)}, ${Math.round(afterDrag.y)} px (${Math.round(120 / cssPerPx)}, ${Math.round(-60 / cssPerPx)} wanted)`);
    check('and the drag is one undo step', (await depthNow()) === depth + 1);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);

    // Double-click: typing where it is.
    const editIn = async (language) => {
      const box = await window.getByTestId('viewport-title-box').locator('polygon').last().boundingBox();
      await window.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      const editor = window.getByTestId('title-editor');
      await editor.waitFor({ state: 'visible', timeout: 5_000 });
      return editor;
    };
    depth = await depthNow();
    const clipsBefore = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    const editor = await editIn('en');
    const focused = await window.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    check('a double-click opens the text for typing, focused, labelled "Title text"',
      focused === 'title-editor' && (await editor.getAttribute('aria-label')) === 'Title text');
    await window.keyboard.type('Eva Díaz');
    await window.keyboard.press('Enter');
    // A pause longer than the history's merge window: the edit must still be one step.
    await sleep(900);
    await window.keyboard.type('Guion y montaje');
    // Keys that would do something in the editor: Space plays, B cuts, Delete deletes the clip.
    await window.keyboard.press('Space');
    await window.keyboard.type('b');
    await window.keyboard.press('Backspace');
    await window.keyboard.press('Backspace');
    await sleep(500);
    const lines = await window.evaluate(() => {
      const root = document.querySelector('[data-testid="title-editor"]');
      return [...root.children].map((child) => {
        const range = document.createRange();
        range.selectNodeContents(child);
        const r = range.getBoundingClientRect();
        return { text: child.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, size: parseFloat(child.style.fontSize) };
      });
    });
    const typing = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      return { playing: s.ui.isPlaying, clips: Object.keys(s.project.clips).length };
    });
    check('keys stay in the text: Space, B and Backspace do not play, cut or delete', !typing.playing && typing.clips === clipsBefore,
      `playing ${typing.playing}, clips ${clipsBefore} -> ${typing.clips}`);
    // The typed lines over the drawn ones: the band's left edge plus its padding.
    const drawnNow = await window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project, ui } = window.__scfStore.getState();
      renderer.drawViewport(project, false, false, undefined, ui.editingTitleId);
      const rgba = renderer.compositor.readPixels(false);
      const w = project.width;
      // The white letters: the left edge of the first line's ink.
      let left = w;
      let top = project.height;
      for (let y = 0; y < project.height; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const at = (y * w + x) * 4;
          if (rgba[at] > 200 && rgba[at + 1] > 200 && rgba[at + 2] > 200) {
            if (x < left) left = x;
            if (y < top) top = y;
          }
        }
      }
      return { left, top };
    });
    const inkLeft = canvasBox.x + drawnNow.left * cssPerPx;
    const inkTop = canvasBox.y + drawnNow.top * cssPerPx;
    check('the typed lines lie on the drawn ones: same left edge, the first line\'s ink inside its line (within 2 CSS px)',
      lines.length === 2 && Math.abs(lines[0].left - inkLeft) <= 2 && inkTop >= lines[0].top - 1 && inkTop <= lines[0].bottom,
      `editor ${lines.map((line) => `"${line.text}" ${line.left.toFixed(1)} @${line.size}px`).join(', ')}; ink left ${inkLeft.toFixed(1)}, top ${inkTop.toFixed(1)}`);
    check('and the second line is set smaller, as the lower third draws it', lines.length === 2 && lines[1].size < lines[0].size,
      lines.map((line) => line.size).join(' / '));
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'motion-editing-en.png') });
    await window.keyboard.press('Escape');
    await sleep(300);
    const committed = await window.evaluate((id) => ({
      text: window.__scfStore.getState().project.clips[id].title.text,
      editing: window.__scfStore.getState().ui.editingTitleId,
      depth: window.__scfHistory.getState().undoStack.length,
    }), titleId);
    check('Escape finishes: the text is kept, as one undo step, pauses and all', committed.editing === null && committed.text === 'Eva Díaz\nGuion y montaje' && committed.depth === depth + 1,
      `${JSON.stringify(committed)}; depth before ${depth}`);
    await window.evaluate(() => window.__scfStore.getState().undo());
    const undone = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].title.text, titleId);
    check('one Ctrl+Z puts the whole edit back', undone === 'Ana López\nDirectora', JSON.stringify(undone));

    await editIn('en');
    await window.keyboard.type('Otra');
    await window.keyboard.press('Control+Enter');
    await sleep(300);
    const byCtrlEnter = await window.evaluate((id) => ({
      text: window.__scfStore.getState().project.clips[id].title.text,
      editing: window.__scfStore.getState().ui.editingTitleId,
    }), titleId);
    check('Ctrl+Enter finishes too', byCtrlEnter.editing === null && byCtrlEnter.text === 'Otra', JSON.stringify(byCtrlEnter));

    console.log('5. playback cadence with three animated titles');
    const cadence = async () => {
      await window.evaluate(() => {
        window.__gaps = [];
        window.__draws = [];
        window.__sampling = true;
        let last = 0;
        const tick = (time) => {
          if (last) window.__gaps.push(time - last);
          last = time;
          window.__draws.push(window.__scfRenderer().compositor.stats.lastFrameMs);
          if (window.__sampling) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        window.__scfStore.getState().setCurrentFrame(0);
      });
      await sleep(400);
      await window.evaluate(() => { window.__gaps.length = 0; window.__draws.length = 0; window.__scfStore.getState().setPlaying(true); });
      await sleep(4000);
      return window.evaluate(() => {
        window.__scfStore.getState().setPlaying(false);
        window.__sampling = false;
        const q = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
        const refresh = q(window.__gaps, 50);
        const dropped = window.__gaps.reduce((sum, gap) => sum + (gap > refresh * 1.5 ? Math.round(gap / refresh) - 1 : 0), 0);
        return { frames: window.__gaps.length, p95: q(window.__gaps, 95), dropped, drawP95: q(window.__draws, 95) };
      });
    };
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.removeClips(Object.values(s.project.clips).map((clip) => clip.id));
      const track = s.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      const asset = s.assets.find((candidate) => candidate.kind === 'video');
      window.__scfStore.getState().addAssetToTimeline(asset, track.id, 0);
      window.__scfStore.getState().selectClips([]);
    });
    await sleep(1500);
    const bare = await cadence();
    await window.evaluate(() => {
      const ids = ['title', 'lowerThird', 'credits'].map((preset) => { window.__scfStore.getState().setCurrentFrame(0); return window.__scfStore.getState().addTitle(preset); });
      const store = window.__scfStore.getState();
      for (const id of ids) store.updateClip(id, { startFrame: 0, durationFrames: 150 });
      store.updateTitle(ids[0], { animation: { in: 'pop', inSeconds: 1, out: 'vanish', outSeconds: 1 } });
      store.updateTitle(ids[1], { animation: { in: 'wipe', inSeconds: 1.5, out: 'drop', outSeconds: 1 } });
      window.__scfStore.getState().selectClips([]);
    });
    await sleep(1500);
    const titled = await cadence();
    check('playing with three animated titles keeps the cadence of playing with none',
      titled.dropped <= bare.dropped + 2 && titled.p95 <= bare.p95 + 2 && titled.drawP95 < 3,
      `none: ${bare.frames} frames, p95 ${bare.p95.toFixed(1)} ms, ${bare.dropped} dropped; three: ${titled.frames} frames, p95 ${titled.p95.toFixed(1)} ms, ${titled.dropped} dropped, drawing p95 ${titled.drawP95.toFixed(2)} ms`);

    console.log('6. in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    const spanishId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setCurrentFrame(200);
      const id = s.addTitle('title');
      window.__scfStore.getState().setCurrentFrame(230);
      return id;
    });
    await sleep(600);
    depth = await depthNow();
    const editorEs = await editIn('es');
    check('el texto se abre con doble clic, con la etiqueta «Texto del título»', (await editorEs.getAttribute('aria-label')) === 'Texto del título');
    await window.keyboard.type('Créditos ñ');
    await window.keyboard.press('Space');
    await sleep(300);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'motion-editing-es.png') });
    await window.keyboard.press('Escape');
    await sleep(300);
    const spanish = await window.evaluate((id) => ({
      text: window.__scfStore.getState().project.clips[id].title.text,
      playing: window.__scfStore.getState().ui.isPlaying,
      depth: window.__scfHistory.getState().undoStack.length,
    }), spanishId);
    check('Esc termina: el texto queda, en un solo paso de deshacer, y Espacio no reproduce',
      spanish.text === 'Créditos ñ ' && !spanish.playing && spanish.depth === depth + 1, JSON.stringify(spanish));
    await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Título' }).click();
    const labels = await window.locator('section[data-section="titleAnimation"] .field-label').allInnerTexts();
    check('la animación en español: Entrada, Duración, Salida, Duración, Desplazar',
      labels.join('|') === 'Entrada|Duración|Salida|Duración|Desplazar', labels.join(' / '));
    if (shotsDir) {
      await window.locator('section[data-section="titleAnimation"]').scrollIntoViewIfNeeded();
      await sleep(300);
      await window.screenshot({ path: join(shotsDir, 'motion-animation-tab-es.png') });
    }

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
