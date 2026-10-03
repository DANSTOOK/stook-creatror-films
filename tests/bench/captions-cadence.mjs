import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * What word-by-word captions cost playback: `node tests/bench/captions-cadence.mjs`
 *
 * Ten minutes of 1080p video at 30 fps with a caption every three seconds
 * all the way (200 captions, a word every 0.35 s), played in the real app
 * for eight seconds at the start, the middle and the end, measuring the
 * time between the frames the viewer shows - without captions, with still
 * captions (how they were before this phase), and with each animation.
 * Also how many pictures of moving words were drawn a second: the layout of
 * a caption is kept, and a picture is drawn only when the words change.
 *
 * Timings mean something only on an idle machine: check no game is running.
 * The window is never shown (SCF_BACKGROUND).
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp', 'captions-cadence');
const FPS = 30;
const MINUTES = Number(process.env.CAPTIONS_MINUTES ?? 10);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const SENTENCES = [
  'Hoy vamos a editar un vídeo corto',
  'sobre la ciudad de Guadalajara y sus calles',
  'El color también importa en cada toma',
  'Una toma oscura mejora si subimos la exposición',
  'Las nubes naranjas parecen de película',
  'Gracias por acompañarnos hasta el final',
];

function cues() {
  const list = [];
  for (let start = 0.5, at = 0; start + 3 < MINUTES * 60; start += 3, at += 1) {
    const text = SENTENCES[at % SENTENCES.length];
    const parts = text.split(' ');
    const words = parts.map((word, index) => ({ text: word, start: start + index * 0.35, end: start + index * 0.35 + 0.3 }));
    list.push({ start, end: Math.min(start + 2.9, words[words.length - 1].end + 0.5), lines: [text], words });
  }
  return list;
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const video = join(workDir, 'picture.mp4');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=${FPS}:d=40`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', video]);

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
  const report = { minutes: MINUTES, runs: [] };
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }));
    await window.evaluate((fps) => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps }), FPS);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, video);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const list = cues();
    const trackId = await window.evaluate(([copies, fps, captionCues]) => {
      const store = window.__scfStore.getState();
      const picture = store.assets[0];
      const track = store.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      for (let index = 0; index < copies; index += 1) window.__scfStore.getState().addAssetToTimeline(picture, track.id, index * 40 * fps);
      const id = window.__scfStore.getState().addCaptionTrack({ cues: captionCues, offsetFrame: 0 }, { preset: 'classic', language: 'es' });
      window.__scfStore.getState().selectClips([]);
      return id;
    }, [Math.ceil((MINUTES * 60) / 40), FPS, list]);
    const count = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.caption).length);
    console.log(`${MINUTES} minutes of 1080p30, ${count} captions`);
    await sleep(3000);

    /** Play eight seconds from `from` and measure the gaps between the frames shown. */
    const cadence = (from) =>
      window.evaluate(async (start) => {
        const store = window.__scfStore;
        const gaps = [];
        let last = 0;
        let sampling = true;
        const tick = (time) => {
          if (last) gaps.push(time - last);
          last = time;
          if (sampling) requestAnimationFrame(tick);
        };
        store.getState().setCurrentFrame(start);
        await new Promise((done) => setTimeout(done, 1000));
        const drawnBefore = window.__scfCaptions.wordsDrawn();
        const began = performance.now();
        requestAnimationFrame(tick);
        store.getState().setPlaying(true);
        await new Promise((done) => setTimeout(done, 8000));
        store.getState().setPlaying(false);
        sampling = false;
        const played = store.getState().project.currentFrame - start;
        const elapsed = (performance.now() - began) / 1000;
        const sorted = [...gaps].sort((a, b) => a - b);
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
        return {
          p50: q(50),
          p95: q(95),
          p99: q(99),
          worst: sorted[sorted.length - 1],
          over33ms: gaps.filter((gap) => gap > 1000 / 30 + 1).length,
          playedFps: played / elapsed,
          drawnPerSecond: (window.__scfCaptions.wordsDrawn() - drawnBefore) / elapsed,
        };
      }, from);

    const modes = [
      { name: 'no captions', hidden: true, animation: null },
      { name: 'still captions (as before)', hidden: false, animation: null },
      { name: 'highlight, bounce', hidden: false, animation: { kind: 'highlight', color: '#ffe600', bounce: true, perPage: 2 } },
      { name: 'box, bounce', hidden: false, animation: { kind: 'box', color: '#ffe600', bounce: true, perPage: 2 } },
      { name: 'karaoke', hidden: false, animation: { kind: 'karaoke', color: '#ffe600', bounce: false, perPage: 2 } },
      { name: 'appear, bounce', hidden: false, animation: { kind: 'appear', color: '#ffe600', bounce: true, perPage: 2 } },
      { name: 'a few words at a time, bounce', hidden: false, animation: { kind: 'words', color: '#ffe600', bounce: true, perPage: 2 } },
    ];
    const positions = [60, MINUTES * 30, MINUTES * 60 - 30].map((seconds) => Math.round(seconds * FPS));
    for (const mode of modes) {
      await window.evaluate(([id, hidden, animation]) => {
        const store = window.__scfStore.getState();
        store.updateTrack(id, { visible: !hidden });
        window.__scfStore.getState().setCaptionAnimation(id, animation);
      }, [trackId, mode.hidden, mode.animation]);
      await sleep(500);
      const runs = [];
      for (const from of positions) runs.push(await cadence(from));
      const worstOf = (key) => Math.max(...runs.map((run) => run[key]));
      const summary = {
        mode: mode.name,
        p50: runs.reduce((sum, run) => sum + run.p50, 0) / runs.length,
        p95: worstOf('p95'),
        p99: worstOf('p99'),
        worst: worstOf('worst'),
        over33ms: runs.reduce((sum, run) => sum + run.over33ms, 0),
        playedFps: Math.min(...runs.map((run) => run.playedFps)),
        drawnPerSecond: runs.reduce((sum, run) => sum + run.drawnPerSecond, 0) / runs.length,
        runs,
      };
      report.runs.push(summary);
      console.log(
        `${mode.name}: p50 ${summary.p50.toFixed(1)} ms, p95 ${summary.p95.toFixed(1)} ms, p99 ${summary.p99.toFixed(1)} ms, worst ${summary.worst.toFixed(1)} ms, ${summary.over33ms} gaps over a video frame in 24 s, playhead at ${summary.playedFps.toFixed(2)} fps at the slowest, ${summary.drawnPerSecond.toFixed(1)} pictures of words drawn a second`,
      );
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`report: ${join(workDir, 'report.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
