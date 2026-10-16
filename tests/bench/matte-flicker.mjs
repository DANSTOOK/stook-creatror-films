import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { decodeMatteFrame, readMatteHeader, readMatteIndex } from '../../src/shared/matte/format.ts';
import { flickerRate, meanDifference, temporalChange } from '../../src/shared/matte/smoothing.ts';

/**
 * What the temporal smoothing of Remove background does, measured:
 * `node tests/bench/matte-flicker.mjs`
 *
 * The same stretches of footage are analysed in the real app twice, with the
 * smoothing (as shipped) and without it (SCF_MATTE_SMOOTHING=off, each run in
 * a profile of its own), and the two caches compared frame by frame:
 *
 *   - flicker:  the share of pixels that jump by more than a quarter of full
 *               scale away from both neighbours in the same direction - there
 *               for one frame and gone the next (shared/matte/smoothing.ts
 *               flickerRate). Steady movement does not count.
 *   - change:   the mean frame-to-frame change, flicker and movement together.
 *   - drift:    how far the smoothed mattes are from the model's own, on
 *               average: the price of the smoothing, which should be small.
 *
 * Needs Node 23.6 or later (it reads the cache with the app's own TypeScript),
 * and the models already downloaded and checked into MATTE_MODELS_DIR (the
 * app's own matte-models folder works: .bench-tmp/matte-run/models after the
 * in-app check). MATTE_SOURCE is the footage (default: the Kratos vs Thor
 * video in Downloads, only read); MATTE_STARTS the seconds to start at,
 * three seconds each; MATTE_ONLY=fast one model.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp', 'matte-flicker');
const modelsDir = process.env.MATTE_MODELS_DIR ?? join(projectRoot, '.bench-tmp', 'matte-run', 'models');
const source = process.env.MATTE_SOURCE ?? join(process.env.USERPROFILE ?? '', 'Downloads', 'KRATOS Vs THOR - Double DLSS 5 Epic Combat (RTX 5090 32GB) 4K DLAA.mp4');
const starts = (process.env.MATTE_STARTS ?? '765,285').split(',').map(Number);
const models = (process.env.MATTE_ONLY ?? 'precise,fast').split(',');
const SECONDS = 3;

if (!existsSync(source)) throw new Error(`No footage at ${source}: set MATTE_SOURCE`);

function readCache(file) {
  const bytes = new Uint8Array(readFileSync(file));
  const header = readMatteHeader(bytes.subarray(0, 64));
  if (!header) throw new Error(`not a matte file: ${file}`);
  const offsets = readMatteIndex(bytes.subarray(header.indexOffset), header.frames);
  const frames = [];
  for (let index = 0; index < header.frames; index += 1) {
    const pixels = new Uint8Array(header.width * header.height);
    if (!decodeMatteFrame(bytes.subarray(offsets[index], offsets[index + 1]), pixels)) throw new Error(`frame ${index} does not decode`);
    frames.push(pixels);
  }
  return frames;
}

/** Analyse every clip with every model in one app session; returns the cache folder. */
async function analyse(profile, clips, smoothing) {
  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_MATTE_MODELS_DIR: modelsDir,
      SCF_MATTE_SMOOTHING: smoothing ? 'on' : 'off',
    },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('#root > *', { timeout: 30_000 });
    await window.getByRole('button', { name: 'Blank project' }).click();
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
    }, clips);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction((count) => window.__scfStore.getState().assets.length === count, clips.length, { timeout: 60_000 });
    for (const model of models) {
      for (const clip of clips) {
        const started = Date.now();
        await window.evaluate(async ({ path, model }) => {
          const asset = window.__scfStore.getState().assets.find((candidate) => candidate.sourcePath === path);
          return window.filmora.mattesBuild({ path, model, width: asset.width, height: asset.height, fps: asset.sourceFps ?? 30, seconds: asset.durationSeconds ?? 0, still: false });
        }, { path: clip, model });
        console.log(`   ${smoothing ? 'smoothed' : 'raw     '} ${model} ${clip.split(/[\\/]/).pop()}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
      }
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  return join(profile, 'scf', 'mattes');
}

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
const clips = [];
for (const start of starts) {
  const clip = join(workDir, `clip-${start}.mp4`);
  await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-ss', String(start), '-i', source, '-t', String(SECONDS), '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', clip]);
  clips.push(clip);
}

console.log('1. analysing with and without the smoothing');
const smoothedDir = await analyse(join(workDir, 'profile-smoothed'), clips, true);
const rawDir = await analyse(join(workDir, 'profile-raw'), clips, false);

console.log('\n2. comparing');
const pct = (value) => `${(value * 100).toFixed(3)}%`;
const cacheFor = (dir, model, raw) => readdirSync(dir).filter((name) => name.includes(`-${model}-`) && name.endsWith(raw ? '-raw.scfmatte' : '.scfmatte') && (raw || !name.endsWith('-raw.scfmatte')));
for (const model of models) {
  const smoothedFiles = cacheFor(smoothedDir, model, false).sort();
  const rawFiles = cacheFor(rawDir, model, true).sort();
  // Both runs key the same files the same way, so the sorted names pair up.
  smoothedFiles.forEach((name, index) => {
    const smoothed = readCache(join(smoothedDir, name));
    const raw = readCache(join(rawDir, rawFiles[index]));
    const drift = smoothed.reduce((sum, frame, at) => sum + meanDifference(frame, raw[at]), 0) / smoothed.length;
    const before = flickerRate(raw);
    const after = flickerRate(smoothed);
    console.log(
      `   ${model} #${index + 1} (${smoothed.length} frames): flicker ${pct(before)} -> ${pct(after)} (${before > 0 ? `${((1 - after / before) * 100).toFixed(0)}% less` : 'none to remove'}), ` +
        `change ${pct(temporalChange(raw))} -> ${pct(temporalChange(smoothed))}, drift ${pct(drift)}`,
    );
  });
}
