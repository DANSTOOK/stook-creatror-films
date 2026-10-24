import { execFile, spawnSync } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * AAC priming and edit lists, end to end: `npm run test:bench:aac-priming`
 *
 * A flash and a noise burst start on the same instant every two seconds. The
 * source is written the ways ffmpeg writes an MP4 without an audio edit list
 * - fragmented, and with `-use_editlist 0` - where the priming frame sits at
 * zero and the first real frame is stamped where the first picture is; and
 * one whose sound starts half a second late, behind an empty edit. The app
 * used to drop one more frame than such a file declares, so its sound played
 * 23.2 ms ahead of the picture (the user's KRATOS vs THOR capture is written
 * the same way), and it ignored empty edits altogether.
 *
 * For each file:
 *  - the streamed reader (playback, scrubbing and the export mix all read
 *    through it) is compared with ffmpeg's decode of the source with every
 *    frame at its own timestamp, and must match to the sample;
 *  - the clip is exported through the real dialog and the file read back:
 *    each flash against its burst, within 2 ms of where ffmpeg has the pair
 *    in the source.
 * Noise rather than a tone, so a whole-period slip cannot look aligned.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp', 'aac-priming');

const FPS = 30;
const SECONDS = 12;
const PERIOD = 2;
/** Onset detection on AAC noise is good to about a millisecond. */
const LIMIT_MS = 2;

const flash = `color=c=black:size=320x180:rate=${FPS}:duration=${SECONDS},geq=lum='if(lt(mod(N\\,${FPS * PERIOD})\\,3)\\,235\\,16)':cb=128:cr=128`;
const burst = `aevalsrc='if(lt(mod(t\\,${PERIOD})\\,0.1)\\,0.8*(2*random(0)-1)\\,0)':s=44100:d=${SECONDS}`;

async function makeSources() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const encode = (name, extra) => execFileAsync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', flash, '-f', 'lavfi', '-i', burst,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    ...extra, join(workDir, name),
  ]);
  await encode('fragmented.mp4', ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']);
  await encode('no-editlist.mp4', ['-use_editlist', '0']);
  await encode('plain.mp4', []);
  // The sound half a second behind the picture, stream-copied: an empty edit.
  await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-i', join(workDir, 'plain.mp4'), '-itsoffset', '0.5', '-i', join(workDir, 'plain.mp4'),
    '-map', '0:v', '-map', '1:a', '-c', 'copy', join(workDir, 'late-sound.mp4')]);
  return ['fragmented.mp4', 'no-editlist.mp4', 'late-sound.mp4'].map((name) => join(workDir, name));
}

const floats = (buffer) => {
  const out = new Float32Array(buffer.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = buffer.readFloatLE(i * 4);
  return out;
};

/** ffmpeg's decode with every frame at its own pts (from ashowinfo), mono, native rate. */
function strictAudio(file) {
  const result = spawnSync(ffmpeg, ['-v', 'info', '-nostats', '-copyts', '-i', file, '-map', '0:a:0', '-af', 'ashowinfo', '-ac', '1', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28 });
  const data = floats(result.stdout);
  const frames = [...result.stderr.toString().matchAll(/ashowinfo[^\n]*? pts:(-?\d+) [^\n]*?rate:(\d+) nb_samples:(\d+)/g)]
    .map((m) => ({ pts: Number(m[1]), rate: Number(m[2]), n: Number(m[3]) }));
  const rate = frames[0].rate;
  const out = new Float32Array(Math.max(...frames.map((f) => f.pts + f.n)));
  let read = 0;
  for (const f of frames) {
    for (let i = 0; i < f.n; i += 1) if (f.pts + i >= 0) out[f.pts + i] = data[read + i];
    read += f.n;
  }
  return { data: out, rate };
}

/** Presentation times of frames that turn bright after a dark one. */
function flashTimes(file) {
  const result = spawnSync(ffmpeg, ['-v', 'info', '-nostats', '-copyts', '-i', file, '-map', '0:v:0',
    '-vf', 'scale=16:9,format=gray,showinfo', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const pts = [...result.stderr.toString().matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const times = [];
  let wasBright = false;
  for (let frame = 0; (frame + 1) * 144 <= result.stdout.length; frame += 1) {
    let sum = 0;
    for (let i = 0; i < 144; i += 1) sum += result.stdout[frame * 144 + i];
    const bright = sum / 144 > 128;
    if (bright && !wasBright) times.push(pts[frame]);
    wasBright = bright;
  }
  return times;
}

/** Seconds where sound rises out of half a second of silence. */
function onsets(data, rate) {
  const out = [];
  let quiet = rate;
  for (let i = 0; i < data.length; i += 1) {
    const loud = Math.abs(data[i]) > 0.05;
    if (loud && quiet >= rate / 2) out.push(i / rate);
    quiet = loud ? 0 : quiet + 1;
  }
  return out;
}

/**
 * Mean of (burst - flash) in ms, each flash paired with its nearest burst.
 * The event at zero is left out: there the priming frame and a picture
 * delayed by B-frames meet the start of the file, not each other.
 */
function syncMs(flashes, bursts) {
  const offsets = flashes.filter((f) => f > 1).map((f) => bursts.reduce((b, x) => (Math.abs(x - f) < Math.abs(b - f) ? x : b), Infinity) - f);
  return { mean: (offsets.reduce((a, b) => a + b, 0) / offsets.length) * 1000, count: offsets.filter(Number.isFinite).length };
}

/** Integer lag (samples) of `b` against `a` around `center`; positive = b late. */
function lagOf(a, b, center, from, length) {
  let best = { lag: 0, r: -Infinity };
  for (let lag = center - 2000; lag <= center + 2000; lag += 1) {
    let num = 0;
    let va = 0;
    let vb = 0;
    for (let i = from; i < from + length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= b.length || i >= a.length) continue;
      num += a[i] * b[j];
      va += a[i] * a[i];
      vb += b[j] * b[j];
    }
    const r = va && vb ? num / Math.sqrt(va * vb) : 0;
    if (r > best.r) best = { lag, r };
  }
  return best;
}

async function main() {
  const sources = await makeSources();
  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 });
  }

  let passed = 0;
  let total = 0;
  const check = (name, ok, detail) => {
    total += 1;
    if (ok) passed += 1;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  };

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1', SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });

  try {
    const window = await app.firstWindow();
    const blank = window.getByText('Blank project');
    if (await blank.count()) await blank.first().click({ force: true });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, sources);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction((n) => {
      const assets = window.__scfStore.getState().assets;
      return assets.length >= n && assets.every((a) => a.audioUri);
    }, sources.length, { timeout: 180_000 });

    for (const source of sources) {
      const name = source.split(/[\\/]/).pop();
      console.log(`\n${name}`);
      const reference = strictAudio(source);
      const flashes = flashTimes(source);
      const sourceSync = syncMs(flashes, onsets(reference.data, reference.rate));
      // The yardstick: ffmpeg has to see the source in sync (or, for the late
      // sound, half a second apart), or nothing below means anything.
      const intended = name === 'late-sound.mp4' ? 500 : 0;
      check('ffmpeg reads the source as written', flashes.length === SECONDS / PERIOD && Math.abs(sourceSync.mean - intended) <= LIMIT_MS,
        `${flashes.length} flashes, burst-minus-flash ${sourceSync.mean.toFixed(2)} ms, written as ${intended}`);

      const streamed = await window.evaluate(async ({ name, seconds }) => {
        const asset = window.__scfStore.getState().assets.find((a) => a.name === name);
        const stream = await window.__scfAudioStream.open(asset.audioUri);
        if (!stream) return null;
        const span = await stream.span(0, seconds);
        stream.close();
        return { samples: Array.from(span.planes[0]), rate: span.sampleRate };
      }, { name, seconds: SECONDS + 1 });
      if (!streamed) {
        check('the extracted sound streams', false, 'AudioStream.open returned null');
        continue;
      }
      const ours = Float32Array.from(streamed.samples);
      const coarse = Math.round(((onsets(ours, streamed.rate)[1] ?? 0) - (onsets(reference.data, reference.rate)[1] ?? 0)) * streamed.rate);
      const lag = lagOf(reference.data, ours, coarse, reference.rate, reference.rate * 8);
      check('the streamed sound sits where ffmpeg puts it, to the sample', lag.lag === 0 && lag.r > 0.95,
        `lag ${lag.lag} samples (positive: app late), r ${lag.r.toFixed(3)}`);

      // Export the clip alone, from its first frame.
      await window.evaluate((name) => {
        const s = () => window.__scfStore.getState();
        for (const id of Object.keys(s().project.clips)) s().removeClips([id]);
        const asset = s().assets.find((a) => a.name === name);
        const track = s().project.tracks.find((t) => t.name === 'Video 1');
        s().addAssetToTimeline(asset, track.id, 0);
      }, name);
      const exportName = `export-${name.replace('.mp4', '')}`;
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, workDir);
      await window.getByRole('button', { name: 'Export' }).click();
      const dialog = window.locator('div[role="dialog"]').first();
      // The hardware line is under More settings, folded until opened.
      const moreSettings = dialog.getByTestId('export-more');
      if ((await moreSettings.getAttribute('aria-expanded')) === 'false') await moreSettings.click();
      await dialog.getByText('This render:').waitFor({ timeout: 60_000 });
      await dialog.getByLabel('File name').fill(exportName);
      await dialog.getByRole('button', { name: 'Browse' }).click();
      await dialog.getByText('Will ', { exact: false }).first().waitFor({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Start export' }).click();
      const done = window.getByText(/Export finished|Export failed/).first();
      const outcome = await done.waitFor({ timeout: 300_000 }).then(() => done.innerText()).catch(() => 'timed out');
      await window.keyboard.press('Escape').catch(() => undefined);
      const exported = join(workDir, `${exportName}.mp4`);
      if (!outcome.startsWith('Export finished') || !(await stat(exported).catch(() => null))) {
        check('the export finishes', false, outcome.slice(0, 80));
        continue;
      }
      const out = strictAudio(exported);
      const outSync = syncMs(flashTimes(exported), onsets(out.data, out.rate));
      check('the export keeps picture and sound where the source has them', outSync.count === SECONDS / PERIOD - 1 && Math.abs(outSync.mean - sourceSync.mean) <= LIMIT_MS,
        `burst-minus-flash ${outSync.mean.toFixed(2)} ms in the export, ${sourceSync.mean.toFixed(2)} ms in the source`);
      await window.locator('div[role="dialog"]').first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    }
  } finally {
    await app.close().catch(() => undefined);
  }

  console.log(`\n${passed}/${total} aac priming checks passed`);
  process.exit(passed === total && total > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
