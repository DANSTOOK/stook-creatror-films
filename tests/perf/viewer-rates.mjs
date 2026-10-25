import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * How many frames a second the viewer really shows: `node tests/perf/viewer-rates.mjs`
 *
 * For each format - 1080p at 30, 60 and 120 fps, 4K at 30, 60 and 120 - a
 * project of that size and rate with one clip of it, played for a few
 * seconds, and measured from inside the page:
 *
 *   - the screen: how often a frame can be drawn (requestAnimationFrame);
 *   - the decoder: how many of the file's frames the video element presented
 *     (requestVideoFrameCallback), the gaps between them, and the frames the
 *     element itself counts as dropped (getVideoPlaybackQuality);
 *   - the viewer: how many times it drew, how long each draw took, and how
 *     many different frames of the file those draws showed - what reaches the
 *     eye;
 *   - the playhead: whether it kept to real time;
 *   - paused, with nothing changing: how often the viewer draws all the same.
 *
 * VIEWER_FORMATS=1080p60,4k120 picks some; VIEWER_SECONDS sets the length
 * played (5). Writes only into its own work folder; the window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.stress-tmp', 'viewer-rates');
const media = join(root, '.stress-tmp', 'viewer-rates-media');
const seconds = Number(process.env.VIEWER_SECONDS ?? 5);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const FORMATS = [
  { id: '1080p30', width: 1920, height: 1080, fps: 30 },
  { id: '1080p60', width: 1920, height: 1080, fps: 60 },
  { id: '1080p120', width: 1920, height: 1080, fps: 120 },
  { id: '4k30', width: 3840, height: 2160, fps: 30 },
  { id: '4k60', width: 3840, height: 2160, fps: 60 },
  { id: '4k120', width: 3840, height: 2160, fps: 120 },
].filter((format) => !process.env.VIEWER_FORMATS || process.env.VIEWER_FORMATS.split(',').includes(format.id));

/** A clip of the format: a moving test card, H.264 High as cameras and stock sites deliver, a keyframe each second. */
function clip(format) {
  mkdirSync(media, { recursive: true });
  const file = join(media, `${format.id}.mp4`);
  if (!existsSync(file)) {
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${format.width}x${format.height}:r=${format.fps}`, '-t', String(seconds + 4),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(format.fps), '-b:v', format.width > 2000 ? '60M' : '20M', file]);
  }
  return file;
}

/** The GPU's load and power over `ms`, from nvidia-smi every 200 ms; null where there is none. */
function sampleGpu(ms) {
  const smi = 'C:/Windows/System32/nvidia-smi.exe';
  if (!existsSync(smi)) return Promise.resolve(null);
  return new Promise((done) => {
    const child = spawn(smi, ['--query-gpu=utilization.gpu,power.draw', '--format=csv,noheader,nounits', '-lms', '200'], { windowsHide: true });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.on('error', () => done(null));
    setTimeout(() => {
      child.kill();
      const rows = text.trim().split(/\r?\n/).map((line) => line.split(',').map(Number)).filter((row) => row.length === 2 && row.every(Number.isFinite));
      if (rows.length === 0) return done(null);
      const mean = (index) => rows.reduce((sum, row) => sum + row[index], 0) / rows.length;
      done({ load: Math.round(mean(0)), watts: Number(mean(1).toFixed(1)) });
    }, ms);
  });
}

const quantile = (values, q) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  console.log('making the clips (once; kept in .stress-tmp)');
  const files = FORMATS.map((format) => ({ ...format, file: clip(format) }));

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, 'profile')}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1', SCF_NO_CLOSE_PROMPT: '1', FILMORA_GPU: 'high-performance' },
  });
  const pid = app.process().pid;
  const rows = [];
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    const gpu = await window.evaluate(() => window.filmora.gpuReport?.().catch(() => null));
    console.log(`GPU: ${gpu?.devices?.find((device) => device.active)?.name ?? '?'}`);
    await app.evaluate(({ dialog }, list) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list }); }, files.map((format) => format.file));
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction((count) => window.__scfStore.getState().assets.length === count, files.length, { timeout: 300_000 });

    for (const format of files) {
      const uri = await window.evaluate(([name, w, h, fps]) => {
        const s = window.__scfStore.getState();
        s.setPlaying(false);
        s.removeClips(Object.keys(s.project.clips));
        s.setProjectSettings({ width: w, height: h, fps });
        const asset = window.__scfStore.getState().assets.find((candidate) => candidate.name === name);
        const main = window.__scfStore.getState().project.tracks.find((track) => track.type === 'video' && track.order === 0);
        window.__scfStore.getState().addAssetToTimeline(asset, main.id, 0);
        window.__scfStore.getState().selectClips([]);
        window.__scfStore.getState().setCurrentFrame(0);
        return asset.uri;
      }, [`${format.id}.mp4`, format.width, format.height, format.fps]);
      await sleep(1500);
      // Paused, nothing changing: how often the viewer draws the same picture again.
      const idleGpu = sampleGpu(1800);
      const idle = await window.evaluate(async () => {
        const renderer = window.__scfRenderer();
        const original = renderer.drawViewport;
        let count = 0;
        renderer.drawViewport = function countedDraw(...args) {
          count += 1;
          return original.apply(this, args);
        };
        await new Promise((done) => setTimeout(done, 2000));
        renderer.drawViewport = original;
        return count / 2;
      });
      const idleLoad = await idleGpu;
      // The GPU while it plays, from a little after the start to a little before the end.
      const playGpu = new Promise((done) => setTimeout(() => sampleGpu(Math.max(1000, seconds * 1000 - 600)).then(done), 1000));
      const measured = await window.evaluate(async ([assetUri, playSeconds, fps, onlyNew]) => {
        const renderer = window.__scfRenderer();
        const video = renderer.media.get(renderer.media.previewUriFor(assetUri));
        if (!(video instanceof HTMLVideoElement)) return { error: 'no video element' };
        const fileFps = fps;
        let lastMediaTime = null;
        const presented = [];
        let handle = 0;
        const onFrame = (_now, meta) => {
          presented.push(meta.mediaTime);
          lastMediaTime = meta.mediaTime;
          handle = video.requestVideoFrameCallback(onFrame);
        };
        const draws = [];
        const original = renderer.drawViewport;
        // VIEWER_ONLY_NEW: a draw only when the file has a new frame or the playhead moved - what drawing on demand would do.
        let drawnMedia = null;
        let drawnFrame = -1;
        renderer.drawViewport = function measuredDraw(...args) {
          const frame = window.__scfStore.getState().project.currentFrame;
          if (onlyNew && lastMediaTime === drawnMedia && frame === drawnFrame) return undefined;
          drawnMedia = lastMediaTime;
          drawnFrame = frame;
          const started = performance.now();
          const result = original.apply(this, args);
          draws.push({ ms: performance.now() - started, shows: lastMediaTime });
          return result;
        };
        const intervals = [];
        let lastRaf = null;
        let raf = true;
        const tick = (time) => {
          if (lastRaf !== null) intervals.push(time - lastRaf);
          lastRaf = time;
          if (raf) requestAnimationFrame(tick);
        };
        let seeks = 0;
        const onSeek = () => { seeks += 1; };
        window.__scfStore.getState().setPlaying(true);
        // The start (the sound made ready, the element up to speed) is not measured.
        await new Promise((done) => setTimeout(done, 700));
        handle = video.requestVideoFrameCallback(onFrame);
        requestAnimationFrame(tick);
        video.addEventListener('seeking', onSeek);
        const quality0 = video.getVideoPlaybackQuality();
        const frame0 = window.__scfStore.getState().project.currentFrame;
        const time0 = performance.now();
        draws.length = 0;
        await new Promise((done) => setTimeout(done, playSeconds * 1000));
        const elapsed = (performance.now() - time0) / 1000;
        const frame1 = window.__scfStore.getState().project.currentFrame;
        const quality1 = video.getVideoPlaybackQuality();
        raf = false;
        video.cancelVideoFrameCallback(handle);
        video.removeEventListener('seeking', onSeek);
        renderer.drawViewport = original;
        window.__scfStore.getState().setPlaying(false);
        const gaps = presented.slice(1).map((time, index) => time - presented[index]);
        const skipped = gaps.reduce((sum, gap) => sum + Math.max(0, Math.round(gap * fileFps) - 1), 0);
        const shown = new Set(draws.map((draw) => draw.shows).filter((time) => time !== null));
        return {
          elapsed,
          refreshMs: intervals,
          presentedPerSecond: presented.length / elapsed,
          skipped,
          dropped: quality1.droppedVideoFrames - quality0.droppedVideoFrames,
          decoded: quality1.totalVideoFrames - quality0.totalVideoFrames,
          drawsPerSecond: draws.length / elapsed,
          drawMs: draws.map((draw) => draw.ms),
          shownPerSecond: shown.size / elapsed,
          playheadSpeed: (frame1 - frame0) / fileFps / elapsed,
          seeks,
          drawn: renderer.drawnSize,
        };
      }, [uri, seconds, format.fps, process.env.VIEWER_ONLY_NEW === '1']);
      if (measured.error) {
        console.log(`${format.id}: ${measured.error}`);
        continue;
      }
      const refresh = quantile(measured.refreshMs, 0.5);
      const long = measured.refreshMs.filter((ms) => ms > refresh * 1.5).length;
      const row = {
        format: format.id,
        hz: Math.round(1000 / refresh),
        decoderFps: Number(measured.presentedPerSecond.toFixed(1)),
        skipped: measured.skipped,
        dropped: measured.dropped,
        draws: Number(measured.drawsPerSecond.toFixed(1)),
        drawP50: Number(quantile(measured.drawMs, 0.5).toFixed(2)),
        drawP95: Number(quantile(measured.drawMs, 0.95).toFixed(2)),
        shownFps: Number(measured.shownPerSecond.toFixed(1)),
        longFrames: long,
        speed: Number(measured.playheadSpeed.toFixed(3)),
        seeks: measured.seeks,
        drawnAt: `${measured.drawn.width}x${measured.drawn.height}`,
        idleDraws: idle,
        gpuPaused: idleLoad,
        gpuPlaying: await playGpu,
      };
      rows.push(row);
      console.log(`${row.format.padEnd(9)} screen ${row.hz} Hz | decoder ${row.decoderFps} fps (${row.skipped} skipped, ${row.dropped} dropped) | viewer ${row.draws} draws/s, p50 ${row.drawP50} p95 ${row.drawP95} ms, shows ${row.shownFps} different frames/s at ${row.drawnAt} | ${row.longFrames} long frames | playhead x${row.speed} | ${row.seeks} seeks | paused: ${row.idleDraws} draws/s | GPU paused ${row.gpuPaused ? `${row.gpuPaused.load}% ${row.gpuPaused.watts} W` : '?'}, playing ${row.gpuPlaying ? `${row.gpuPlaying.load}% ${row.gpuPlaying.watts} W` : '?'}`);
    }
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  writeFileSync(join(work, 'report.json'), JSON.stringify(rows, null, 2));
  console.log(`\nreport: ${join(work, 'report.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
