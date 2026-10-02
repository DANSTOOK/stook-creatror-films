import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * How long captions take, and what they cost the editor meanwhile:
 * `node tests/bench/captions.mjs`
 *
 * Ten minutes of Spanish speech (tests/bench/captions-tts.ps1, a Windows
 * voice) on the timeline beside a 1080p video, in the real app:
 *
 *   - the time from Generate to the captions being on the timeline, with
 *     each model, and how many times faster than the speech that is;
 *   - the preview's frame cadence while the video plays, before and while
 *     the transcription runs: the editor is meant to stay usable.
 *
 * Timings only mean something on an idle machine: check nothing heavy (a
 * game) is running first. The window is never shown (SCF_BACKGROUND) and
 * the sound is muted while it plays.
 *
 * CAPTIONS_MINUTES (default 10), CAPTIONS_WHISPER_DIR, CAPTIONS_MODELS_DIR.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp', 'captions');
const whisperDir = process.env.CAPTIONS_WHISPER_DIR ?? join(projectRoot, '.stress-tmp', 'whisper-bin', 'b5130-cpu', 'Release');
const modelsDir = process.env.CAPTIONS_MODELS_DIR ?? join(projectRoot, '.stress-tmp', 'whisper-models');
const minutes = Number(process.env.CAPTIONS_MINUTES ?? 10);
const FPS = 30;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  console.log(`making ${minutes} minutes of speech...`);
  await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'captions-tts.ps1'), '-Out', workDir, '-Minutes', String(minutes)], { maxBuffer: 16 * 1024 * 1024 });
  const speech = join(workDir, 'speech.wav');
  const seconds = ((await stat(speech)).size - 44) / 32_000;
  const truth = JSON.parse((await readFile(join(workDir, 'speech.json'), 'utf8')).replace(/^﻿/, ''));
  const video = join(workDir, 'picture.mp4');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=${FPS}:d=40`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', video]);
  console.log(`${seconds.toFixed(0)} s of speech (${truth.words.length} words), and a 1080p video to play`);

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
      SCF_WHISPER_DIR: whisperDir,
      SCF_WHISPER_MODELS_DIR: modelsDir,
    },
  });
  const report = { minutes, seconds, voice: truth.voice, models: {}, cadence: {} };
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }));
    await window.evaluate((fps) => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps }), FPS);
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [video, speech]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const picture = store.assets.find((asset) => asset.kind === 'video');
      const sound = store.assets.find((asset) => asset.kind === 'audio');
      store.addAssetToTimeline(picture, store.project.tracks.find((track) => track.type === 'video' && track.order === 0).id, 0);
      window.__scfStore.getState().addAssetToTimeline(sound, store.project.tracks.find((track) => track.type === 'audio').id, 0);
      window.__scfStore.getState().selectClips([]);
    });
    await sleep(3000);

    /** Play the video for a few seconds and measure the gaps between displayed frames. */
    const cadence = () => window.evaluate(async () => {
      const store = window.__scfStore;
      const gaps = [];
      let last = 0;
      let sampling = true;
      const tick = (time) => {
        if (last) gaps.push(time - last);
        last = time;
        if (sampling) requestAnimationFrame(tick);
      };
      store.getState().setCurrentFrame(30);
      await new Promise((done) => setTimeout(done, 800));
      const from = store.getState().project.currentFrame;
      const began = performance.now();
      requestAnimationFrame(tick);
      store.getState().setPlaying(true);
      await new Promise((done) => setTimeout(done, 8000));
      store.getState().setPlaying(false);
      sampling = false;
      const played = store.getState().project.currentFrame - from;
      const elapsed = (performance.now() - began) / 1000;
      const sorted = [...gaps].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
      return {
        displayFrames: gaps.length,
        p50: q(50),
        p95: q(95),
        p99: q(99),
        worst: sorted[sorted.length - 1],
        // A gap longer than a frame of the video is a frame of it not shown on time.
        over33ms: gaps.filter((gap) => gap > 1000 / 30 + 1).length,
        over50ms: gaps.filter((gap) => gap > 50).length,
        // The playhead keeps the video's pace when it has advanced fps frames a second.
        playedFps: played / elapsed,
      };
    });

    const line = (name, c) => `${name}: ${c.displayFrames} display frames, p50 ${c.p50.toFixed(1)} ms, p95 ${c.p95.toFixed(1)} ms, p99 ${c.p99.toFixed(1)} ms, worst ${c.worst.toFixed(1)} ms, ${c.over33ms} over a video frame, ${c.over50ms} over 50 ms, playhead at ${c.playedFps.toFixed(2)} fps`;

    // Silent while it plays: somebody may be at this computer.
    const mute = (on) => window.evaluate((muted) => {
      const store = window.__scfStore.getState();
      for (const track of store.project.tracks) if (track.type === 'audio') store.updateTrack(track.id, { muted });
    }, on);

    await mute(true);
    report.cadence.idle = await cadence();
    report.cadence.idle2 = await cadence();
    console.log(line('playing, nothing else running', report.cadence.idle));
    console.log(line('playing, nothing else running (again)', report.cadence.idle2));
    await mute(false);

    for (const model of ['precise', 'fast']) {
      await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(0));
      const started = Date.now();
      // Started as the dialog starts it; the job reads the project now, unmuted.
      void window.evaluate((id) => { void window.__scfCaptions.job.getState().start({ language: 'es', source: 'mix', model: id, preset: 'classic' }); }, model);
      await window.waitForFunction(() => window.__scfCaptions.job.getState().phase !== 'idle', null, { timeout: 30_000 });
      const mixStarted = Date.now();
      await window.waitForFunction(() => window.__scfCaptions.job.getState().phase !== 'mixing', null, { timeout: 600_000 });
      const mixSeconds = (Date.now() - mixStarted) / 1000;
      await mute(true);
      const during = [];
      while ((await window.evaluate(() => window.__scfCaptions.job.getState().phase)) === 'transcribing' && during.length < 3) {
        during.push(await cadence());
        console.log(line(`playing while transcribing (${model})`, during[during.length - 1]));
        await sleep(2000);
      }
      await window.waitForFunction(() => window.__scfCaptions.job.getState().phase === 'idle', null, { timeout: 3_600_000 });
      await mute(false);
      const last = await window.evaluate(() => window.__scfCaptions.job.getState().last);
      const total = (Date.now() - started) / 1000;
      const captions = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.caption).length);
      report.models[model] = {
        totalSeconds: total,
        mixSeconds,
        transcribeSeconds: last?.result.elapsedSeconds,
        audioSeconds: last?.result.audioSeconds,
        timesRealTime: last ? last.result.audioSeconds / total : null,
        ran: last?.result.ran,
        gpu: last?.result.gpu,
        captions,
        words: last?.words,
      };
      report.cadence[model] = during;
      console.log(`${model}: ${seconds.toFixed(0)} s of speech -> ${captions} captions in ${total.toFixed(1)} s (mix ${mixSeconds.toFixed(1)} s, transcription ${last?.result.elapsedSeconds.toFixed(1)} s), ${(seconds / total).toFixed(1)}x real time, on the ${last?.result.ran}${last?.result.gpu ? ` (${last.result.gpu})` : ''}`);
      // The captions go, for the next model; not by undo, which would take the unmuting back first.
      await window.evaluate(() => {
        const store = window.__scfStore.getState();
        for (const track of store.project.tracks) if (track.type === 'captions') window.__scfStore.getState().removeTrack(track.id);
      });
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`report: ${join(workDir, 'report.json')}`);
  if (!existsSync(join(workDir, 'report.json'))) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
