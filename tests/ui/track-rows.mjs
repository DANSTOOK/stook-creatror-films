import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The timeline's rows, the way CapCut has them: `node tests/ui/track-rows.mjs`
 *
 *   1. picture rows are taller than the rest (70 and 42 px docked), and a low
 *      row puts its name and its buttons on one line, the name whole;
 *   2. the main track - the bottom picture track - says so, and it alone;
 *   3. each header sits level with its row on the canvas, and a click in the
 *      middle of any row picks that row's clip: what is drawn and what is hit
 *      agree, whatever the heights;
 *   4. with the magnet, a clip dragged from the library past the end of the
 *      main track lands against its last clip; with the magnet off, where it
 *      was dropped; on another track, where it was dropped either way.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'track-rows');
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
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  const sound = join(work, 'sound.wav');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=4:sample_rate=48000', sound]);
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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video, sound]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    // A clip on each kind of row: the main track, the sound track, a caption track.
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      const main = s.project.tracks.find((t) => t.type === 'video' && t.order === 0);
      const audio = s.project.tracks.find((t) => t.type === 'audio');
      const picture = window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.kind === 'video'), main.id, 0);
      const heard = window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.kind === 'audio'), audio.id, 0);
      window.__scfStore.getState().addCaptionTrack({ subtitles: [{ startMs: 0, endMs: 2000, text: 'Hola' }] }, { preset: 'classic', language: 'es' });
      window.__scfStore.getState().selectClips([]);
      window.__scfStore.getState().setUi({ pixelsPerFrame: 4, scrollLeftPx: 0 });
      const caption = Object.values(window.__scfStore.getState().project.clips).find((clip) => clip.caption);
      return { main: main.id, picture, heard, caption: caption?.id };
    });
    await sleep(600);

    /* 1. heights, and the low rows' one line ---------------------------------- */
    const headers = await window.evaluate(() => [...document.querySelectorAll('[data-testid^="track-header-"]')].map((row) => {
      const id = row.dataset.testid.replace('track-header-', '');
      const track = window.__scfStore.getState().project.tracks.find((candidate) => candidate.id === id);
      const name = row.querySelector('button');
      const last = [...row.querySelectorAll('button')].at(-1);
      return {
        id,
        type: track.type,
        h: Math.round(row.getBoundingClientRect().height),
        top: row.getBoundingClientRect().top,
        nameTop: Math.round(name.getBoundingClientRect().top),
        lastTop: Math.round(last.getBoundingClientRect().top),
        whole: name.scrollWidth <= name.clientWidth,
      };
    }));
    const expected = (type) => (type === 'video' ? 70 : 42);
    check('picture rows are 70 px and the rest 42', headers.length >= 4 && headers.every((row) => row.h === expected(row.type)), headers.map((row) => `${row.type} ${row.h}`).join(', '));
    const low = headers.filter((row) => row.type !== 'video');
    check('a low row puts its name and its buttons on one line, the name whole', low.length >= 2 && low.every((row) => Math.abs(row.nameTop - row.lastTop) <= 6 && row.whole), JSON.stringify(low.map(({ type, nameTop, lastTop, whole }) => ({ type, nameTop, lastTop, whole }))));
    const tall = headers.filter((row) => row.type === 'video');
    check('a picture row keeps its two lines', tall.every((row) => row.lastTop - row.nameTop >= 14));

    /* 2. the main track says so ------------------------------------------------ */
    const badges = await window.evaluate(() => [...document.querySelectorAll('[data-testid="main-track-badge"]')].map((badge) => badge.closest('[data-testid^="track-header-"]')?.dataset.testid.replace('track-header-', '')));
    check('the main track - the bottom picture track - says so, and it alone', badges.length === 1 && badges[0] === ids.main, JSON.stringify(badges));

    /* 3. headers level with their rows; clicks pick the row's clip ----------- */
    const surface = window.getByTestId('timeline-canvas');
    const canvasBox = await surface.boundingBox();
    const lanes = await window.evaluate((list) => list.map((id) => window.__scfTimelineRow(id)), headers.map((row) => row.id));
    const misaligned = headers.filter((row, index) => Math.abs(row.top - (canvasBox.y + lanes[index].top)) > 1.5);
    check('each header sits level with its row on the canvas', misaligned.length === 0, misaligned.map((row) => row.type).join(', '));
    const picks = [];
    for (const [label, clipId] of [['main', ids.picture], ['sound', ids.heard], ['caption', ids.caption]]) {
      if (!clipId) {
        picks.push(`${label}: no clip`);
        continue;
      }
      const spot = await window.evaluate((id) => {
        const { project, ui } = window.__scfStore.getState();
        const clip = project.clips[id];
        const lane = window.__scfTimelineRow(clip.trackId);
        return { x: (clip.startFrame + Math.min(clip.durationFrames, 60) / 2) * ui.pixelsPerFrame - ui.scrollLeftPx, y: lane.top + lane.height / 2 };
      }, clipId);
      await window.mouse.click(canvasBox.x + spot.x, canvasBox.y + spot.y);
      await sleep(150);
      const selected = await window.evaluate(() => window.__scfStore.getState().ui.selectedClipIds);
      picks.push(`${label}: ${selected.length === 1 && selected[0] === clipId ? 'ok' : JSON.stringify(selected)}`);
    }
    check('a click in the middle of each row picks that row\'s clip', picks.every((pick) => pick.endsWith('ok')), picks.join(', '));

    /* 4. the magnet on the main track ----------------------------------------- */
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    /** Drag the video from the library and drop it at `frame` on the row of `trackId`; where did it land? */
    const dropAsset = (frame, trackId) => window.evaluate(async ([atFrame, onTrack]) => {
      const before = new Set(Object.keys(window.__scfStore.getState().project.clips));
      const asset = window.__scfStore.getState().assets.find((a) => a.kind === 'video');
      const item = document.querySelector(`[data-flip-key="${asset.id}"]`);
      const target = document.querySelector('[data-testid="timeline-canvas"]').parentElement.parentElement;
      const bounds = target.getBoundingClientRect();
      const lane = window.__scfTimelineRow(onTrack);
      const dataTransfer = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      const init = { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + atFrame * window.__scfStore.getState().ui.pixelsPerFrame, clientY: bounds.top + lane.top + lane.height / 2 };
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover', init));
      target.dispatchEvent(new DragEvent('drop', init));
      item.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      await new Promise((done) => setTimeout(done, 300));
      const made = Object.values(window.__scfStore.getState().project.clips).find((clip) => !before.has(clip.id));
      return made ? { trackId: made.trackId, start: made.startFrame } : null;
    }, [frame, trackId]);
    const mainEnd = await window.evaluate((id) => Math.max(...Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.trackId === id).map((clip) => clip.startFrame + clip.durationFrames)), ids.main);
    await window.evaluate(() => window.__scfStore.getState().setUi({ rippleEnabled: true, snappingEnabled: false }));
    const withMagnet = await dropAsset(mainEnd + 120, ids.main);
    check('with the magnet, a drop past the main track\'s end lands against its last clip', withMagnet?.trackId === ids.main && withMagnet.start === mainEnd, `end ${mainEnd}, landed ${JSON.stringify(withMagnet)}`);
    const otherTrack = await window.evaluate(() => window.__scfStore.getState().project.tracks.find((t) => t.type === 'video' && t.order === 1).id);
    const elsewhere = await dropAsset(400, otherTrack);
    check('on another picture track a drop lands where it was dropped', elsewhere?.trackId === otherTrack && elsewhere.start === 400, JSON.stringify(elsewhere));
    const newEnd = await window.evaluate((id) => Math.max(...Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.trackId === id).map((clip) => clip.startFrame + clip.durationFrames)), ids.main);
    await window.evaluate(() => window.__scfStore.getState().setUi({ rippleEnabled: false }));
    const withoutMagnet = await dropAsset(newEnd + 120, ids.main);
    check('with the magnet off, a drop past the end lands where it was dropped', withoutMagnet?.trackId === ids.main && withoutMagnet.start === newEnd + 120, `end ${newEnd}, landed ${JSON.stringify(withoutMagnet)}`);

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
