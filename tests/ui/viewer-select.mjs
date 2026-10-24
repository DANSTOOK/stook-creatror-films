import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Selected on the timeline, placed in the viewer: `node tests/ui/viewer-select.mjs`
 *
 *   1. a sticker added from the library and selected on the timeline shows
 *      its box and grips in the viewer, the box around the sticker itself;
 *   2. dragging it there moves it; dragging a corner makes it bigger;
 *   3. a picture over the video, clicked on the timeline, gets the same box;
 *      a plain click on it in the viewer selects it without nudging it;
 *   4. clicked on the timeline with the playhead elsewhere, the sticker
 *      brings the playhead to it, and its box with it.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'viewer-select');
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
  const video = join(work, 'back.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const picture = join(work, 'logo.png');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xef4444:s=400x300:d=1', '-frames:v', '1', picture]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video, picture]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video' && t.order === 0);
      s.addAssetToTimeline(s.assets.find((a) => a.kind === 'video'), track.id, 0);
      window.__scfStore.getState().setCurrentFrame(30);
      window.__scfStore.getState().selectClips([]);
    });

    const handles = () => window.evaluate(() => document.querySelectorAll('[data-testid^="viewport-handle-"]').length);
    const transformOf = (id) => window.evaluate((clipId) => {
      const s = window.__scfStore.getState();
      const clip = s.project.clips[clipId];
      const last = (keys, fallback) => (keys.length ? keys[keys.length - 1].value : fallback);
      return { position: last(clip.transform.position, { x: 0, y: 0 }), scale: last(clip.transform.scale, { x: 1, y: 1 }) };
    }, id);
    /** The selection's box on screen, from its four grips. */
    const box = async () => {
      const tl = await window.getByTestId('viewport-handle-topLeft').boundingBox();
      const br = await window.getByTestId('viewport-handle-bottomRight').boundingBox();
      return { x: tl.x + tl.width / 2, y: tl.y + tl.height / 2, w: br.x - tl.x, h: br.y - tl.y };
    };

    console.log('1. a sticker, selected on the timeline');
    await window.getByTestId('library-tab-stickers').click();
    await window.locator('[data-testid^="library-sticker-"]').first().click();
    const sticker = await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).find((c) => c.name && window.__scfStore.getState().assets.find((a) => a.uri === c.sourceUri)?.kind === 'image')?.id ?? null, null, { timeout: 30_000 }).then((h) => h.jsonValue());
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await sleep(300);
    const none = await handles();
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), sticker);
    await sleep(400);
    const some = await handles();
    check('selected on the timeline, the sticker has its box and grips in the viewer (none before)', none === 0 && some >= 8, `${none} → ${some} grips`);
    const viewer = await window.locator('[data-testid="preview-panel"] canvas').first().boundingBox();
    const first = await box();
    check('the box is round the sticker, not the whole frame', first.w > 10 && first.w < viewer.width * 0.8, `box ${first.w.toFixed(0)}×${first.h.toFixed(0)} px in a ${viewer.width.toFixed(0)} px viewer`);

    console.log('2. moved and made bigger there');
    const before = await transformOf(sticker);
    const centre = { x: first.x + first.w / 2, y: first.y + first.h / 2 };
    await window.mouse.move(centre.x, centre.y);
    await window.mouse.down();
    await window.mouse.move(centre.x + 60, centre.y + 30, { steps: 8 });
    await window.mouse.up();
    await sleep(300);
    const moved = await transformOf(sticker);
    const shift = { x: moved.position.x - before.position.x, y: moved.position.y - before.position.y };
    check('dragging it in the viewer moves it, right and down', shift.x > 40 && shift.y > 15, `moved ${shift.x.toFixed(0)}, ${shift.y.toFixed(0)} px`);
    const corner = await window.getByTestId('viewport-handle-bottomRight').boundingBox();
    await window.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await window.mouse.down();
    await window.mouse.move(corner.x + 50, corner.y + 50, { steps: 8 });
    await window.mouse.up();
    await sleep(300);
    const bigger = await transformOf(sticker);
    const kept = await window.evaluate((id) => { const c = window.__scfStore.getState().project.clips[id]; return { loop: c.fx?.loop?.id ?? null, keys: c.transform.scale.length }; }, sticker);
    check('dragging a corner makes it bigger, for its whole length, its pulse kept', bigger.scale.x > moved.scale.x * 1.1 && kept.loop === 'pulse' && kept.keys > 4,
      `scale at its end ${moved.scale.x.toFixed(3)} → ${bigger.scale.x.toFixed(3)}, ${JSON.stringify(kept)}`);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const undone = await transformOf(sticker);
    check('one undo step takes the whole resize back', Math.abs(undone.scale.x - moved.scale.x) < 1e-6, `${undone.scale.x.toFixed(3)}`);

    console.log('3. a picture over the video');
    const image = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const before = new Set(s.project.tracks.map((t) => t.id));
      s.addTrack('video');
      const track = window.__scfStore.getState().project.tracks.find((t) => !before.has(t.id));
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.name.startsWith('logo')), track.id, 0);
      window.__scfStore.getState().setTransformAt(id, 30, { scale: { x: 0.3, y: 0.3 * (300 / 400) * (1280 / 720) }, position: { x: -300, y: -150 } });
      window.__scfStore.getState().selectClips([]);
      return id;
    });
    await sleep(300);
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), image);
    await sleep(400);
    check('selected on the timeline, the picture has its box too', (await handles()) >= 8);
    const imageBox = await box();
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await sleep(300);
    const still = await transformOf(image);
    await window.mouse.click(imageBox.x + imageBox.w / 2, imageBox.y + imageBox.h / 2);
    await sleep(300);
    const picked = await window.evaluate(() => window.__scfStore.getState().ui.selectedClipIds);
    const after = await transformOf(image);
    check('a plain click on it in the viewer selects it, without nudging it', picked.length === 1 && picked[0] === image && after.position.x === still.position.x && after.position.y === still.position.y,
      JSON.stringify({ picked, still: still.position, after: after.position }));

    console.log('4. clicked on the timeline, the playhead elsewhere');
    await window.evaluate(() => { window.__scfStore.getState().selectClips([]); window.__scfStore.getState().setCurrentFrame(0); });
    await sleep(300);
    const surface = await window.getByTestId('timeline-canvas').boundingBox();
    const spot = await window.evaluate((id) => {
      const { project, ui } = window.__scfStore.getState();
      const clip = project.clips[id];
      // The clip's row as the timeline laid it out: picture rows are taller than the rest.
      const lane = window.__scfTimelineRow(clip.trackId);
      return { x: (clip.startFrame + clip.durationFrames * 0.6) * ui.pixelsPerFrame - ui.scrollLeftPx, y: lane.top + lane.height * 0.6, start: clip.startFrame, end: clip.startFrame + clip.durationFrames };
    }, sticker);
    await window.mouse.click(surface.x + spot.x, surface.y + spot.y);
    await sleep(500);
    const after4 = await window.evaluate(() => ({ playhead: window.__scfStore.getState().project.currentFrame, selected: window.__scfStore.getState().ui.selectedClipIds }));
    check('the playhead comes to the sticker, and its box shows in the viewer', after4.selected[0] === sticker && after4.playhead >= spot.start && after4.playhead < spot.end && (await handles()) >= 8,
      JSON.stringify({ ...after4, clip: [spot.start, spot.end] }));

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
