import { execFile, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Exact-frame check: every timeline frame an export renders is the source
 * frame the decoders' rule picks - the last one at or before the middle of
 * the timeline frame.
 *
 * Every test frame carries its own index as a bar code, so the check reads
 * which frame it got straight off the pixels, and judges it against
 * ffmpeg's own decode of the file (its timestamps, its bar codes) - nothing
 * the app computes is trusted for the answer.
 *
 * Three files, back to back on one timeline: 30 fps with B-frames and sound
 * (the kind of file where a seeked <video> showed the frame before a
 * keyframe), 25 fps footage on the 30 fps timeline (the rule between
 * frames), and a variable-rate file of 30, 60, 20 and 30 fps stretches.
 * Keyframes every 15 frames put many GOP boundaries in a short run.
 *
 * Measured three ways:
 *   1. renderExact as the export dialog drives it (exclusive, sequential);
 *   2. renderExact on its own - a thumbnail, a cover frame - with the viewer
 *      drawing and another video decoding at the same time, the conditions
 *      that made a seeked <video> hand back the previous frame;
 *   3. a real export through the dialog, decoded again by ffmpeg.
 * The old seek-per-frame path (__scfSeekExport) is measured in the
 * conditions of 2 as well and reported, not asserted: it is Chromium's
 * <video>, kept only for files WebCodecs cannot read, and it still misses.
 *
 * node tests/e2e/exact-frames.mjs   (SKIP_BUILD=1 to reuse dist-electron)
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.e2e-tmp', 'exact-frames');
const W = 640;
const H = 360;
const BITS = 10;
const BAR_W = 40;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push({ name, passed: Boolean(passed) });
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Frame `index`: its bar code along the top, over a backdrop that changes every frame. */
function picture(index) {
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      const at = (y * W + x) * 3;
      rgb[at] = 30 + ((x * 7 + y * 3 + index * 5) % 40);
      rgb[at + 1] = 40 + ((x * 3 + y * 5) % 30);
      rgb[at + 2] = 60 + ((x + y + index) % 50);
    }
  for (let bit = 0; bit < BITS; bit += 1) {
    const value = (index >> bit) & 1 ? 250 : 5;
    for (let y = 0; y < 24; y += 1)
      for (let x = bit * BAR_W + 3; x < (bit + 1) * BAR_W - 3; x += 1) rgb.fill(value, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  return rgb;
}

/** The bar code of an RGB(A) picture `width` wide, read at the middle of each bar. */
function barcode(pixels, width, channels) {
  let value = 0;
  for (let bit = 0; bit < BITS; bit += 1) if (pixels[(10 * width + bit * BAR_W + BAR_W / 2) * channels + 1] > 128) value |= 1 << bit;
  return value;
}

/** Encode `count` bar-coded frames at `rate` fps; `vf` retimes them for a variable rate. */
async function encode(out, count, rate, { audio = false, vf = null, extra = [] } = {}) {
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(rate), '-i', 'pipe:0'];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${count / rate}`);
  // The encoder's own time base too, or it rounds the new timestamps back to
  // the input's 1/30 s and the muxer nudges the collisions apart by a tick.
  if (vf) args.push('-vf', vf, '-fps_mode', 'passthrough', '-enc_time_base:v', '1/90000', '-video_track_timescale', '90000');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', ...extra);
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push('-movflags', '+faststart', out);
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  for (let index = 0; index < count; index += 1) {
    if (!child.stdin.write(Buffer.from(picture(index)))) await new Promise((done) => child.stdin.once('drain', done));
  }
  child.stdin.end();
  const code = await new Promise((done) => child.on('close', done));
  if (code !== 0) throw new Error(`ffmpeg could not write ${out}: ${errors.slice(-300)}`);
}

/** ffmpeg's view of a file: each frame's presentation time, bar code, and keyframes. */
async function truthOf(file) {
  const { stdout, stderr } = await execFileAsync(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-vf', `showinfo,scale=${W}:${H},format=rgb24`, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 30 },
  );
  const log = stderr.toString('utf8');
  const [, num, den] = /config in time_base: (\d+)\/(\d+)/.exec(log);
  const shown = [...log.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s.*?iskey:(\d)/g)];
  const times = shown.map((match) => (Number(match[2]) * Number(num)) / Number(den));
  const keyframes = shown.filter((match) => match[3] === '1').map((match) => Number(match[1]));
  const size = W * H * 3;
  const codes = [];
  for (let at = 0; at + size <= stdout.length; at += size) codes.push(barcode(stdout.subarray(at, at + size), W, 3));
  return { times, codes, keyframes };
}

/** The rule: the last source frame at or before the middle of the timeline frame. */
function ruleFrame(times, sourceFrame, fps) {
  const middle = (sourceFrame + 0.5) / fps;
  let found = 0;
  for (let index = 0; index < times.length; index += 1) if (times[index] <= middle + 1e-9) found = index;
  return found;
}

/** In the page: renderExact every timeline frame and read its bar code. */
const RENDER_ALL = async ({ mode, BITS, BAR_W, end }) => {
  const project = window.__scfStore.getState().project;
  const renderer = window.__scfRenderer();
  const { width } = project;
  const read = (rgba) => {
    let value = 0;
    for (let bit = 0; bit < BITS; bit += 1) if (rgba[(10 * width + bit * BAR_W + BAR_W / 2) * 4 + 1] > 128) value |= 1 << bit;
    return value;
  };
  const exportLike = mode === 'export';
  window.__scfSeekExport = mode === 'seek';
  // Another video decoding at the same time, as the viewer's own decoder or
  // a second clip would be: what made a seeked <video> settle on the frame
  // before. Off for the export-like pass, which has the decoders to itself.
  let load = null;
  if (!exportLike) {
    load = document.createElement('video');
    load.src = Object.values(project.clips)[0].sourceUri;
    load.muted = true;
    load.loop = true;
    load.playbackRate = 4;
    document.body.appendChild(load);
    await load.play().catch(() => undefined);
  }
  if (exportLike) {
    renderer.beginExclusive();
    renderer.startSequentialDecode();
  }
  const codes = [];
  let readersSeen = 0;
  const started = performance.now();
  try {
    for (let frame = 0; frame < end; frame += 1) {
      codes.push(read(await renderer.renderExact(project, frame)));
      // Which path drew it: readers exist only while frames are decoded with WebCodecs.
      if (renderer.sequential) readersSeen += 1;
      // Let the viewer draw between renders, as it does when nothing holds it.
      if (!exportLike && frame % 3 === 0) await new Promise((done) => requestAnimationFrame(done));
    }
  } finally {
    if (exportLike) {
      renderer.stopSequentialDecode();
      renderer.endExclusive();
    }
    window.__scfSeekExport = false;
    load?.pause();
    load?.remove();
  }
  return { codes, readersSeen, seconds: (performance.now() - started) / 1000, slow: renderer.slowSources() };
};

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  console.log('1. writing bar-coded test files with the bundled ffmpeg');
  // Variable rate: 30 frames at 30 fps, 60 at 60, 20 at 20, 30 at 30, in a
  // 90 kHz time base so no two frames share a timestamp. The 60 fps stretch
  // is offset by 1/240 s: unshifted, every other frame of it would start
  // exactly on the middle of a 30 fps timeline frame, and which side of a
  // tie a rounded timestamp falls on is not what this checks.
  const vfr = "settb=1/90000,setpts='(if(lt(N,30),N/30,if(lt(N,90),1+(N-30)/60+1/240,if(lt(N,110),2+(N-90)/20,3+(N-110)/30))))/TB'";
  const files = [
    { name: 'exact-30fps-bframes.mp4', count: 120, rate: 30, options: { audio: true } },
    { name: 'exact-25fps.mp4', count: 100, rate: 25, options: {} },
    { name: 'exact-vfr.mp4', count: 140, rate: 30, options: { vf: vfr } },
  ].map((file) => ({ ...file, path: join(workDir, file.name) }));
  for (const file of files) await encode(file.path, file.count, file.rate, file.options);

  for (const file of files) {
    file.truth = await truthOf(file.path);
    const clean = file.truth.codes.length === file.count && file.truth.codes.every((code, index) => code === index) && file.truth.times.length === file.count;
    check(`${file.name}: ffmpeg reads every frame's own bar code back (the reading is sound)`, clean, `${file.truth.codes.length}/${file.count} frames, ${file.truth.keyframes.length} keyframes`);
  }

  if (!process.env.SKIP_BUILD) {
    console.log('2. building the app');
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 });
  }

  console.log('3. rendering every frame in the app');
  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pageErrors = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => pageErrors.push(error.message));
    await window.waitForSelector('#root > *', { timeout: 30_000 });
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true });

    // Each file onto the timeline after the last: "Add at the playhead"
    // leaves the playhead at the end of what it added.
    for (const file of files) {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, file.path);
      await window.getByRole('button', { name: 'Import' }).click();
      const stem = file.name.replace(/\.mp4$/, '');
      const row = window.locator('li').filter({ hasText: stem }).first();
      await row.waitFor({ state: 'visible', timeout: 60_000 });
      await row.hover();
      await row.getByRole('button', { name: 'Add at the playhead' }).click();
      await window.waitForFunction((count) => Object.keys(window.__scfStore.getState().project.clips).length === count, files.indexOf(file) + 1);
    }

    // What every timeline frame must show, from ffmpeg's timestamps.
    const layout = await window.evaluate(() => {
      const { project, assets } = window.__scfStore.getState();
      return {
        fps: project.fps,
        width: project.width,
        height: project.height,
        end: Math.max(...Object.values(project.clips).map((clip) => clip.startFrame + clip.durationFrames)),
        clips: Object.values(project.clips).map((clip) => ({
          name: assets.find((asset) => asset.uri === clip.sourceUri)?.name ?? clip.name,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          sourceOffsetFrames: clip.sourceOffsetFrames,
          plain: (clip.speed ?? 1) === 1 && !clip.reversed,
        })),
      };
    });
    check('the timeline holds the three files back to back, at 640x360, unretimed',
      layout.clips.length === 3 && layout.width === W && layout.height === H && layout.clips.every((clip) => clip.plain)
        && layout.clips.reduce((sum, clip) => sum + clip.durationFrames, 0) === layout.end,
      `${layout.clips.length} clips, ${layout.width}x${layout.height}, ${layout.end} frames at ${layout.fps} fps`);

    const expected = [];
    const beforeKey = new Set();
    for (const clip of layout.clips) {
      const file = files.find((candidate) => clip.name.startsWith(candidate.name.replace(/\.mp4$/, '')));
      if (!file) throw new Error(`no test file for clip ${clip.name}`);
      for (let frame = clip.startFrame; frame < clip.startFrame + clip.durationFrames; frame += 1) {
        const source = ruleFrame(file.truth.times, clip.sourceOffsetFrames + frame - clip.startFrame, layout.fps);
        expected[frame] = file.truth.codes[source];
        if (file.truth.keyframes.includes(source + 1)) beforeKey.add(frame);
      }
    }
    // Not vacuous: the expected pictures change nearly every frame, and many
    // of them sit just before a keyframe, where the old path went wrong.
    const changes = expected.filter((code, index) => index > 0 && code !== expected[index - 1]).length;
    check('the expected frames are many and varied, many just before a keyframe',
      expected.length === layout.end && changes > layout.end * 0.6 && beforeKey.size >= 15,
      `${expected.length} frames, ${changes} changes of picture, ${beforeKey.size} just before a keyframe`);

    const judge = (codes) => {
      const wrong = [];
      for (let frame = 0; frame < expected.length; frame += 1) {
        if (codes[frame] !== expected[frame]) wrong.push(`${frame}:${codes[frame]}!=${expected[frame]}${beforeKey.has(frame) ? '(before key)' : ''}`);
      }
      return wrong;
    };

    for (const [mode, label] of [
      ['export', 'renderExact as the export drives it'],
      ['alone', 'renderExact on its own, with the viewer and another video decoding'],
    ]) {
      for (let pass = 1; pass <= 2; pass += 1) {
        const result = await window.evaluate(RENDER_ALL, { mode, BITS, BAR_W, end: layout.end });
        const wrong = judge(result.codes);
        check(`${label}, pass ${pass}: every frame is the one the rule picks`,
          result.codes.length === expected.length && wrong.length === 0,
          `${wrong.length}/${result.codes.length} wrong${wrong.length ? `: ${wrong.slice(0, 8).join(' ')}` : ''}, ${(result.codes.length / result.seconds).toFixed(0)} frames/s`);
        if (pass === 1) {
          check(`${label}: decoded with WebCodecs, not by seeking`,
            result.readersSeen === result.codes.length && result.slow.length === 0,
            `${result.readersSeen}/${result.codes.length} frames from readers, slow path: ${result.slow.join(', ') || 'none'}`);
        }
      }
    }

    // For information: the seek-per-frame path in the same conditions.
    const seek = await window.evaluate(RENDER_ALL, { mode: 'seek', BITS, BAR_W, end: layout.end });
    const seekWrong = judge(seek.codes);
    console.log(`   info  seek per frame (__scfSeekExport), same conditions: ${seekWrong.length}/${seek.codes.length} wrong${seekWrong.length ? `: ${seekWrong.slice(0, 8).join(' ')}` : ''}`);

    console.log('4. exporting through the dialog');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, workDir);
    await window.getByTestId('title-bar').getByRole('button', { name: 'Export', exact: true }).click();
    const panel = window.locator('.panel').filter({ hasText: 'Target bitrate' }).first();
    await panel.getByText('This render:').waitFor({ timeout: 60_000 });
    await panel.getByLabel('File name').fill('exact-export');
    await panel.getByRole('button', { name: 'Browse' }).click();
    await panel.getByText('Will ', { exact: false }).first().waitFor({ timeout: 10_000 });
    await panel.getByRole('button', { name: 'Start export' }).click();
    const outcome = window.getByText(/Export finished|Export failed/).first();
    await outcome.waitFor({ timeout: 300_000 });
    check('the export finishes', (await outcome.innerText()).startsWith('Export finished'), (await outcome.innerText()).slice(0, 80));

    const exported = await truthOf(join(workDir, 'exact-export.mp4'));
    const wrong = judge(exported.codes);
    check('the exported file holds every timeline frame, each the one the rule picks',
      exported.codes.length === expected.length && wrong.length === 0,
      `${exported.codes.length} frames for ${expected.length}, ${wrong.length} wrong${wrong.length ? `: ${wrong.slice(0, 8).join(' ')}` : ''}`);
  } finally {
    await app.close().catch(() => undefined);
  }
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

  const failed = checks.filter((entry) => !entry.passed).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
