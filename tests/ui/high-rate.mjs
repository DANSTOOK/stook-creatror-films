import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * A project at 120 fps, played and exported: `node tests/ui/high-rate.mjs`
 *
 * Above 60 fps the preview no longer draws whatever the `<video>` element is
 * showing: a WebCodecs reader decodes the file ahead of the playhead and the
 * element is paused (engine/PlaybackDecoder). At 60 and below the element
 * keeps up and is left to it, which is as much a part of the change as the
 * decoder is - an editor's 30 fps work must not start paying for a second
 * hardware decoder. So:
 *
 *   1. 120 fps is a rate a project can be set to from the interface at all;
 *   2. playing a 120 fps clip, the decoder makes the picture and the element
 *      is paused while it does;
 *   3. what reaches the eye is a different frame of the file at close to 120 a
 *      second, and the playhead keeps real time;
 *   4. the same project at 30 fps does NOT open a playback decoder;
 *   5. with the decoder turned off the element plays it, as before - the
 *      fallback for a file or a machine that cannot do it;
 *   6. the export of a 120 fps project really is 120 fps, read back from the
 *      file itself, and has a frame for each of them.
 *
 * Writes only into its own work folder; exports only into it. Needs a build
 * (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'high-rate');
const logs = join(work, 'logs');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(Boolean(passed));
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** A 1080p 120 fps clip: a moving test card, H.264 High, a keyframe a second. */
function clip() {
  const media = join(root, '.ui-tmp', 'high-rate-media');
  mkdirSync(media, { recursive: true });
  const file = join(media, '1080p120.mp4');
  if (!existsSync(file)) {
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=120', '-t', '6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '120', '-b:v', '20M', file]);
  }
  return file;
}

/**
 * What a file really is: the rate it declares and the frames it actually has,
 * both read with ffmpeg - the rate from the stream it prints, the frames by
 * decoding the whole thing to nothing. ffprobe is not a dependency here, and
 * decoding is the stronger answer anyway: a container can declare any rate.
 */
function probe(file) {
  // ffmpeg writes its report to stderr whether it succeeds or not, so the
  // report is taken from there rather than from the exit code.
  const run = spawnSync(ffmpeg, ['-v', 'info', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const text = `${run.stderr ?? ''}${run.stdout ?? ''}`;
  const declared = /,\s*([\d.]+)\s*fps,/.exec(text);
  const frames = [...text.matchAll(/frame=\s*(\d+)/g)].pop();
  const seconds = /time=(\d+):(\d\d):([\d.]+)/.exec([...text.matchAll(/time=[\d:.]+/g)].pop()?.[0] ?? '');
  const length = seconds ? Number(seconds[1]) * 3600 + Number(seconds[2]) * 60 + Number(seconds[3]) : 0;
  const count = frames ? Number(frames[1]) : 0;
  return { fps: declared ? Number(declared[1]) : 0, frames: count, seconds: length, avgFps: length > 0 ? count / length : 0 };
}

/**
 * Play for `ms` and report what reached the eye: the different frames of the
 * file the viewer actually drew, counted the same way whichever path made
 * them (FrameRenderer.shownRevision), plus whether the element was playing.
 */
const playAndWatch = (window, ms) => window.evaluate(async (duration) => {
  const renderer = window.__scfRenderer();
  const store = window.__scfStore.getState();
  const uri = renderer.media.previewUriFor(store.project.clips[Object.keys(store.project.clips)[0]].sourceUri);
  const video = renderer.media.get(uri);
  const before = renderer.playbackCounts();
  const shown = new Set();
  let elementPlayed = 0;
  let samples = 0;
  store.setCurrentFrame(12);
  window.__scfStore.getState().setPlaying(true);
  // The start - the sound made ready, the reader opened - is not measured.
  await new Promise((done) => setTimeout(done, 700));
  const frame0 = window.__scfStore.getState().project.currentFrame;
  const at0 = performance.now();
  await new Promise((done) => {
    const tick = () => {
      const revision = renderer.shownRevision(uri);
      if (revision) shown.add(revision);
      samples += 1;
      if (video instanceof HTMLVideoElement && !video.paused) elementPlayed += 1;
      if (performance.now() - at0 < duration) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  const elapsed = (performance.now() - at0) / 1000;
  const frame1 = window.__scfStore.getState().project.currentFrame;
  window.__scfStore.getState().setPlaying(false);
  const after = renderer.playbackCounts();
  return {
    elapsed,
    shownPerSecond: shown.size / elapsed,
    decodedAhead: after.ready - before.ready,
    late: after.late - before.late,
    elementPlayedShare: samples > 0 ? elementPlayed / samples : 0,
    playheadSpeed: (frame1 - frame0) / window.__scfStore.getState().project.fps / elapsed,
  };
}, ms);

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'out'), { recursive: true });
  const file = clip();
  const source = probe(file);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs, FILMORA_GPU: 'high-performance' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    /* 1. 120 fps is a rate the interface offers ------------------------------------------------- */
    const rates = await window.evaluate(() => {
      const { COMMON_FPS } = window.__scfConstants ?? {};
      return COMMON_FPS ? [...COMMON_FPS] : null;
    });
    // Read from the project panel itself when the constant is not exposed:
    // what matters is that a hand can choose it.
    const offered = rates ?? await window.evaluate(() => {
      const select = [...document.querySelectorAll('select')].find((node) => [...node.options].some((option) => /\bfps\b/.test(option.textContent ?? '')));
      return select ? [...select.options].map((option) => Number.parseFloat(option.value)).filter((value) => Number.isFinite(value)) : [];
    });
    check('120 fps is a rate a project can be set to', offered.includes(120), `offered ${offered.join(', ') || 'nothing'}`);

    /* The clip, in a 120 fps project ------------------------------------------------------------ */
    await app.evaluate(({ dialog }, list) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list }); }, [file]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 300_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 120 });
      const asset = window.__scfStore.getState().assets[0];
      const main = window.__scfStore.getState().project.tracks.find((track) => track.type === 'video' && track.order === 0);
      window.__scfStore.getState().addAssetToTimeline(asset, main.id, 0);
      window.__scfStore.getState().selectClips([]);
    });
    await sleep(1500);
    check('the file itself is 120 fps, so the test is testing what it says', Math.round(source.fps) === 120, `${source.fps} fps, ${source.frames} frames`);

    /* 2 and 3. The decoder makes the picture, the element stands by ----------------------------- */
    const played = await playAndWatch(window, 2500);
    check('playing at 120 fps, the decoder is what makes the picture',
      played.decodedAhead > 100 && played.decodedAhead > played.late * 4,
      `${played.decodedAhead} frames decoded ahead, ${played.late} draws late`);
    check('and the video element is paused while it does, so only one decoder is held',
      played.elementPlayedShare < 0.1, `element playing on ${Math.round(played.elementPlayedShare * 100)}% of the refreshes`);
    check('what reaches the eye is close to 120 different frames a second',
      played.shownPerSecond > 100, `${played.shownPerSecond.toFixed(1)} different frames/s over ${played.elapsed.toFixed(1)} s`);
    check('and the playhead keeps real time', Math.abs(played.playheadSpeed - 1) < 0.05, `x${played.playheadSpeed.toFixed(3)}`);

    /* 4. At 30 fps nothing changes ------------------------------------------------------------- */
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ fps: 30 }));
    await sleep(800);
    const slow = await playAndWatch(window, 1500);
    check('the same project at 30 fps opens no playback decoder at all',
      slow.decodedAhead === 0, `${slow.decodedAhead} frames decoded ahead`);
    check('and plays on the element there, as it always did',
      slow.elementPlayedShare > 0.5, `element playing on ${Math.round(slow.elementPlayedShare * 100)}% of the refreshes`);

    /* 5. Turned off, the element carries 120 fps too -------------------------------------------- */
    await window.evaluate(() => { window.__scfNoPlaybackDecoder = true; });
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ fps: 120 }));
    await sleep(800);
    const fallback = await playAndWatch(window, 2000);
    check('with the decoder turned off the element plays the 120 fps clip, as the fallback must',
      fallback.decodedAhead === 0 && fallback.elementPlayedShare > 0.5 && fallback.shownPerSecond > 60,
      `${fallback.shownPerSecond.toFixed(1)} different frames/s on the element`);
    await window.evaluate(() => { window.__scfNoPlaybackDecoder = false; });

    /* 6. The export of a 120 fps project is 120 fps -------------------------------------------- */
    await window.evaluate(() => {
      window.__scfStore.getState().setProjectSettings({ fps: 120 });
      window.__scfStore.getState().setCurrentFrame(0);
    });
    await sleep(500);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, join(work, 'out'));
    await window.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = window.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: /Start export|New export/ }).first().waitFor({ state: 'visible', timeout: 20_000 });
    // Two seconds of it: 240 frames to count in the file afterwards.
    await dialog.getByLabel('Start frame').fill('0');
    await dialog.getByLabel('End frame').fill('240');
    await dialog.getByLabel('File name').fill('ciento-veinte');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);
    await dialog.getByRole('button', { name: 'Start export' }).click();
    const out = join(work, 'out', 'ciento-veinte.mp4');
    await window.getByTestId('export-preview-done').waitFor({ state: 'visible', timeout: 300_000 }).catch(() => undefined);
    // The muxer finishes after the tick appears; wait for the file to settle.
    let size = -1;
    for (let still = 0; still < 60; still += 1) {
      const now = existsSync(out) ? statSync(out).size : -1;
      if (now > 10_000 && now === size) break;
      size = now;
      await sleep(1000);
    }
    const made = existsSync(out) ? probe(out) : null;
    // Within a frame of 120, not exactly it: ffmpeg's figure is the average
    // over the frames it saw, and the last frame's own duration is not in the
    // length, so 240 frames across 1.99 s reads as 120.5. The file's own
    // timebase says 120.
    check('the export of a 120 fps project really is 120 fps',
      made !== null && Math.abs(made.fps - 120) <= 1 && made.avgFps >= 115,
      made ? `${made.fps} fps declared, ${made.avgFps.toFixed(1)} decoded a second, ${made.frames} frames in ${made.seconds.toFixed(2)} s, ${Math.round(size / 1024)} KB` : 'no file');
    check('and has a frame for each of them, not 60 stretched over two seconds',
      made !== null && made.frames >= 230, made ? `${made.frames} frames for 240 asked` : 'no file');

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
  check("nothing in the app's log", errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
