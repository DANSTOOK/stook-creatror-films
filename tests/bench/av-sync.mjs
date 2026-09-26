import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Picture and sound in step, measured in the exported file: `node tests/bench/av-sync.mjs`
 *
 * Correlating the export's sound against the source's says where the sound
 * came from, not whether it lines up with the picture - and a source with odd
 * timestamps can make that comparison itself 30-80 ms off. This uses a source
 * whose sync is known by construction: a white flash and a 1 kHz beep start on
 * the same frame, every two seconds, on black and silence.
 *
 * The app cuts it (a piece removed, so later events move), exports it through
 * the real dialog, and the file is read back: for each flash, the frame it
 * lands on; for each beep, the sample its onset lands on. Their difference is
 * the sync error, event by event, with no reference decode in between.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp', 'av-sync');
const sourceFile = join(workDir, 'flash-beep.mp4');
const exportName = 'av-sync-export';

const FPS = 30;
const SECONDS = 40;
const PERIOD = 2;
/** One frame is the finest a picture can say; allow that, and no more. */
const LIMIT_MS = 1000 / FPS;

async function makeSource() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  // White for the first 3 frames of every PERIOD seconds, black otherwise; a
  // 1 kHz tone for the first 100 ms of every PERIOD seconds, silent otherwise.
  const flash = `color=c=black:size=640x360:rate=${FPS}:duration=${SECONDS},geq=lum='if(lt(mod(N\\,${FPS * PERIOD})\\,3)\\,235\\,16)':cb=128:cr=128`;
  const beep = `aevalsrc='if(lt(mod(t\\,${PERIOD})\\,0.1)\\,0.8*sin(2*PI*1000*t)\\,0)':s=48000:d=${SECONDS}`;
  await execFileAsync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', flash, '-f', 'lavfi', '-i', beep,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-shortest',
    sourceFile,
  ]);
}

/** Times, in seconds, of every frame that turns bright after a dark one. */
async function flashTimes(file) {
  const { stdout } = await execFileAsync(ffmpeg,
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  const size = 16 * 9;
  const times = [];
  let wasBright = false;
  for (let frame = 0; frame * size < stdout.length; frame += 1) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += stdout[frame * size + i];
    const bright = sum / size > 128;
    if (bright && !wasBright) times.push(frame / FPS);
    wasBright = bright;
  }
  return times;
}

/** Times, in seconds, where the sound rises out of silence. */
async function beepTimes(file) {
  const rate = 48000;
  const { stdout } = await execFileAsync(ffmpeg,
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'],
    { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
  const times = [];
  let silentRun = rate;
  for (let i = 0; i + 4 <= stdout.length; i += 4) {
    const loud = Math.abs(stdout.readFloatLE(i)) > 0.2;
    if (loud && silentRun >= rate * 0.5) times.push(i / 4 / rate);
    silentRun = loud ? 0 : silentRun + 1;
  }
  return times;
}

async function main() {
  await makeSource();
  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  // The source itself first: if its own flashes and beeps disagree, nothing
  // measured after the app could mean anything.
  const [sourceFlashes, sourceBeeps] = await Promise.all([flashTimes(sourceFile), beepTimes(sourceFile)]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1', SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });

  let passed = 0;
  let total = 0;
  const check = (name, ok, detail) => {
    total += 1;
    if (ok) passed += 1;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  };

  try {
    const window = await app.firstWindow();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, sourceFile);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.locator('li').filter({ hasText: 'flash-beep.mp4' }).first().waitFor({ timeout: 120_000 });

    // Put it on the timeline, then cut out 5.5 s to 9.5 s so everything after
    // moves: sync has to survive an edit, not just a straight copy.
    await window.evaluate(() => {
      const s = () => window.__scfStore.getState();
      const asset = s().assets[0];
      const track = s().project.tracks.find((t) => t.name === 'Video 1');
      const id = s().addAssetToTimeline(asset, track.id, 0);
      s().razorAtFrame(165, [id]);
      const right = Object.values(s().project.clips).find((c) => c.startFrame === 165);
      s().razorAtFrame(285, [right.id]);
      const middle = Object.values(s().project.clips).find((c) => c.startFrame === 165);
      s().removeClips([middle.id]);
    });

    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, workDir);
    await window.getByRole('button', { name: 'Export' }).click();
    const dialog = window.locator('div[role="dialog"]').first();
    await dialog.getByText('This render:').waitFor({ timeout: 60_000 });
    await dialog.getByLabel('File name').fill(exportName);
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await dialog.getByText('Will ', { exact: false }).first().waitFor({ timeout: 10_000 });
    const plan = await dialog.getByText('This render:').innerText();
    await dialog.getByRole('button', { name: 'Start export' }).click();
    const outcome = await window.getByText(/Export finished|Export failed/).first()
      .waitFor({ timeout: 300_000 })
      .then(() => window.getByText(/Export finished|Export failed/).first().innerText())
      .catch(() => 'timed out');
    check('the cut export finishes', outcome.startsWith('Export finished'), `${plan.trim()} - ${outcome.slice(0, 60)}`);
  } finally {
    await app.close().catch(() => undefined);
  }

  const exported = join(workDir, `${exportName}.mp4`);
  if (!(await stat(exported).catch(() => null))) {
    check('the exported file exists', false, exported);
  } else {
    const [flashes, beeps] = await Promise.all([flashTimes(exported), beepTimes(exported)]);
    const pair = (a, b) => a.map((time) => {
      const nearest = b.reduce((best, other) => (Math.abs(other - time) < Math.abs(best - time) ? other : best), Infinity);
      return { time, offsetMs: (nearest - time) * 1000 };
    });

    const sourcePairs = pair(sourceFlashes, sourceBeeps);
    const sourceWorst = Math.max(...sourcePairs.map((p) => Math.abs(p.offsetMs)));
    check('the source itself is in sync (the yardstick)', sourcePairs.length >= 15 && sourceWorst <= LIMIT_MS,
      `${sourcePairs.length} events, worst ${sourceWorst.toFixed(1)} ms`);

    const exportPairs = pair(flashes, beeps);
    const offsets = exportPairs.map((p) => p.offsetMs);
    const mean = offsets.reduce((a, b) => a + b, 0) / Math.max(1, offsets.length);
    const worst = Math.max(...offsets.map(Math.abs));
    console.log(`   events (flash s -> beep offset ms): ${exportPairs.map((p) => `${p.time.toFixed(2)}:${p.offsetMs.toFixed(0)}`).join('  ')}`);
    // 20 events in the source, two removed by the cut.
    check('every flash in the edit still has its beep', exportPairs.length === sourcePairs.length - 2 && beeps.length === flashes.length,
      `${flashes.length} flashes, ${beeps.length} beeps (source ${sourcePairs.length})`);
    check('sound and picture stay within a frame of each other through the cut', worst <= LIMIT_MS,
      `mean ${mean.toFixed(1)} ms (positive: sound late), worst ${worst.toFixed(1)} ms, limit ${LIMIT_MS.toFixed(1)} ms`);
  }

  console.log(`\n${passed}/${total} a/v sync checks passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
