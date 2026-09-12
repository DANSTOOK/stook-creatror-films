import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Export speed benchmark: `BENCH_SOURCE=<video> electron tests/bench/run.mjs`
 *
 * Exports the whole of one real video twice - the old way (seek the video to
 * every frame) and the new way (decode it forwards once) - reports both
 * speeds, and checks that the fast export is the same picture as the old one
 * on every frame.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp');
const source = process.env.BENCH_SOURCE;
if (!source) throw new Error('set BENCH_SOURCE to a video file');

async function exportOnce(app, window, name, seekPath) {
  await window.evaluate((flag) => { window.__scfSeekExport = flag; }, seekPath);
  await window.getByRole('button', { name: 'Export' }).click();
  const dialog = window.locator('.panel').filter({ hasText: 'Target bitrate' }).first();
  await dialog.getByText('This render:').waitFor({ timeout: 60_000 });
  await dialog.getByLabel('File name').fill(name);
  await dialog.getByRole('button', { name: 'Browse' }).click();
  await dialog.getByText('Will ', { exact: false }).first().waitFor({ timeout: 10_000 });
  const frames = Number(await dialog.getByLabel('End frame').inputValue()) - Number(await dialog.getByLabel('Start frame').inputValue());
  const started = Date.now();
  await dialog.getByRole('button', { name: 'Start export' }).click();
  // Progress every 20 s, so a stall shows where it stopped.
  const ticker = setInterval(async () => {
    const text = await dialog.innerText().catch(() => '');
    const line = text.split('\n').filter((l) => /%|frame|Rendering|Encod|fps/i.test(l)).join(' | ');
    console.log(`   [${((Date.now() - started) / 1000).toFixed(0)} s] ${line.slice(0, 200)}`);
  }, 20_000);
  const result = await window.getByText(/Export finished|Export failed/).first()
    .waitFor({ timeout: 1_800_000 })
    .then(() => window.getByText(/Export finished|Export failed/).first().innerText())
    .finally(() => clearInterval(ticker));
  const seconds = (Date.now() - started) / 1000;
  await dialog.getByTitle('Close').click();
  return { ok: result.startsWith('Export finished'), result, seconds, frames };
}

/** Per-frame mean absolute difference between two videos, as grey 64x36 (0-255). */
async function frameDiffs(a, b) {
  const grab = async (file) => {
    const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0',
      '-vf', 'scale=64:36:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 30 });
    return stdout;
  };
  const [x, y] = await Promise.all([grab(a), grab(b)]);
  const size = 64 * 36;
  const count = Math.min(x.length, y.length) / size;
  const diffs = [];
  for (let f = 0; f < count; f += 1) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += Math.abs(x[f * size + i] - y[f * size + i]);
    diffs.push(sum / size);
  }
  return { diffs, framesA: x.length / size, framesB: y.length / size };
}

async function main() {
  // Only this run's own outputs. Wiping the whole directory deleted a source
  // video that had been put in there, and the run then imported a file that
  // no longer existed and waited for it to appear.
  await mkdir(workDir, { recursive: true });
  await Promise.all(
    ['fast.mp4', 'slow.mp4'].map((name) => rm(join(workDir, name), { force: true })),
  );

  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot });
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined },
  });

  let fast;
  let slow;
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning' || message.text().startsWith('[export]')) console.log(`   console.${message.type()}: ${message.text().slice(0, 300)}`);
    });
    window.on('pageerror', (error) => console.log(`   pageerror: ${error.message}`));
    await app.evaluate(({ dialog }, video) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
    }, source);
    await window.getByRole('button', { name: 'Import' }).click();
    const name = source.split(/[\\/]/).pop();
    await window.getByText(name, { exact: false }).first().waitFor({ timeout: 120_000 });
    const row = window.locator('li').filter({ hasText: name }).first();
    await row.hover();
    await row.getByTitle(/Add at the playhead/).click();
    await window.waitForTimeout(3000);

    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, workDir);

    fast = await exportOnce(app, window, 'fast', false);
    console.log(`decode forwards: ${fast.frames} frames in ${fast.seconds.toFixed(1)} s = ${(fast.frames / fast.seconds).toFixed(1)} fps  [${fast.result.slice(0, 60)}]`);
    if (!process.env.SKIP_SLOW) {
      slow = await exportOnce(app, window, 'slow', true);
      console.log(`seek per frame:  ${slow.frames} frames in ${slow.seconds.toFixed(1)} s = ${(slow.frames / slow.seconds).toFixed(1)} fps`);
      console.log(`speed-up: ${(slow.seconds / fast.seconds).toFixed(1)}x`);
    }
  } finally {
    await app.close().catch(() => undefined);
  }

  // Reference: ffmpeg's own decode of the source, at the project frame rate.
  // The seek path is the reference: it is what the frame-accuracy UI check
  // verifies. Both exports go through the same compositor and encoder, so
  // they must match picture for picture.
  if (!slow) process.exit(fast.ok ? 0 : 1);
  const { diffs, framesA, framesB } = await frameDiffs(join(workDir, 'fast.mp4'), join(workDir, 'slow.mp4'));
  const off = diffs.flatMap((d, i) => (d > 1.5 ? [i] : []));
  console.log(`decode forwards vs seek per frame: ${framesA} / ${framesB} frames, worst diff ${Math.max(...diffs).toFixed(2)}, frames that differ: ${off.length}${off.length ? ` e.g. ${off.slice(0, 12).join(',')}` : ''}`);
  process.exit(fast.ok && slow.ok && framesA === framesB && off.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
