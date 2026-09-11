import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Long-footage check: `npm run test:long`
 *
 * Real footage runs 40-50 minutes. Everything else in the suite uses clips of
 * a few seconds, which is how importing came to hold ~6 GB in EACH of two
 * processes for one 45-minute file without any test noticing. This imports a
 * 45-minute, ~2 GB recording into the real app and measures.
 *
 * The limits are generous on purpose - they catch a regression back to
 * reading whole files into memory (gigabytes), not the ordinary cost of
 * decoded audio (about 1 GB per 45 minutes of stereo, which is expected until
 * playback audio streams).
 *
 * The source is generated once and kept in .long-tmp, because producing 45
 * minutes of video takes a minute or two even with a hardware encoder.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.long-tmp');
const source = process.env.LONG_SOURCE ?? join(workDir, 'long45.mp4');

const MINUTES = 45;
const FPS = 30;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function ensureSource() {
  if (await stat(source).catch(() => null)) return;
  await mkdir(workDir, { recursive: true });
  console.log(`generating a ${MINUTES}-minute source (one-off)`);

  const input = [
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}:duration=${MINUTES * 60},noise=alls=12:allf=t`,
    '-f', 'lavfi', '-i', `anoisesrc=d=${MINUTES * 60}:c=pink:r=48000:a=0.3`,
  ];
  const output = ['-b:v', '6M', '-maxrate', '6M', '-bufsize', '12M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest', source];

  // NVENC when the machine has it (about a minute), x264 otherwise.
  await execFileAsync(ffmpeg, ['-v', 'error', '-y', ...input, '-c:v', 'h264_nvenc', ...output])
    .catch(() => execFileAsync(ffmpeg, ['-v', 'error', '-y', ...input, '-c:v', 'libx264', '-preset', 'ultrafast', ...output]));
}

async function main() {
  await ensureSource();
  const sizeGb = (await stat(source)).size / 1024 ** 3;
  console.log(`source: ${source} (${sizeGb.toFixed(2)} GB)`);

  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  const app = await electron.launch({
    // Own profile: runs beside an open copy of the app, never touches its settings.
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined },
  });

  const memory = async () => {
    const metrics = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((entry) => ({ type: entry.type, kb: entry.memory.workingSetSize })));
    const byType = {};
    for (const entry of metrics) byType[entry.type] = (byType[entry.type] ?? 0) + Math.round(entry.kb / 1024);
    return byType;
  };

  try {
    const window = await app.firstWindow();
    // For comparisons: run with the paused-preview forward decoder switched off.
    if (process.env.NO_SCRUB_DECODER) await window.evaluate(() => { window.__scfNoScrubDecoder = true; });
    await app.evaluate(({ dialog }, video) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
    }, source);

    // Sample memory throughout the import, not just after: the old path peaked
    // mid-import and settled afterwards, so an end-only reading hid most of it.
    let peakBrowser = 0;
    let peakTab = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const now = await memory().catch(() => ({}));
        peakBrowser = Math.max(peakBrowser, now.Browser ?? 0);
        peakTab = Math.max(peakTab, now.Tab ?? 0);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    const started = Date.now();
    await window.getByRole('button', { name: 'Import' }).click();
    const name = source.split(/[\\/]/).pop();
    await window.getByText(name, { exact: false }).first().waitFor({ state: 'visible', timeout: 300_000 });
    const importSeconds = (Date.now() - started) / 1000;

    const row = window.locator('li').filter({ hasText: name }).first();
    await row.hover();
    await row.getByTitle(/Add at the playhead/).click();
    await window.waitForTimeout(15_000); // Audio extraction, decode and waveform.
    sampling = false;
    await sampler;

    const settled = await memory();
    console.log(`   memory peak: main ${peakBrowser} MB, page ${peakTab} MB; settled: ${JSON.stringify(settled)}`);

    check('imports a 45-minute file in under 30 s', importSeconds < 30, `${importSeconds.toFixed(1)} s`);
    check('the main process never holds the file (peak < 600 MB)', peakBrowser < 600, `${peakBrowser} MB`);
    // The peak is the 45 minutes of audio decoded into one float32 AudioBuffer
    // (~1 GB, plus the decoder's working memory), and it swings between 1.5
    // and 2.2 GB from run to run. The limit is above that noise and far below
    // the ~6 GB of the old read-the-whole-file import, which is what it guards.
    check('the page never holds the file (peak < 2.5 GB, audio included)', peakTab < 2560, `${peakTab} MB`);

    const canvas = await window.evaluate(() => {
      const element = [...document.querySelectorAll('canvas')].at(-1);
      return { width: element.width / devicePixelRatio, view: element.parentElement.parentElement.parentElement.clientWidth };
    });
    check('the timeline canvas is the size of the view, not the footage',
      canvas.width <= canvas.view + 2, `${Math.round(canvas.width)} px canvas, ${canvas.view} px view`);

    // Adding the clip fits it: the scrollable width is then barely more than
    // the view (the project runs a second past the clip, plus a short tail).
    // Unfitted, 45 minutes at the default zoom is ~160,000 px of scroll.
    const scroll = await window.evaluate(() => {
      const container = [...document.querySelectorAll('canvas')].at(-1).parentElement.parentElement.parentElement;
      return { scrollWidth: container.scrollWidth, clientWidth: container.clientWidth };
    });
    await window.screenshot({ path: join(workDir, 'timeline.png') });
    check('the whole 45 minutes fits on screen after adding it',
      scroll.scrollWidth <= scroll.clientWidth * 1.15,
      `${scroll.scrollWidth} px of scroll for a ${scroll.clientWidth} px view`);

    // Export 10 s from minute 30, where a wrong-frame bug would show.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, workDir);
    await window.getByRole('button', { name: 'Export' }).click();
    const dialog = window.locator('.panel').filter({ hasText: 'Target bitrate' }).first();
    await dialog.getByText('This render:').waitFor({ timeout: 60_000 });
    await dialog.getByLabel('Start frame').fill(String(30 * 60 * FPS));
    await dialog.getByLabel('End frame').fill(String(30 * 60 * FPS + 10 * FPS));
    await dialog.getByLabel('File name').fill('long-export');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await dialog.getByText('Will ', { exact: false }).first().waitFor({ timeout: 10_000 });
    const exportStarted = Date.now();
    await dialog.getByRole('button', { name: 'Start export' }).click();
    const finished = await window.getByText(/Export finished|Export failed/).first()
      .waitFor({ timeout: 600_000 })
      .then(() => window.getByText(/Export finished|Export failed/).first().innerText())
      .catch(() => 'timed out');
    const exportSeconds = (Date.now() - exportStarted) / 1000;
    check('exports 10 s from the 30th minute', finished.startsWith('Export finished'),
      `${exportSeconds.toFixed(1)} s = ${((10 * FPS) / exportSeconds).toFixed(1)} fps`);
  } finally {
    await app.close().catch(() => undefined);
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} long-footage checks passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
