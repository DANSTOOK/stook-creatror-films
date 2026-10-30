import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Audio keyframes, in the running app: `node tests/ui/audio-keyframes.mjs`
 *
 *   1. The keyframe editor shows the sound rows - gain and stereo position -
 *      for a clip that has sound, and not for one that has none.
 *   2. The diamond puts a keyframe at the playhead holding the value the row
 *      had there, so nothing jumps when a curve is started.
 *   3. With a curve, the inspector's fader reads what the clip is doing HERE,
 *      and dragging it moves the whole curve rather than going dead.
 *   4. The curve travels with the clip when the clip is moved.
 *   5. THE EXPORTED FILE FOLLOWS THE CURVES: a gain ramped down 20 dB over six
 *      seconds is 20 dB quieter at the end, and a stereo position swept from
 *      hard left to hard right comes out left at the start and right at the
 *      end. Measured with ffmpeg on the file the app wrote.
 *
 * Writes only into its own work folder (never into Downloads). Needs a build
 * (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'audio-keyframes');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Mean level of a stretch of a file, in dB; one channel of it when `channel` is given. */
const level = (path, from, seconds, channel) => {
  const filters = channel === undefined ? 'volumedetect' : `pan=mono|c0=c${channel},volumedetect`;
  const out = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(seconds), '-i', path, '-af', filters, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return Number(/mean_volume: (-?[\d.]+)/.exec(out)?.[1] ?? NaN);
};

const FPS = 30;
const SECONDS = 6;
const LAST = FPS * SECONDS - 1;

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'out'), { recursive: true });

  // A picture with a steady tone in it: any change in level or in the balance
  // between the channels is the editor's doing, not the footage's.
  const sounding = join(work, 'tone.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=white:s=640x360:r=${FPS}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2', '-shortest', sounding]);
  // And a silent one, which has no sound to animate.
  const silent = join(work, 'silent.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=640x360:r=${FPS}`, '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent]);

  const app = await electron.launch({
    args: ['--autoplay-policy=no-user-gesture-required', `--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: join(work, 'logs') },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    window.on('console', (message) => message.type() === 'error' && issues.push(`console ${message.text()}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [sounding, silent]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 90_000 });
    const store = (fn, arg) => window.evaluate(fn, arg);

    /* 1. the rows ----------------------------------------------------------------------------- */
    const ids = await store((names) => {
      const state = window.__scfStore.getState();
      const main = state.project.tracks.find((track) => track.type === 'video' && track.order === 0);
      const other = state.project.tracks.filter((track) => track.type === 'video').sort((a, b) => a.order - b.order)[1] ?? main;
      const toneAsset = state.assets.find((asset) => asset.sourcePath?.endsWith(names.tone));
      const silentAsset = state.assets.find((asset) => asset.sourcePath?.endsWith(names.silent));
      const tone = state.addAssetToTimeline(toneAsset, main.id, 0);
      const quiet = window.__scfStore.getState().addAssetToTimeline(silentAsset, other.id, 300);
      window.__scfStore.getState().selectClips([tone]);
      window.__scfStore.getState().setCurrentFrame(0);
      return { tone, quiet };
    }, { tone: 'tone.mp4', silent: 'silent.mp4' });

    await window.locator('[data-testid="viewer-timecode"]').click();
    await window.keyboard.press('Shift+K');
    let editor = null;
    for (let wait = 0; wait < 40 && !editor; wait += 1) {
      await sleep(150);
      editor = app.windows().find((page) => page !== window) ?? null;
    }
    if (!editor) throw new Error('the keyframe editor did not open');
    await editor.getByTestId('kf-rows').waitFor({ state: 'visible', timeout: 10_000 });
    const rowsOf = () => editor.evaluate(() => [...document.querySelectorAll('[data-testid^="kf-row-"]')].map((row) => row.dataset.testid.replace('kf-row-', '')));
    const soundingRows = await rowsOf();
    check('on a clip with sound the editor shows the gain and the stereo position, after the transform',
      JSON.stringify(soundingRows) === JSON.stringify(['transform:position', 'transform:scale', 'transform:rotation', 'transform:opacity', 'audio:volume', 'audio:pan']),
      soundingRows.join(', '));

    await store((id) => window.__scfStore.getState().selectClips([id]), ids.quiet);
    await sleep(400);
    const silentRows = await rowsOf();
    check('on a silent clip they are not there at all', !silentRows.some((row) => row.startsWith('audio:')), silentRows.join(', '));

    /* 2. the diamond -------------------------------------------------------------------------- */
    await store((id) => {
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().updateClip(id, { volume: 0.5 });
      window.__scfStore.getState().setCurrentFrame(60);
    }, ids.tone);
    await sleep(400);
    await editor.getByTestId('kf-diamond-audio:volume').click();
    await sleep(300);
    const started = await store((id) => (window.__scfStore.getState().project.clips[id].volumeKeyframes ?? []).map((key) => ({ frame: key.frame, value: key.value })), ids.tone);
    check('the diamond puts a keyframe at the playhead, holding the value the clip already had',
      started.length === 1 && started[0].frame === 60 && Math.abs(started[0].value - 0.5) < 1e-6,
      JSON.stringify(started));

    /* 3. the fader, with a curve under it ----------------------------------------------------- */
    await store((id) => {
      window.__scfStore.getState().updateClip(id, {
        volume: 1,
        volumeKeyframes: [
          { id: 'kv0', frame: 0, value: 1, easing: 'linear' },
          { id: 'kv1', frame: 179, value: 0.5, easing: 'linear' },
        ],
      });
      window.__scfStore.getState().setCurrentFrame(0);
    }, ids.tone);
    await window.locator('[data-testid="inspector-panel"] [role="tab"]', { hasText: 'Audio' }).first().click();
    await sleep(400);
    const onAudioTab = await window.evaluate(() => document.getElementById('inspector-tabpanel')?.dataset.tab ?? null);
    const faderAt = async (frame) => {
      await store((f) => window.__scfStore.getState().setCurrentFrame(f), frame);
      await sleep(250);
      return window.getByLabel('Volume').first().inputValue().then(Number).catch(() => null);
    };
    const atStart = await faderAt(0);
    const atEnd = await faderAt(179);
    check('the fader reads what the clip is doing here, not its plain setting',
      onAudioTab === 'audio' && atStart !== null && Math.abs(atStart - 1) < 0.02 && atEnd !== null && Math.abs(atEnd - 0.5) < 0.02,
      `tab ${onAudioTab}; frame 0: ${atStart}, frame 179: ${atEnd}`);

    // And dragging it moves the whole curve rather than going dead.
    await store((f) => window.__scfStore.getState().setCurrentFrame(f), 0);
    await sleep(250);
    await window.getByLabel('Volume').first().fill('0.6');
    await sleep(350);
    const shifted = await store((id) => (window.__scfStore.getState().project.clips[id].volumeKeyframes ?? []).map((key) => Number(key.value.toFixed(3))), ids.tone);
    check('dragging the fader moves the whole curve by the difference, keeping its shape',
      shifted.length === 2 && Math.abs(shifted[0] - 0.6) < 0.02 && Math.abs(shifted[1] - 0.1) < 0.02,
      JSON.stringify(shifted));

    /* 4. the curve goes with the clip --------------------------------------------------------- */
    await store((id) => {
      const state = window.__scfStore.getState();
      const clip = state.project.clips[id];
      state.moveClipTo(id, clip.trackId, 50);
    }, ids.tone);
    await sleep(400);
    const moved = await store((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { start: clip.startFrame, frames: (clip.volumeKeyframes ?? []).map((key) => key.frame) };
    }, ids.tone);
    check('moving the clip moves its curve with it',
      moved.start === 50 && JSON.stringify(moved.frames) === JSON.stringify([50, 229]),
      JSON.stringify(moved));
    // Back to the start of the timeline for the export, with both curves on.
    await store((id) => {
      const state = window.__scfStore.getState();
      const clip = state.project.clips[id];
      if (clip.startFrame !== 0) state.moveClipTo(id, clip.trackId, 0);
      window.__scfStore.getState().updateClip(id, {
        volume: 1,
        pan: 0,
        volumeKeyframes: [
          { id: 'kv0', frame: 0, value: 1, easing: 'linear' },
          { id: 'kv1', frame: 179, value: 0.1, easing: 'linear' },
        ],
        panKeyframes: [
          { id: 'kp0', frame: 0, value: -1, easing: 'linear' },
          { id: 'kp1', frame: 179, value: 1, easing: 'linear' },
        ],
      });
    }, ids.tone);
    await sleep(300);

    /* 5. the exported file -------------------------------------------------------------------- */
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, join(work, 'out'));
    await window.getByRole('button', { name: 'Export', exact: true }).click({ timeout: 15_000 });
    const panel = window.getByRole('dialog', { name: 'Export' });
    await panel.getByRole('button', { name: /Start export|New export/ }).first().waitFor({ state: 'visible', timeout: 15_000 });
    await panel.getByLabel('Start frame').fill('0');
    await panel.getByLabel('End frame').fill(String(LAST));
    await panel.getByLabel('File name').fill('curves');
    await panel.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);
    await panel.getByRole('button', { name: 'Start export' }).click();
    const file = join(work, 'out', 'curves.mp4');
    for (let wait = 0; wait < 400 && !(existsSync(file) && statSync(file).size > 10_000); wait += 1) await sleep(300);
    await sleep(1500);
    const wrote = existsSync(file) && statSync(file).size > 10_000;
    check('the export writes the file', wrote, wrote ? `${statSync(file).size} bytes` : 'no file');

    if (wrote) {
      const first = level(file, 0, 1);
      const last = level(file, SECONDS - 1, 1);
      check('the gain follows its curve: 20 dB down over six seconds',
        Number.isFinite(first) && Number.isFinite(last) && first - last > 12,
        `first second ${first} dB, last second ${last} dB, a drop of ${(first - last).toFixed(1)} dB`);

      const leftStart = level(file, 0, 1, 0);
      const rightStart = level(file, 0, 1, 1);
      const leftEnd = level(file, SECONDS - 1, 1, 0);
      const rightEnd = level(file, SECONDS - 1, 1, 1);
      check('the stereo position follows its curve: left at the start, right at the end',
        leftStart - rightStart > 6 && rightEnd - leftEnd > 6,
        `start L ${leftStart} / R ${rightStart} dB; end L ${leftEnd} / R ${rightEnd} dB`);
    } else {
      check('the gain follows its curve: 20 dB down over six seconds', false, 'no file to measure');
      check('the stereo position follows its curve: left at the start, right at the end', false, 'no file to measure');
    }

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
