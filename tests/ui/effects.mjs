import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The Effects panel, in the running app: `node tests/ui/effects.mjs`
 *
 *   1. Every tile - effect, screen move, clip animation - clicked with the
 *      playhead on a clip changes the export's own picture of the frame it
 *      acts on, and one undo takes it off again.
 *   2. Dragged from the panel and dropped on the clip in the timeline, an
 *      effect, a move and an animation go on that clip; dropped past it, or
 *      on another row, nothing happens.
 *   3. The tiles show the effects themselves (no two pictures alike), and
 *      no name runs out of its tile.
 *   4. A Fade in exported to MP4 by ffmpeg and by the platform encoder
 *      starts black and comes up, as the viewer shows it.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'effects');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'out'), { recursive: true });
  const pattern = join(work, 'pattern.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', pattern]);
  const white = join(work, 'white.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1920x1080:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', white]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [pattern, white]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = s.addAssetToTimeline(s.assets.find((a) => a.name === 'pattern.mp4'), track.id, 0);
      s.selectClips([]);
      return id;
    });
    await sleep(1200);

    /** A coarse sample of the export's picture of the playhead's frame. */
    const picture = () => window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, project.currentFrame, true);
        const out = [];
        for (let i = 0; i < rgba.length; i += 4 * 97) out.push(rgba[i], rgba[i + 1], rgba[i + 2]);
        return out;
      } finally {
        renderer.endExclusive();
      }
    });
    const differ = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
    const clipState = () => window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const t = clip.transform;
      return { effects: (clip.effects ?? []).map((e) => e.type), keys: t.position.length + t.scale.length + t.rotation.length + t.opacity.length, selected: window.__scfStore.getState().ui.selectedClipIds };
    }, clipId);

    console.log('1. every tile, clicked');
    await window.getByTestId('library-tab-effects').click();
    await window.waitForSelector('[data-testid="library-effects"]');
    const tiles = await window
      .locator('[data-testid^="library-effect-"]:not(input), [data-testid^="library-motion-"], [data-testid^="library-anim-"]:not(section)')
      .evaluateAll((elements) => elements.filter((e) => e.tagName === 'BUTTON').map((e) => ({ id: e.dataset.testid, group: e.closest('section')?.dataset.testid ?? '' })));
    // Where each kind acts: an In over the clip's first frames, an Out over its last.
    const frameFor = { 'library-anim-group-in': 6, 'library-anim-group-out': 112 };
    const flat = [];
    const undone = [];
    for (const { id, group } of tiles) {
      const at = frameFor[group] ?? 45;
      await window.evaluate((f) => { window.__scfStore.getState().selectClips([]); window.__scfStore.getState().setCurrentFrame(f); }, at);
      const before = await picture();
      const keysBefore = (await clipState()).keys;
      await window.getByTestId(id).scrollIntoViewIfNeeded();
      await window.getByTestId(id).click();
      await sleep(200);
      const after = await clipState();
      if (differ(before, await picture()) < 1) flat.push(id);
      await window.evaluate(() => window.__scfStore.getState().undo());
      await sleep(120);
      const back = await clipState();
      if (back.effects.length !== 0 || back.keys !== keysBefore) undone.push(id);
      if (after.selected.join() !== clipId) flat.push(`${id} (clip not selected)`);
    }
    check(`all ${tiles.length} tiles change the picture of the clip they go on`, tiles.length >= 45 && flat.length === 0, flat.join(', ') || `${tiles.length} tiles`);
    check('one undo takes each off again', undone.length === 0, undone.join(', '));

    console.log('2. dragged onto the clip');
    await window.evaluate(() => window.__scfStore.getState().setUi({ pixelsPerFrame: 2, scrollLeftPx: 0, selectedClipIds: [] }));
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(45));
    await window.getByTestId('library-effects-filter-all').click();
    await sleep(300);
    const drop = (testId, frame, row) => window.evaluate(([id, f, r]) => {
      const item = document.querySelector(`[data-testid="${id}"]`);
      const target = document.querySelector('[data-testid="timeline-canvas"]').parentElement.parentElement;
      const bounds = target.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      const init = { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + f * window.__scfStore.getState().ui.pixelsPerFrame, clientY: bounds.top + 24 + r * 58 + 28 };
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover', init));
      target.dispatchEvent(new DragEvent('drop', init));
      item.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    }, [testId, frame, row]);
    const took = [];
    for (let row = 0; row < 3; row += 1) {
      await drop('library-effect-sepia', 45, row);
      await sleep(150);
      const state = await clipState();
      took.push(state.effects.length);
      if (state.effects.length > 0) await window.evaluate(() => window.__scfStore.getState().undo());
    }
    const clipRow = took.indexOf(1);
    check('an effect dropped on the clip goes on it, and on no other row', took.filter((n) => n > 0).length === 1, `rows took ${JSON.stringify(took)}`);
    const sepiaBefore = await picture();
    await drop('library-effect-sepia', 45, clipRow);
    await sleep(200);
    const dropped = await clipState();
    check('dropped, the picture changes and the clip comes forward in the inspector',
      dropped.effects.join() === 'sepia' && dropped.selected.join() === clipId && differ(sepiaBefore, await picture()) > 20,
      `effects ${dropped.effects.join()}, selected ${dropped.selected.join() === clipId}`);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await drop('library-effect-sepia', 400, clipRow);
    await sleep(150);
    check('dropped past the end of the clip, nothing happens', (await clipState()).effects.length === 0);
    const keys0 = (await clipState()).keys;
    await drop('library-motion-zoomIn', 60, clipRow);
    await sleep(150);
    const keys1 = (await clipState()).keys;
    await window.evaluate(() => window.__scfStore.getState().undo());
    await window.getByTestId('library-effects-filter-animation').click();
    await sleep(200);
    await drop('library-anim-spinIn', 60, clipRow);
    await sleep(150);
    const keys2 = (await clipState()).keys;
    await window.evaluate(() => window.__scfStore.getState().undo());
    check('a screen move and a clip animation dropped on the clip go on it too', keys1 > keys0 && keys2 > keys0, `keyframes ${keys0} -> ${keys1}, ${keys2}`);

    console.log('3. the tiles');
    await window.getByTestId('library-effects-filter-all').click();
    await sleep(600);
    const tilesSeen = await window.evaluate(() => {
      const pictures = [...document.querySelectorAll('[data-testid^="library-effect-"] canvas')].map((canvas) => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4 * 53) hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) % 1000003;
        return hash;
      });
      const overflowing = [...document.querySelectorAll('[data-testid="library-effects"] button.media-tile > span:last-child')]
        .filter((label) => label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1)
        .map((label) => label.textContent);
      return { pictures: pictures.length, distinct: new Set(pictures).size, overflowing };
    });
    check('every effect tile shows its own picture', tilesSeen.pictures >= 20 && tilesSeen.distinct === tilesSeen.pictures, `${tilesSeen.distinct} distinct of ${tilesSeen.pictures}`);
    check('no tile name runs out of its tile', tilesSeen.overflowing.length === 0, tilesSeen.overflowing.join(', '));

    console.log('4. a Fade in, exported');
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.removeClips(Object.keys(s.project.clips));
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.name === 'white.mp4'), track.id, 400);
      window.__scfStore.getState().selectClips([id]);
    });
    await window.getByTestId('library-effects-filter-animation').click();
    await window.getByTestId('library-anim-fadeIn').click();
    await sleep(300);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, join(work, 'out'));
    const lumaOf = (file, index) => {
      const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
      let sum = 0;
      for (const value of raw) sum += value;
      return Math.round(sum / raw.length);
    };
    for (const path of ['none', 'auto']) {
      const name = `fade-${path}`;
      await window.evaluate((hw) => window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', exportAlpha: false, hardwareEncoder: hw, startFrame: 400, endFrame: 440 }), path);
      await window.getByRole('button', { name: 'Export', exact: true }).click();
      const dialog = window.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByLabel('Start frame').fill('400');
      await dialog.getByLabel('End frame').fill('440');
      await dialog.getByLabel('File name').fill(name);
      await dialog.getByRole('button', { name: 'Browse' }).click();
      await sleep(400);
      await dialog.getByRole('button', { name: 'Start export' }).click();
      await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 120_000 }).catch(() => undefined);
      await dialog.getByTitle('Close').click().catch(() => undefined);
      await sleep(400);
      const file = join(work, 'out', `${name}.mp4`);
      const lumas = existsSync(file) ? [lumaOf(file, 0), lumaOf(file, 6), lumaOf(file, 30)] : [];
      check(`Fade in in an MP4 (${path === 'none' ? 'ffmpeg' : 'platform encoder'}): black, coming up, then whole`,
        lumas.length === 3 && lumas[0] < 20 && lumas[1] > 100 && lumas[1] < 220 && lumas[2] > 240, lumas.join(' / '));
    }

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
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
