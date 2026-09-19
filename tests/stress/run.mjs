import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Stress test: an hour-long edit of real footage, exported and checked.
 *
 *   BENCH_SOURCE=<video> node tests/stress/run.mjs        (SKIP_BUILD=1 to reuse dist)
 *
 * Everything else in the suite edits a few seconds of test pattern. This takes
 * the user's own footage (19 minutes of game capture) and does what an editor
 * does to it over an afternoon, only more of it:
 *
 *  - imports it, and a folder of awkward stills (4K, odd sizes, 16 px, alpha,
 *    portrait) that becomes bins;
 *  - builds an EXACTLY one-hour timeline (108,000 frames at 30 fps): the
 *    footage three times, slides between, overlays with keyframes on top;
 *  - cuts it hundreds of times, deletes pieces with the magnet closing the
 *    holes, grades and animates, and checks the edit's invariants after every
 *    batch - no overlaps on a track, no clip reading past the end of its
 *    source, the hour still exactly an hour;
 *  - storms undo and redo and requires the project to come back EXACTLY;
 *  - scrubs across the whole hour, plays, saves, and reopens it in a new
 *    session;
 *  - starts an export and cancels it, then exports the full hour while
 *    sampling memory;
 *  - and then checks the FILE, not the app's opinion of it: duration, frame
 *    count, a clean decode end to end, pictures at random moments against the
 *    source frame they must be, slides against their image, the sound against
 *    the source sound, and silence where only stills play.
 *
 * Output goes to .stress-tmp, never next to the footage.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.stress-tmp');
const imagesDir = join(workDir, 'Stills');
// The target: an hour at 30 fps unless STRESS_FPS / STRESS_MINUTES say
// otherwise. HOUR_FRAMES is the target length whatever it is set to; every
// check below is written against it, not against "an hour".
const FPS = Number(process.env.STRESS_FPS ?? 30);
const MINUTES = Number(process.env.STRESS_MINUTES ?? 60);
const HOUR_FRAMES = Math.round(MINUTES * 60 * FPS);
const OUTPUT_NAME = MINUTES === 60 && FPS === 30 ? 'stress-1h' : `stress-${MINUTES}min-${FPS}fps`;
/** Real photos to cut in alongside the generated stills - copied, never modified. */
const PHOTOS_DIR = process.env.STRESS_PHOTOS ?? '';
let photoCount = 0;

const exportFile = join(workDir, `${OUTPUT_NAME}.mp4`);
const projectFile = join(workDir, `${OUTPUT_NAME}.scf`);
const reportFile = join(workDir, 'report.json');

const source = process.env.BENCH_SOURCE ?? '';
const SEED = Number(process.env.STRESS_SEED ?? 1789);

const report = { seed: SEED, checks: [], timings: {}, memory: {} };
const check = (name, passed, detail = '') => {
  report.checks.push({ name, passed, detail });
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const step = (text) => console.log(`\n== ${text}`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

const run = (args, options = {}) => execFileAsync(ffmpeg, args, { maxBuffer: 256 * 1024 * 1024, ...options });

/* Stills ------------------------------------------------------------------- */

async function makeStills() {
  await rm(workDir, { recursive: true, force: true });
  const slides = join(imagesDir, 'Slides');
  const overlays = join(imagesDir, 'Overlays');
  const awkward = join(imagesDir, 'Awkward');
  for (const dir of [slides, overlays, awkward]) await mkdir(dir, { recursive: true });

  const frame = (filter, file, extra = []) =>
    run(['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-frames:v', '1', ...extra, file]);

  // Slides at the project size, each different, so a wrong slide is visible.
  for (let i = 0; i < 12; i += 1) {
    await frame(`testsrc2=size=1280x720:rate=1,hue=h=${i * 30}`, join(slides, `slide-${String(i + 1).padStart(2, '0')}.png`));
  }
  // A logo with a soft alpha edge, for overlays.
  await frame('color=c=black:size=512x512,format=rgba', join(overlays, 'logo-alpha.png'),
    ['-vf', "geq=r='255':g='180':b='40':a='255*clip((200-hypot(X-256,Y-256))/12+0.5,0,1)'"]);
  // Sizes that break assumptions.
  await frame('testsrc2=size=3840x2160:rate=1', join(awkward, 'photo-4k.png'));
  await frame('testsrc2=size=2071x1301:rate=1', join(awkward, 'odd-2071x1301.png'));
  await frame('testsrc2=size=16x16:rate=1', join(awkward, 'tiny-16.png'));
  await frame('testsrc2=size=1080x1920:rate=1', join(awkward, 'portrait.jpg'));

  // Real photos, in a bin of their own. Copies: the originals stay as they are.
  if (PHOTOS_DIR) {
    const photos = join(imagesDir, 'Photos');
    await mkdir(photos, { recursive: true });
    const names = (await readdir(PHOTOS_DIR)).filter((name) => /\.(jpe?g|png|webp)$/i.test(name));
    for (const name of names) await copyFile(join(PHOTOS_DIR, name), join(photos, name));
    photoCount = names.length;
  }
}

/* The file itself ----------------------------------------------------------- */

async function probe(file) {
  const stderr = await run(['-hide_banner', '-i', file]).then(() => '', (error) => String(error.stderr ?? ''));
  const duration = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  return {
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    video: /Video: h264.*?(\d{3,5})x(\d{3,5}).*?(\d+(?:\.\d+)?) fps/s.exec(stderr)?.slice(1).map(Number) ?? null,
    audio: /Audio: aac/.test(stderr),
    raw: stderr,
  };
}

/**
 * Frames in the film, counted as packets without decoding. The bundled
 * ffmpeg prints no "frame=" progress when it is not on a terminal, so the
 * count comes from framemd5's one line per packet instead.
 */
async function countFrames(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framemd5', '-']);
    let count = 0;
    let tail = '';
    child.stdout.on('data', (chunk) => {
      const text = tail + chunk;
      const lines = text.split('\n');
      tail = lines.pop();
      for (const line of lines) if (line && !line.startsWith('#')) count += 1;
    });
    child.on('close', () => resolvePromise(count + (tail && !tail.startsWith('#') ? 1 : 0)));
  });
}

/**
 * The film's packet timestamps: how many durations differ from one frame, and
 * how far the last packet sits from where frame N-1 belongs. Made-up
 * timestamps once ran 1 tick short on four frames in ten - 36 ms over an hour.
 */
async function timestampDrift(file, fps) {
  return new Promise((resolvePromise) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framemd5', '-']);
    let tail = '';
    let timebase = null;
    let count = 0;
    let lastPts = 0;
    let uneven = 0;
    let expectedDuration = null;
    child.stdout.on('data', (chunk) => {
      const lines = (tail + chunk).split('\n');
      tail = lines.pop();
      for (const line of lines) {
        const tb = /^#tb 0: (\d+)\/(\d+)/.exec(line);
        if (tb) {
          timebase = { num: Number(tb[1]), den: Number(tb[2]) };
          expectedDuration = timebase.den / (timebase.num * fps);
          continue;
        }
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(',').map((part) => part.trim());
        lastPts = Number(parts[2]);
        if (Math.abs(Number(parts[3]) - expectedDuration) > 0.5) uneven += 1;
        count += 1;
      }
    });
    child.on('close', () => {
      const exactLast = (count - 1) * expectedDuration;
      resolvePromise({
        count,
        uneven,
        driftMs: timebase ? ((lastPts - exactLast) * timebase.num * 1000) / timebase.den : NaN,
      });
    });
  });
}

/**
 * Decode the film and the sound and collect what ffmpeg complains about.
 * Mapped explicitly: the cover image is a video stream too, and the null
 * muxer objects to its lone timestamp - a complaint about the check, not the file.
 */
async function decodeErrors(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-']);
    let errors = '';
    child.stderr.on('data', (chunk) => {
      if (errors.length < 20_000) errors += chunk;
    });
    child.on('close', () => resolvePromise(errors.trim()));
  });
}

/** One frame at `time` seconds, as small RGB. `-ss` before `-i` is frame-accurate when decoding. */
async function frameAt(file, time, size = '160x90') {
  const { stdout } = await execFileAsync(ffmpeg,
    ['-v', 'error', '-ss', time.toFixed(4), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${size}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
  return stdout;
}

const meanDiff = (a, b) => {
  const count = Math.min(a.length, b.length);
  if (count === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / count;
};

/**
 * Mono float audio for `[start, start + duration)`.
 *
 * Seeked AFTER `-i`, decoding from the top: an input-side seek into AAC lands
 * on a packet boundary near the time, not the time, and on the user's footage
 * that made the reference itself 30-80 ms off.
 */
async function audioAt(file, start, duration, rate = 8000, honourTimestamps = false) {
  // Honouring timestamps fills any gap in the source's audio with silence, the
  // way a player does; without it ffmpeg butts the packets together and every
  // sound after a gap reads early by the gap's length.
  const { stdout } = await execFileAsync(ffmpeg,
    ['-v', 'error', '-i', file, '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-vn',
      ...(honourTimestamps ? ['-af', 'aresample=async=1:first_pts=0'] : []),
      '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  const samples = new Float32Array(stdout.length / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = stdout.readFloatLE(i * 4);
  return samples;
}

const correlation = (a, b) => {
  const count = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < count; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= count;
  mb /= count;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < count; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va > 0 && vb > 0 ? num / Math.sqrt(va * vb) : 0;
};

const level = (samples) => {
  let sum = 0;
  for (const value of samples) sum += Math.abs(value);
  return sum / Math.max(1, samples.length);
};

/* In the page ----------------------------------------------------------------- */

/**
 * The invariants of an edit, checked against the store. Runs in the page.
 * Returns a list of broken rules, empty when the edit is sound.
 */
function pageInvariants() {
  const { project, assets } = window.__scfStore.getState();
  const problems = [];
  const byUri = new Map(assets.map((asset) => [asset.uri, asset]));
  const byTrack = new Map();
  let end = 0;

  for (const clip of Object.values(project.clips)) {
    if (!(clip.durationFrames > 0)) problems.push(`${clip.id} has duration ${clip.durationFrames}`);
    if (clip.startFrame < 0) problems.push(`${clip.id} starts at ${clip.startFrame}`);
    const asset = byUri.get(clip.sourceUri);
    if (!asset) problems.push(`${clip.id} points at no asset`);
    else if (asset.kind !== 'image' && clip.sourceOffsetFrames + clip.durationFrames > asset.durationFrames + 1) {
      problems.push(`${clip.id} reads to frame ${clip.sourceOffsetFrames + clip.durationFrames} of a ${asset.durationFrames}-frame source`);
    }
    end = Math.max(end, clip.startFrame + clip.durationFrames);
    if (!byTrack.has(clip.trackId)) byTrack.set(clip.trackId, []);
    byTrack.get(clip.trackId).push(clip);
  }

  for (const [trackId, clips] of byTrack) {
    if (!project.tracks.some((track) => track.id === trackId)) problems.push(`clips on a track that does not exist (${trackId})`);
    clips.sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < clips.length; i += 1) {
      const before = clips[i - 1];
      if (before.startFrame + before.durationFrames > clips[i].startFrame) {
        problems.push(`overlap on ${trackId}: ${before.id} ends at ${before.startFrame + before.durationFrames}, ${clips[i].id} starts at ${clips[i].startFrame}`);
      }
    }
  }
  if (project.durationFrames < end) problems.push(`project is ${project.durationFrames} frames but content runs to ${end}`);
  return { problems: problems.slice(0, 10), count: problems.length, end, clips: Object.keys(project.clips).length };
}

/** A comparable picture of the edit: clips, tracks, markers - not the playhead. */
function pageEditSignature() {
  const { project, bins, assets } = window.__scfStore.getState();
  const clips = Object.values(project.clips)
    .map((clip) => ({ ...clip }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    clips,
    tracks: project.tracks,
    markers: project.markers,
    duration: project.durationFrames,
    bins,
    placement: assets.map((asset) => [asset.id, asset.binId ?? null]),
  });
}

async function main() {
  if (!source) {
    console.error('Set BENCH_SOURCE to the video to stress with.');
    process.exit(1);
  }
  const started = Date.now();

  step('stills and build');
  await makeStills();
  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  const launch = () => electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });

  let app = await launch();
  const consoleIssues = [];
  let finalProject = null;
  let assetsByUri = null;

  const memory = async (application) => {
    const metrics = await application.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((entry) => ({ type: entry.type, kb: entry.memory.workingSetSize })));
    const byType = {};
    for (const entry of metrics) byType[entry.type] = (byType[entry.type] ?? 0) + Math.round(entry.kb / 1024);
    return byType;
  };

  try {
    let window = await app.firstWindow();
    window.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(`[${message.type()}] ${message.text()}`);
    });
    window.on('pageerror', (error) => consoleIssues.push(`[pageerror] ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(1600, 950);
      win.center();
    });
    await window.waitForSelector('#root > *', { timeout: 30_000 });

    const pick = (application, paths) => application.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: chosen });
    }, paths);

    /* Import ------------------------------------------------------------------ */
    step('import');
    let t = Date.now();
    await pick(app, [source]);
    await window.getByRole('button', { name: 'Import' }).click();
    const sourceName = source.split(/[\\/]/).pop();
    await window.locator('li').filter({ hasText: sourceName }).first().waitFor({ state: 'visible', timeout: 300_000 });
    report.timings.importFootage = Date.now() - t;
    check('the footage imports', true, seconds(report.timings.importFootage));

    t = Date.now();
    await window.getByRole('treeitem', { name: /^Master/ }).click().catch(() => undefined);
    await pick(app, [imagesDir]);
    await window.getByRole('button', { name: 'Add folder and subfolders' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.some((a) => a.name === 'portrait.jpg'), null, { timeout: 120_000 });
    const expectedStills = 17 + photoCount;
    await window.waitForFunction(
      (count) => window.__scfStore.getState().assets.filter((a) => a.kind === 'image').length >= count,
      expectedStills,
      { timeout: 120_000 },
    );
    report.timings.importStills = Date.now() - t;
    const library = await window.evaluate(() => {
      const { assets, bins, project } = window.__scfStore.getState();
      return {
        stills: assets.filter((a) => a.kind === 'image').map((a) => `${a.name} ${a.width}x${a.height}`),
        bins: bins.map((b) => b.name).sort(),
        project: `${project.width}x${project.height} @ ${project.fps}`,
      };
    });
    check(`${expectedStills} stills import into bins${photoCount ? ` (${photoCount} of them your own photos)` : ''}`,
      library.stills.length === expectedStills
      && ['Awkward', 'Overlays', 'Slides', 'Stills', ...(photoCount ? ['Photos'] : [])].every((name) => library.bins.includes(name)),
    `${library.stills.length} stills, bins [${library.bins.join(', ')}] in ${seconds(report.timings.importStills)}`);
    check('the project adopted the footage', library.project.startsWith('1280x720 @ '), library.project);
    // A delivery rate other than the footage's is picked first, before anything
    // is on the timeline - which is when an editor picks it.
    await window.evaluate((fps) => window.__scfStore.getState().setProjectSettings({ fps }, false), FPS);
    const rateNow = await window.evaluate(() => window.__scfStore.getState().project.fps);
    check(`the project delivers at ${FPS} fps`, rateNow === FPS, `${rateNow} fps`);

    /* An hour of edit ------------------------------------------------------------ */
    step(`building ${MINUTES} minutes at ${FPS} fps`);
    t = Date.now();
    const built = await window.evaluate(({ hour, seed, fps }) => {
      const store = window.__scfStore;
      const s = () => store.getState();
      let state = seed >>> 0;
      const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let x = state;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
      const pickInt = (min, max) => Math.floor(min + random() * (max - min + 1));

      const footage = s().assets.find((a) => a.kind === 'video');
      const slides = s().assets.filter((a) => /^slide-/.test(a.name)).sort((a, b) => a.name.localeCompare(b.name));
      const logo = s().assets.find((a) => a.name === 'logo-alpha.png');
      const awkward = s().assets.filter((a) => ['photo-4k.png', 'odd-2071x1301.png', 'tiny-16.png', 'portrait.jpg'].includes(a.name));
      const main = s().project.tracks.find((track) => track.name === 'Video 1');
      const top = s().project.tracks.find((track) => track.name === 'Video 2');
      const onMain = () => Object.values(s().project.clips).filter((c) => c.trackId === main.id).sort((a, b) => a.startFrame - b.startFrame);
      const mainEnd = () => onMain().reduce((end, c) => Math.max(end, c.startFrame + c.durationFrames), 0);
      const put = (asset, start) => s().addAssetToTimeline(asset, main.id, start);

      // Footage, slides, footage, slides, footage: then stills, cut, delete, refill.
      // No run of footage longer than a third of the target: at an hour the
      // 19 minutes of footage fit anyway, but at 5 minutes one run of it would
      // be the whole edit, and the slides and stills would all fall off the end.
      const segment = Math.floor(hour / 3);
      const putFootage = (start) => {
        const id = put(footage, start);
        const clip = id ? s().project.clips[id] : null;
        if (clip && clip.durationFrames > segment) s().trimClip(id, 'end', clip.startFrame + segment);
        return id;
      };
      putFootage(0);
      for (let i = 0; i < 6; i += 1) put(slides[i], mainEnd());
      putFootage(mainEnd());
      for (let i = 6; i < 12; i += 1) put(slides[i], mainEnd());
      for (const still of awkward) put(still, mainEnd());
      putFootage(mainEnd());

      // Hundreds of cuts at random places on the main track.
      let cuts = 0;
      for (let i = 0; i < 240; i += 1) {
        const at = pickInt(1, mainEnd() - 1);
        const inside = onMain().find((c) => c.startFrame < at && at < c.startFrame + c.durationFrames);
        if (!inside || at - inside.startFrame < 15 || inside.startFrame + inside.durationFrames - at < 15) continue;
        s().razorAtFrame(at, [inside.id]);
        cuts += 1;
      }

      // Delete short pieces; the magnet closes each hole.
      let deleted = 0;
      for (let i = 0; i < 40; i += 1) {
        const candidates = onMain().filter((c) => c.durationFrames < 900);
        if (candidates.length === 0) break;
        s().removeClips([candidates[pickInt(0, candidates.length - 1)].id]);
        deleted += 1;
      }

      // Refill to past the target, then end the whole edit on it exactly. For
      // a short target the footage alone overruns it, so everything that
      // starts after it goes and whatever spans it is trimmed to it - on every
      // track, not just the last clip of the main one.
      while (mainEnd() < hour) put(slides[pickInt(0, slides.length - 1)], mainEnd());
      const beyond = Object.values(s().project.clips).filter((c) => c.startFrame >= hour).map((c) => c.id);
      if (beyond.length) s().removeClips(beyond);
      for (const clip of Object.values(s().project.clips)) {
        if (clip.startFrame + clip.durationFrames > hour) s().trimClip(clip.id, 'end', hour);
      }

      // Grade and animate some of the footage.
      let graded = 0;
      for (const clip of onMain().filter((c) => c.sourceUri === footage.uri)) {
        if (random() < 0.3) {
          s().updateClip(clip.id, { colorGrading: { ...clip.colorGrading, enabled: true, saturation: 0.4, contrast: 1.2 } });
          graded += 1;
        } else if (random() < 0.2) {
          s().setVectorKeyframe(clip.id, 'scale', clip.startFrame, { x: 1, y: 1 });
          s().setVectorKeyframe(clip.id, 'scale', clip.startFrame + clip.durationFrames - 1, { x: 1.3, y: 1.3 });
          graded += 1;
        }
      }

      // Overlays on the top track, each with a moving, fading keyframed logo.
      let overlays = 0;
      // Forty an hour: at 5 minutes, forty of them plus the photos would cover
      // nearly the whole edit, leaving nothing uncovered to check the picture on.
      const overlayTotal = Math.max(4, Math.round((40 * hour) / (60 * 60 * fps)));
      for (let i = 0; i < overlayTotal; i += 1) {
        // Spread over the edit less one overlay's length, so the last one ends
        // inside it at any target, not only at an hour.
        const start = Math.floor((i + 0.5) * ((hour - 120) / overlayTotal));
        const id = s().addAssetToTimeline(logo, top.id, start);
        if (!id) continue;
        const clip = s().project.clips[id];
        s().trimClip(id, 'end', clip.startFrame + 120);
        s().setVectorKeyframe(id, 'position', clip.startFrame, { x: -400, y: -200 });
        s().setVectorKeyframe(id, 'position', clip.startFrame + 119, { x: 400, y: 200 });
        s().setNumberKeyframe(id, 'opacity', clip.startFrame, 0);
        s().setNumberKeyframe(id, 'opacity', clip.startFrame + 60, 1);
        overlays += 1;
      }

      // Your own photos on a track above everything, each one three times
      // through the edit, five seconds a time. Placed full frame; the phase
      // after this sizes and places them with the viewer's handles.
      const photoBin = s().bins.find((bin) => bin.name === 'Photos');
      const photos = photoBin ? s().assets.filter((a) => a.kind === 'image' && a.binId === photoBin.id) : [];
      const photoClips = [];
      let photoTrackId = null;
      if (photos.length) {
        s().addTrack('video');
        const videoTracks = s().project.tracks.filter((track) => track.type === 'video');
        photoTrackId = videoTracks.reduce((a, b) => (b.order > a.order ? b : a)).id;
        // Three times each where the edit is long enough; at least 15 s apart,
        // so every photo has a 10 s gap after it for the paste phase.
        const slots = Math.max(1, Math.min(photos.length * 3, Math.floor((hour - 10 * fps) / (15 * fps))));
        for (let i = 0; i < slots; i += 1) {
          const start = Math.floor(((i + 0.25) * (hour - 10 * fps)) / slots);
          const id = s().addAssetToTimeline(photos[i % photos.length], photoTrackId, start);
          if (!id) continue;
          s().trimClip(id, 'end', start + 5 * fps);
          photoClips.push(id);
        }
      }

      for (let i = 0; i < 60; i += 1) s().addMarker(Math.floor((i * hour) / 60) + 7, `M${i}`);
      return { cuts, deleted, graded, overlays, photoClips, photoTrackId, clips: Object.keys(s().project.clips).length };
    }, { hour: HOUR_FRAMES, seed: SEED, fps: FPS });
    report.timings.buildHour = Date.now() - t;
    const afterBuild = await window.evaluate(pageInvariants);
    check(`${MINUTES} minutes of heavy editing keeps every invariant${built.photoClips.length ? ` (${built.photoClips.length} photo clips)` : ''}`,
      afterBuild.count === 0 && afterBuild.end === HOUR_FRAMES,
      `${built.cuts} cuts, ${built.deleted} deletions, ${built.graded} graded/animated, ${built.overlays} overlays, ${afterBuild.clips} clips, ends at frame ${afterBuild.end} of ${HOUR_FRAMES}${afterBuild.count ? `; ${afterBuild.problems.join(' | ')}` : ''} - ${seconds(report.timings.buildHour)}`);

    /* Undo / redo storm ----------------------------------------------------------- */
    step('undo and redo storm');
    t = Date.now();
    const storm = await window.evaluate(({ seed, invariantsSource, signatureSource }) => {
      // eslint-disable-next-line no-new-func
      const invariants = new Function(`return (${invariantsSource})()`);
      // eslint-disable-next-line no-new-func
      const signature = new Function(`return (${signatureSource})()`);
      const store = window.__scfStore;
      const s = () => store.getState();
      let state = (seed * 7919) >>> 0;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const clipsNow = () => Object.values(s().project.clips);
      const history = window.__scfHistory;

      if (!history) return { error: 'the history store is not exposed as window.__scfHistory' };
      const before = signature();
      // The newest step before the storm. Its position cannot be used: the
      // history keeps 200 steps, and building the hour already filled it, so
      // the stack is as long after the storm as before.
      const baselineId = history.getState().peekUndo()?.id ?? null;
      let edits = 0;
      const broken = [];
      for (let i = 0; i < 150; i += 1) {
        const clips = clipsNow();
        const clip = clips[Math.floor(random() * clips.length)];
        const kind = Math.floor(random() * 6);
        if (kind === 0) s().razorAtFrame(clip.startFrame + Math.max(1, Math.floor(clip.durationFrames / 2)), [clip.id]);
        else if (kind === 1) s().updateClip(clip.id, { volume: Math.round(random() * 150) / 100 });
        else if (kind === 2) s().setNumberKeyframe(clip.id, 'rotation', clip.startFrame, Math.round(random() * 90));
        else if (kind === 3) s().trimClip(clip.id, 'end', clip.startFrame + Math.max(10, Math.floor(clip.durationFrames * 0.9)));
        else if (kind === 4) s().createBin(null, `Storm ${i}`);
        else s().addMarker(Math.floor(random() * s().project.durationFrames));
        edits += 1;
        if (i % 25 === 24) {
          const result = invariants();
          if (result.count) broken.push(`after ${i + 1} edits: ${result.problems[0]}`);
        }
      }
      const after = signature();

      const undoToBaseline = () => {
        let steps = 0;
        while (history.getState().canUndo && (history.getState().peekUndo()?.id ?? null) !== baselineId && steps < 400) {
          s().undo();
          steps += 1;
        }
        return steps;
      };

      const undos = undoToBaseline();
      const undone = signature();
      let redos = 0;
      while (history.getState().canRedo && redos < 400) {
        s().redo();
        redos += 1;
      }
      const redone = signature();
      // The storm's trims shortened the hour; everything after needs it whole.
      undoToBaseline();
      const settled = signature();
      return {
        edits, undos, redos, broken, historyVisible: true,
        backToStart: undone === before, backToEnd: redone === after, settledAtStart: settled === before,
      };
    }, { seed: SEED, invariantsSource: pageInvariants.toString(), signatureSource: pageEditSignature.toString() });
    report.timings.undoStorm = Date.now() - t;
    if (storm.error) check('the undo storm can reach the history', false, storm.error);
    check('150 mixed edits keep every invariant', !storm.error && storm.broken.length === 0, storm.broken?.[0] ?? `${storm.edits} edits`);
    check('undoing every step brings the project back exactly', Boolean(storm.backToStart) && storm.undos > 0, `${storm.undos} undos`);
    check('redoing every step brings the edit back exactly', Boolean(storm.backToEnd) && storm.redos === storm.undos,
      `${storm.redos} redos in ${seconds(report.timings.undoStorm)}`);
    check('undoing the storm again leaves the hour as it was built', Boolean(storm.settledAtStart), 'ready for the rest of the run');
    const afterStorm = await window.evaluate(pageInvariants);
    check('the hour is still exactly an hour after the storm', afterStorm.count === 0 && afterStorm.end === HOUR_FRAMES,
      afterStorm.count ? afterStorm.problems.join(' | ') : `ends at ${afterStorm.end}`);

    /* Your photos, sized and placed with the viewer's handles -------------------- */
    // Every photo clip is picked, then pulled in by its top-right corner (the
    // bottom-left stays put, proportions kept) and dragged by the picture to
    // one of nine places in the frame: real mouse drags on the real handles.
    const photoIds = built.photoClips ?? [];
    const readTransform = (clipId) => window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      if (!clip) return null;
      const last = (track, fallback) => (track.length ? track[track.length - 1].value : fallback);
      return { scale: last(clip.transform.scale, { x: 1, y: 1 }), position: last(clip.transform.position, { x: 0, y: 0 }) };
    }, clipId);
    if (photoIds.length) {
      step(`sizing and placing ${photoIds.length} photo clips by dragging them in the viewer`);
      t = Date.now();
      const dragProblems = [];
      const placedScales = [];
      for (let i = 0; i < photoIds.length; i += 1) {
        const id = photoIds[i];
        const onClip = await window.evaluate((clipId) => {
          const store = window.__scfStore.getState();
          const clip = store.project.clips[clipId];
          if (!clip) return false;
          store.setCurrentFrame(clip.startFrame + 12);
          store.setUi({ selectedClipIds: [clip.id], selectedTrackId: clip.trackId });
          return true;
        }, id);
        if (!onClip) { dragProblems.push(`${id}: gone`); continue; }
        const grip = window.getByTestId('viewport-handle-topRight');
        const shown = await grip.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
        if (!shown) { dragProblems.push(`${id}: no handles`); continue; }
        const frameBox = await window.locator('canvas').first().boundingBox();
        const gripBox = await grip.boundingBox();
        const shrink = 0.35 + ((i * 37) % 30) / 100;
        await window.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
        await window.mouse.down();
        await window.mouse.move(frameBox.x + frameBox.width * shrink, frameBox.y + frameBox.height * (1 - shrink), { steps: 6 });
        await window.mouse.up();
        const afterCorner = await readTransform(id);
        const column = i % 3;
        const row = Math.floor(i / 3) % 3;
        await window.mouse.move(frameBox.x + (frameBox.width * shrink) / 2, frameBox.y + frameBox.height * (1 - shrink / 2));
        await window.mouse.down();
        await window.mouse.move(frameBox.x + frameBox.width * (0.2 + column * 0.3), frameBox.y + frameBox.height * (0.25 + row * 0.25), { steps: 6 });
        await window.mouse.up();
        const result = await readTransform(id);
        const proportional = result && Math.abs(result.scale.x - result.scale.y) < 0.002;
        const nearAsked = result && Math.abs(result.scale.x - shrink) < 0.03;
        const moved = result && afterCorner
          && (Math.abs(result.position.x - afterCorner.position.x) > 1 || Math.abs(result.position.y - afterCorner.position.y) > 1);
        if (!proportional || !nearAsked || !moved) {
          dragProblems.push(`${i}: scale ${result?.scale.x.toFixed(3)}x${result?.scale.y.toFixed(3)} (asked ${shrink.toFixed(2)}), position ${result?.position.x.toFixed(0)},${result?.position.y.toFixed(0)}`);
        } else {
          placedScales.push(result.scale.x);
        }
      }
      report.timings.viewerDrags = Date.now() - t;
      check('every photo is sized and placed by dragging its handles in the viewer',
        dragProblems.length === 0 && placedScales.length === photoIds.length,
        dragProblems.length
          ? `${dragProblems.length} failed: ${dragProblems.slice(0, 3).join('; ')}`
          : `${placedScales.length} photos, scale ${Math.min(...placedScales).toFixed(2)}..${Math.max(...placedScales).toFixed(2)}, ${seconds(report.timings.viewerDrags)}`);

      /* Copy and paste --------------------------------------------------------- */
      // Six placed photos copied with Ctrl+C and pasted with Ctrl+V into the
      // gap after them on the same track: an editor reusing a shot they framed.
      step('copy and paste with the keyboard');
      t = Date.now();
      const pasteProblems = [];
      let pastes = 0;
      for (let i = 0; i < Math.min(6, photoIds.length); i += 1) {
        const id = photoIds[i * 3] ?? photoIds[i];
        const original = await readTransform(id);
        const target = await window.evaluate(({ clipId, fps }) => {
          const store = window.__scfStore.getState();
          const clip = store.project.clips[clipId];
          store.setUi({ selectedClipIds: [clip.id], selectedTrackId: clip.trackId });
          return clip.startFrame + clip.durationFrames + 2 * fps;
        }, { clipId: id, fps: FPS });
        await window.getByTestId('project-name').click();
        await window.keyboard.press('Control+c');
        await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), target);
        const before = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
        await window.keyboard.press('Control+v');
        const pasted = await window.evaluate(({ frame, trackId }) => {
          const { project, ui } = window.__scfStore.getState();
          const clip = project.clips[ui.selectedClipIds[0]];
          if (!clip) return null;
          const last = (track, fallback) => (track.length ? track[track.length - 1].value : fallback);
          return {
            count: Object.keys(project.clips).length,
            start: clip.startFrame,
            trackId: clip.trackId,
            scale: last(clip.transform.scale, { x: 1, y: 1 }),
            wanted: { frame, trackId },
          };
        }, { frame: target, trackId: built.photoTrackId });
        const ok = pasted && pasted.count === before + 1 && pasted.start === target && pasted.trackId === built.photoTrackId
          && Math.abs(pasted.scale.x - original.scale.x) < 0.001;
        if (ok) pastes += 1;
        else pasteProblems.push(`${i}: ${JSON.stringify(pasted)}`);
      }
      const afterPaste = await window.evaluate(pageInvariants);
      check('copying and pasting photos keeps their framing and every invariant',
        pastes === Math.min(6, photoIds.length) && afterPaste.count === 0 && afterPaste.end === HOUR_FRAMES,
        pasteProblems.length
          ? pasteProblems.slice(0, 2).join('; ')
          : `${pastes} pasted, each with its original's size; ends at ${afterPaste.end} (${seconds(Date.now() - t)})`);
    }

    /* The interface over an hour ---------------------------------------------------- */
    step('interface over the hour');
    await window.evaluate(() => window.__scfStore.getState().zoomToFit());
    await window.waitForTimeout(500);
    const ruler = await window.locator('canvas').last().boundingBox();
    t = Date.now();
    await window.mouse.move(ruler.x + 5, ruler.y + 3);
    await window.mouse.down();
    for (let i = 1; i <= 120; i += 1) {
      await window.mouse.move(ruler.x + 5 + (i / 120) * (ruler.width - 20), ruler.y + 3);
      await window.waitForTimeout(16);
    }
    await window.mouse.up();
    const scrubMs = Date.now() - t;
    const playheadAfterScrub = await window.evaluate(() => window.__scfStore.getState().project.currentFrame);
    check('scrubbing the whole hour keeps up with the hand', scrubMs < 12_000 && playheadAfterScrub > HOUR_FRAMES * 0.9,
      `120 moves in ${seconds(scrubMs)}, playhead at ${playheadAfterScrub}`);

    await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), 20 * 60 * FPS);
    await window.locator('canvas').last().click({ position: { x: 5, y: 200 } }).catch(() => undefined);
    const playFrom = await window.evaluate(() => window.__scfStore.getState().project.currentFrame);
    await window.evaluate(() => window.__scfStore.getState().setPlaying(true));
    await window.waitForTimeout(5000);
    await window.evaluate(() => window.__scfStore.getState().setPlaying(false));
    const playTo = await window.evaluate(() => window.__scfStore.getState().project.currentFrame);
    const played = playTo - playFrom;
    check('five seconds of playback in the middle of the hour advance about five seconds', played > 5 * FPS * 0.8 && played < 5 * FPS * 1.3,
      `${played} frames`);

    /* Save and reopen --------------------------------------------------------------- */
    step('save and reopen');
    const savedSignature = await window.evaluate(pageEditSignature);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, projectFile);
    await window.getByRole('button', { name: 'Save' }).click();
    await window.getByText('Saved to', { exact: false }).waitFor({ state: 'visible', timeout: 60_000 });
    const savedBytes = (await stat(projectFile)).size;
    report.memory.afterEdit = await memory(app);
    await app.close();

    app = await launch();
    window = await app.firstWindow();
    window.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(`[${message.type()}] ${message.text()}`);
    });
    window.on('pageerror', (error) => consoleIssues.push(`[pageerror] ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 950));
    await pick(app, [projectFile]);
    t = Date.now();
    await window.getByRole('button', { name: 'Open' }).click();
    await window.getByText('Opened', { exact: false }).first().waitFor({ state: 'visible', timeout: 300_000 });
    report.timings.reopen = Date.now() - t;
    const reopened = await window.evaluate(() => ({
      missing: window.__scfStore.getState().assets.filter((a) => a.missing).length,
      assets: window.__scfStore.getState().assets.length,
    }));
    const reopenedSignature = await window.evaluate(pageEditSignature);
    const strip = (text) => {
      // Session URLs change on reopen by design; compare everything else.
      const parsed = JSON.parse(text);
      for (const clip of parsed.clips) {
        delete clip.sourceUri;
        if (clip.colorGrading) delete clip.colorGrading.lutUri;
      }
      return JSON.stringify(parsed);
    };
    check('the hour reopens in a new session exactly as saved, every file found',
      reopened.missing === 0 && strip(reopenedSignature) === strip(savedSignature),
      `${(savedBytes / 1024).toFixed(0)} KB project, ${reopened.assets} assets, ${reopened.missing} missing, opened in ${seconds(report.timings.reopen)}`);

    /* Export --------------------------------------------------------------------------- */
    step('export: cancel, then the full hour');
    await pick(app, [workDir]);
    await window.getByRole('button', { name: 'Export' }).click();
    const dialog = window.locator('div[role="dialog"]').first();
    await dialog.getByText('This render:').waitFor({ timeout: 120_000 });
    await dialog.getByRole('button', { name: /^Project/ }).click();
    const endFrame = Number(await dialog.getByLabel('End frame').inputValue());
    check('the export range is the whole hour', endFrame === HOUR_FRAMES, `end frame ${endFrame}`);
    await dialog.getByLabel('File name').fill(OUTPUT_NAME);
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await dialog.getByText('Will ', { exact: false }).first().waitFor({ timeout: 10_000 });

    // Cancel a few percent in: the app must stop, say so, and be ready again.
    await dialog.getByRole('button', { name: 'Start export' }).click();
    await window.waitForFunction(() => /Rendering\s+([2-9]|\d\d)\.\d%/.test(document.body.innerText), null, { timeout: 300_000 });
    await dialog.getByRole('button', { name: 'Cancel render' }).click();
    const cancelled = await window.getByText('Export cancelled', { exact: false }).waitFor({ timeout: 60_000 })
      .then(() => true).catch(() => false);
    const readyAgain = await dialog.getByRole('button', { name: 'Start export' }).isEnabled().catch(() => false);
    check('cancelling a render stops it and leaves the dialog ready', cancelled && readyAgain, `cancelled ${cancelled}, ready ${readyAgain}`);

    finalProject = await window.evaluate(() => window.__scfStore.getState().project);
    assetsByUri = await window.evaluate(() => Object.fromEntries(window.__scfStore.getState().assets.map((a) => [a.uri, { name: a.name, kind: a.kind, sourcePath: a.sourcePath }])));

    let peak = {};
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const now = await memory(app).catch(() => ({}));
        for (const [type, mb] of Object.entries(now)) peak[type] = Math.max(peak[type] ?? 0, mb);
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    t = Date.now();
    await dialog.getByRole('button', { name: 'Start export' }).click();
    const outcome = await window.getByText(/Export finished|Export failed/).first()
      .waitFor({ timeout: 3 * 60 * 60 * 1000 })
      .then(() => window.getByText(/Export finished|Export failed/).first().innerText())
      .catch(() => 'timed out');
    report.timings.export = Date.now() - t;
    sampling = false;
    await sampler;
    report.memory.exportPeak = peak;
    const exportFps = HOUR_FRAMES / (report.timings.export / 1000);
    check('the full hour exports', outcome.startsWith('Export finished'),
      `${outcome.slice(0, 120)} - ${(report.timings.export / 60000).toFixed(1)} min, ${exportFps.toFixed(0)} fps`);
    check('memory stays bounded through an hour of rendering',
      (peak.Tab ?? 0) < 2500 && (peak.Browser ?? 0) < 1500,
      `peaks: page ${peak.Tab ?? '?'} MB, main ${peak.Browser ?? '?'} MB, GPU ${peak.GPU ?? '?'} MB`);
  } finally {
    await app.close().catch(() => undefined);
  }

  check('no errors or warnings in the app the whole time', consoleIssues.length === 0,
    consoleIssues.length ? `${consoleIssues.length}: ${consoleIssues.slice(0, 3).join(' | ')}` : 'clean');

  /* The file ------------------------------------------------------------------------- */
  if (!finalProject || !(await stat(exportFile).catch(() => null))) {
    check('the exported file exists', false, exportFile);
  } else {
    step('checking the file');
    const size = (await stat(exportFile)).size;
    const info = await probe(exportFile);
    check(`the file is ${MINUTES} minutes long`, info.seconds !== null && Math.abs(info.seconds - MINUTES * 60) < 0.5,
      `${info.seconds?.toFixed(2)} s, ${(size / 1024 ** 3).toFixed(2)} GB`);
    check(`1280x720 H.264 at ${FPS} fps with AAC sound`, Boolean(info.video) && info.video[0] === 1280 && info.video[1] === 720
      && Math.abs(info.video[2] - FPS) < 0.5 && info.audio, info.video ? `${info.video.join(' / ')}, audio ${info.audio}` : 'no video stream');

    let t = Date.now();
    const frames = await countFrames(exportFile);
    check(`every one of the ${HOUR_FRAMES.toLocaleString('en-US')} frames is in the file`, frames === HOUR_FRAMES, `${frames} frames (${seconds(Date.now() - t)})`);

    const drift = await timestampDrift(exportFile, FPS);
    check('every frame is stamped exactly one frame after the last, with no drift over the hour',
      drift.uneven === 0 && Math.abs(drift.driftMs) < 1000 / FPS / 2,
      `${drift.uneven} of ${drift.count} durations off by a tick or more; last frame ${drift.driftMs.toFixed(1)} ms from exact`);

    t = Date.now();
    const errors = await decodeErrors(exportFile);
    check('the whole hour decodes without an error', errors === '',
      errors === '' ? `clean (${seconds(Date.now() - t)})` : errors.split('\n').slice(0, 2).join(' | '));

    // Where the picture must be exactly one source frame: footage on the main
    // track, ungraded and unanimated, with nothing on the track above.
    const clips = Object.values(finalProject.clips);
    const top = finalProject.tracks.find((track) => track.name === 'Video 2');
    const main = finalProject.tracks.find((track) => track.name === 'Video 1');
    const aboveMain = new Set(finalProject.tracks.filter((track) => track.type !== 'audio' && track.id !== main.id).map((track) => track.id));
    const covered = (frame) => clips.some((c) => aboveMain.has(c.trackId) && c.startFrame <= frame && frame < c.startFrame + c.durationFrames);
    const plainFootage = clips.filter((c) => c.trackId === main.id && assetsByUri[c.sourceUri]?.kind === 'video'
      && !c.colorGrading.enabled && Object.values(c.transform).every((track) => !Array.isArray(track) || track.length === 0));
    // Untouched slides only: a rotated or graded one is not its image any more.
    const untouched = (c) => !c.colorGrading.enabled
      && Object.values(c.transform).every((track) => !Array.isArray(track) || track.length === 0);
    const slides = clips.filter((c) => c.trackId === main.id && /^slide-/.test(assetsByUri[c.sourceUri]?.name ?? '') && untouched(c));

    let state = SEED >>> 0;
    const random = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 4294967296;
    };

    const pictureSamples = [];
    for (let attempt = 0; attempt < 400 && pictureSamples.length < 24; attempt += 1) {
      const clip = plainFootage[Math.floor(random() * plainFootage.length)];
      if (!clip || clip.durationFrames < 60) continue;
      const frame = clip.startFrame + 15 + Math.floor(random() * (clip.durationFrames - 30));
      if (covered(frame)) continue;
      pictureSamples.push({ frame, sourceFrame: clip.sourceOffsetFrames + (frame - clip.startFrame) });
    }

    // Where the source's frame N really is. A file whose first frame is
    // stamped later than zero (the user's footage: 33 ms) shows frame N at
    // N/fps plus that, and a seek to N/fps alone lands one frame early - which
    // made correct exports look one frame out.
    const firstPacket = await execFileAsync(ffmpeg, ['-v', 'error', '-i', source, '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', 'framemd5', '-'], { maxBuffer: 1024 * 1024 });
    const timebase = /#tb 0: (\d+)\/(\d+)/.exec(firstPacket.stdout);
    const firstPts = firstPacket.stdout.split('\n').find((line) => /^0,/.test(line))?.split(',').map((part) => part.trim());
    const sourceStart = timebase && firstPts ? (Number(firstPts[2]) * Number(timebase[1])) / Number(timebase[2]) : 0;

    t = Date.now();
    const wrongPictures = [];
    const diffs = [];
    // Frame-exact on both sides. ffmpeg's input-side seek returns the first
    // frame stamped at or after the time asked for, so asking a hair BEFORE a
    // frame's own timestamp returns exactly that frame. Sampling mid-frame
    // instead read the NEXT frame on both sides - harmless while the source
    // and the project ran at the same rate (the shifts cancel), wrong one frame
    // in four at 30 fps footage in a 24 fps project.
    //
    // The expected picture is the one the app's own rule picks: the last
    // source frame stamped at or before the middle of the project frame,
    // found from the source's real timestamps rather than assumed from a rate.
    const EXACT = 0.002;
    const sourceStampsAround = async (seconds) => {
      const from = Math.max(0, seconds - 0.3);
      const { stderr } = await execFileAsync(ffmpeg, ['-hide_banner', '-copyts', '-ss', from.toFixed(4), '-i', source,
        '-to', (seconds + 0.3).toFixed(4), '-an', '-vf', 'showinfo', '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 });
      return [...String(stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
    };
    for (const sample of pictureSamples) {
      const target = (sample.sourceFrame + 0.5) / FPS;
      const stamps = await sourceStampsAround(target);
      let pick = -1;
      for (let i = 0; i < stamps.length; i += 1) if (stamps[i] <= target) pick = i;
      const exported = await frameAt(exportFile, Math.max(0, sample.frame / FPS - EXACT));
      const expected = pick >= 0 ? await frameAt(source, Math.max(0, stamps[pick] - EXACT)) : Buffer.alloc(0);
      const diff = meanDiff(exported, expected);
      diffs.push(diff);
      if (diff > 12) {
        const earlier = pick > 0 ? meanDiff(exported, await frameAt(source, stamps[pick - 1] - EXACT)) : Infinity;
        const later = pick >= 0 && pick + 1 < stamps.length ? meanDiff(exported, await frameAt(source, stamps[pick + 1] - EXACT)) : Infinity;
        wrongPictures.push(`${Math.floor(sample.frame / FPS / 60)}:${String(Math.floor(sample.frame / FPS) % 60).padStart(2, '0')} diff ${diff.toFixed(1)} (source -1: ${earlier.toFixed(1)}, +1: ${later.toFixed(1)})`);
      }
    }
    check('pictures at random moments in the hour are exactly the source frame they should be',
      pictureSamples.length >= 12 && wrongPictures.length === 0,
      wrongPictures.length
        ? `${wrongPictures.length}/${pictureSamples.length} wrong: ${wrongPictures.slice(0, 3).join('; ')}`
        : `${pictureSamples.length} moments, mean |diff| ${(diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length)).toFixed(1)}, worst ${Math.max(...diffs).toFixed(1)} (${seconds(Date.now() - t)})`);

    const wrongSlides = [];
    let slideChecks = 0;
    for (const clip of slides.slice(0, 8)) {
      const frame = clip.startFrame + Math.floor(clip.durationFrames / 2);
      if (covered(frame)) continue;
      const image = assetsByUri[clip.sourceUri];
      const exported = await frameAt(exportFile, frame / FPS);
      const expected = await frameAt(image.sourcePath, 0);
      const diff = meanDiff(exported, expected);
      slideChecks += 1;
      if (diff > 12) wrongSlides.push(`${image.name} at frame ${frame}: diff ${diff.toFixed(1)}`);
    }
    check('slides show their own image', slideChecks >= 3 && wrongSlides.length === 0,
      wrongSlides.length ? wrongSlides.slice(0, 3).join('; ') : `${slideChecks} slides checked`);

    // Sound: footage stretches must carry the source's own sound, in sync;
    // stills have none, so where only a slide plays it must be silent.
    // Candidates from all the untouched footage, every 4 s, in a seeded random
    // order so they spread over the edit. Taken from the picture samples, a
    // short edit left one or two - and a quiet one left nothing to judge.
    const soundSamples = [];
    for (const clip of plainFootage) {
      for (let at = clip.startFrame + FPS; at + 3 * FPS < clip.startFrame + clip.durationFrames; at += 4 * FPS) {
        soundSamples.push({ frame: at, sourceFrame: clip.sourceOffsetFrames + (at - clip.startFrame), order: random() });
      }
    }
    soundSamples.sort((a, b) => a.order - b.order);
    // Searched, not assumed: game sound decorrelates within milliseconds, so a
    // correct export compared at a fixed alignment reads as unrelated noise.
    // The source's own picture sits `sourceStart` after its sound, so in sync
    // means the best alignment lands within a frame of that.
    const searchShift = (exported, window, leadSeconds, rate = 8000) => {
      let best = { r: -1, shiftMs: 0 };
      for (let offset = 0; offset + exported.length <= window.length; offset += 4) {
        const r = correlation(exported, window.subarray(offset, offset + exported.length));
        if (r > best.r) best = { r, shiftMs: (offset / rate - leadSeconds) * 1000 };
      }
      return best;
    };
    // The reference honours the source's own audio timestamps (gaps filled),
    // on the same container clock as the pictures above: in sync means the
    // export's sound at N/fps is the source's sound at its N/fps, within a frame.
    // Two separate claims. SYNC: every stretch's best alignment within a frame.
    // IDENTITY: it is the source's sound at all. Game sound varies a lot over
    // two seconds, and correct stretches came out anywhere from r 0.65 to
    // 0.99 - but always at the same few ms, where a wrong sound lands near
    // r 0.05 at a random offset. So each stretch must clear 0.5 and the
    // typical one 0.8, rather than every one 0.8.
    const poorSound = [];
    const shifts = [];
    const correlations = [];
    // Judged only where the source has sound worth recognising (mean level
    // above 0.02, about -34 dB): near the noise floor a correct export still
    // correlates poorly, and says nothing either way. The same stretch twice
    // says nothing new either. Both are counted, not hidden.
    const AUDIBLE = 0.02;
    const heardAt = [];
    let quiet = 0;
    for (const sample of soundSamples) {
      if (correlations.length >= 8) break;
      if (heardAt.some((frame) => Math.abs(frame - sample.frame) < 5 * FPS)) continue;
      heardAt.push(sample.frame);
      const exported = await audioAt(exportFile, sample.frame / FPS, 2);
      const window = await audioAt(source, sample.sourceFrame / FPS - 0.15, 2.3, 8000, true);
      if (level(window) < AUDIBLE) {
        quiet += 1;
        continue;
      }
      const best = searchShift(exported, window, 0.15);
      shifts.push(best.shiftMs);
      correlations.push(best.r);
      if (!(best.r > 0.5) || Math.abs(best.shiftMs) > 1000 / FPS) {
        poorSound.push(`${(sample.frame / FPS / 60).toFixed(1)} min: r=${best.r.toFixed(2)} at ${best.shiftMs.toFixed(1)} ms`);
      }
    }
    const medianR = [...correlations].sort((a, b) => a - b)[Math.floor(correlations.length / 2)] ?? 0;
    check('the sound under the footage is the source sound, in sync with the picture',
      correlations.length >= (MINUTES >= 30 ? 4 : 2) && poorSound.length === 0 && medianR > 0.8,
      poorSound.length
        ? poorSound.slice(0, 3).join('; ')
        : `${correlations.length} stretches at ${Math.min(...shifts).toFixed(1)}..${Math.max(...shifts).toFixed(1)} ms (limit one frame, ${(1000 / FPS).toFixed(1)} ms); r ${Math.min(...correlations).toFixed(2)}..${Math.max(...correlations).toFixed(2)}, median ${medianR.toFixed(2)}${quiet ? `; ${quiet} too quiet to judge` : ''}`);

    const slideSilences = [];
    for (const clip of slides.slice(0, 4)) {
      if (clip.durationFrames < 2 * FPS) continue;
      const samples = await audioAt(exportFile, (clip.startFrame + 10) / FPS, 1);
      slideSilences.push(level(samples));
    }
    check('stills play in silence', slideSilences.length >= 2 && slideSilences.every((value) => value < 0.001),
      slideSilences.map((value) => value.toExponential(1)).join(', '));
  }

  report.timings.total = Date.now() - started;
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  const failures = report.checks.filter((entry) => !entry.passed).length;
  console.log(`\n${report.checks.length - failures}/${report.checks.length} stress checks passed in ${(report.timings.total / 60000).toFixed(1)} min`);
  console.log(`report: ${reportFile}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
