import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Detach audio and loop playback, in the running app:
 * `npm run test:audio-edit:ui` (SKIP_BUILD=1 to use the build already there).
 *
 * Every check is on what comes out, not only on the state:
 *
 *   1. detach audio from the timeline's right-click menu: the sound on an
 *      audio track at the same time and stretch, linked, one undo step. Then
 *      the sound itself, against the clip's own: the app's mix renderer
 *      before and after (the same samples), the master bus recorded while
 *      playing (lined up with the clip's sound to the millisecond, at the
 *      same level, the picture with no strip), and a real export decoded with
 *      ffmpeg (in step with the source file, at its level - heard once, not
 *      twice);
 *   2. drift: a sound moved 6 frames is measured 6 frames late in the mix and
 *      while playing (so the measures above cannot pass by accident), the red
 *      mark's menu puts it back, Edit > Rejoin audio, and Ctrl+Alt+S;
 *   3. loops: Ctrl+/, the bar on the ruler, the playhead sampled over time
 *      going round and round inside the loop, and the sound at the joins
 *      recorded off the master - no gap, no click, each time round exactly one
 *      loop after the last - for a whole buffer round the whole edit and a
 *      streamed sound round In to Out; the engine's strips stay few however
 *      many times it goes round;
 *   4. the timeline in a window of its own: the loop bar is drawn there, its
 *      key works there, and the loop goes round while it is out;
 *   5. a video with no sound (.bench-media/screencast95.mp4, or
 *      AUDIO_EDIT_SILENT=path): nothing to detach, and it says so; and, when
 *      AUDIO_EDIT_REAL names one, real footage with sound: detached, the mix is
 *      the same samples, in step with the file, and plays where it did;
 *   6. in Spanish: the menus and the message.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to AUDIO_EDIT_SHOTS;
 * AUDIO_EDIT_DUMP=1 keeps every recording, as JSON, in .ui-tmp/audio-edit.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'audio-edit');
const shotsDir = process.env.AUDIO_EDIT_SHOTS ?? '';
const silentFootage = process.env.AUDIO_EDIT_SILENT ?? join(projectRoot, '.bench-media', 'screencast95.mp4');
const realFootage = process.env.AUDIO_EDIT_REAL ?? '';
const W = 640;
const H = 360;
const FPS = 30;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const dB = (ratio) => 20 * Math.log10(ratio);

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** A file's sound, mono float, decoded with ffmpeg. */
async function decodeAudio(file, rate, seconds, from = 0) {
  const { stdout } = await execFileAsync(
    ffmpeg,
    ['-v', 'error', ...(from ? ['-ss', String(from)] : []), '-i', file, '-map', '0:a:0', ...(seconds ? ['-t', String(seconds)] : []), '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
}

const rmsOf = (samples, from = 0, count = samples.length - from) => {
  let sum = 0;
  let n = 0;
  for (let i = from; i < from + count && i < samples.length; i += 1) {
    const value = Number.isNaN(samples[i]) ? 0 : samples[i];
    sum += value * value;
    n += 1;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
};

/** Box-averaged by `factor`: a crude low-pass and decimation, for the coarse search. */
function decimate(samples, factor) {
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < factor; j += 1) {
      const value = samples[i * factor + j];
      sum += Number.isNaN(value) ? 0 : value;
    }
    out[i] = sum / factor;
  }
  return out;
}

/**
 * Normalised correlation of `b` against `a`, with `b` running `lag` samples
 * behind. 0 where the two overlap by less than half of `a`: a few samples
 * at an edge can agree by chance, and normalised they would score near 1.
 */
function correlationAt(a, b, lag) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  const start = Math.max(0, -lag);
  const end = Math.min(a.length, b.length - lag);
  if (end - start < a.length / 2) return 0;
  for (let i = start; i < end; i += 1) {
    const x = a[i];
    const y = b[i + lag];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * How many samples `b` runs behind `a` (negative: ahead), within `maxLag` of
 * `around`, and how alike the two are there (1 is the same signal). A coarse
 * search on decimated copies, then every sample around the best of it.
 */
function lagOf(a, b, maxLag, around = 0) {
  const factor = 12;
  const da = decimate(a, factor);
  const db = decimate(b, factor);
  let best = { lag: 0, score: -Infinity };
  const centre = Math.round(around / factor);
  const reach = Math.ceil(maxLag / factor);
  for (let lag = centre - reach; lag <= centre + reach; lag += 1) {
    const score = correlationAt(da, db, lag);
    if (score > best.score) best = { lag, score };
  }
  let fine = { lag: best.lag * factor, score: -Infinity };
  for (let lag = best.lag * factor - 2 * factor; lag <= best.lag * factor + 2 * factor; lag += 1) {
    const score = correlationAt(a, b, lag);
    if (score > fine.score) fine = { lag, score };
  }
  return fine;
}

/**
 * Record the master bus for `seconds` of playback (and `tailMs` after the stop).
 * With `raw` set, nothing is played: a sine of that frequency is started and
 * stopped on the master by hand, on whatever sample it has reached - the
 * click the measures below have to be able to see.
 *
 * In the page, an AnalyserNode hangs off the master - nothing in the graph the
 * editor hears is changed - and its last 32768 samples are copied every 40 ms.
 * Each copy overlaps the ones before it, and is placed against the one before
 * by the shift at which its first 4096 samples are the same. (A ScriptProcessor,
 * the first way this was recorded, runs on the page's thread and came back with
 * pieces missing at its block edges - steps in the recording that were never in
 * the sound. An AudioWorklet would be better still, but the page's CSP keeps
 * its module from loading.)
 *
 * Every sample of the recording is then the value most of the copies covering
 * it agree on - about fifteen of them. A copy does not always hold what the
 * master carried: measured on v1.42.0-beta.1, about one run in twelve has a
 * copy, or two in a row, whose newest 8 to 25 thousand samples disagree with
 * every other copy over the same stretch. Laid after the copy before, as they
 * used to be, those made steps of up to 34 times a tone's own largest - the
 * click reported in the In-to-Out loop, which was in the recording and not in
 * the sound. Outvoted, they are counted instead (`outvoted`). A sample no
 * majority agrees on, or no copy covered, is NaN and counted, never a gap
 * mistaken for the engine's.
 *
 * Alongside: probes for timing - every third copy while playing, its newest
 * 8192 samples with where the engine's clock said the playhead was at that
 * moment - the playhead itself, sampled on a timer every 20 ms, when it first
 * moved, and what the engine handed to the graph for each time round the loop.
 */
const RECORD = async ([seconds, tailMs = 0, raw = 0]) => {
  const engine = window.__scfAudioEngine();
  const context = engine.context;
  await context.resume();
  const rate = context.sampleRate;
  const SIZE = 32768;
  const analyser = context.createAnalyser();
  analyser.fftSize = SIZE;
  engine.master.connect(analyser);
  const schedule = [];
  // Each span as it is handed to the graph: its moment, and how late that was.
  const placeStreamSpan = engine.placeStreamSpan;
  engine.placeStreamSpan = function logged(project, span, pass, ...rest) {
    const now = this.context.currentTime;
    const when = this.startedAtContextTime + (span.atTimeline + this.passOffset(pass) - this.startedAtSeconds);
    schedule.push({ pass, at: span.atTimeline, seconds: span.seconds, when, lateBy: now - when });
    return placeStreamSpan.call(this, project, span, pass, ...rest);
  };
  const begins = [];
  const begin = engine.begin;
  engine.begin = function logged(...args) {
    if (this.waiting) begins.push(this.context.currentTime);
    return begin.apply(this, args);
  };
  let plays = 0;
  const playCalls = [];
  const play = engine.play;
  engine.play = function counted(...args) {
    plays += 1;
    playCalls.push(this.context.currentTime);
    return play.apply(this, args);
  };
  const frames = [];
  const copies = [];
  const began = performance.now();
  // And, while the sound runs (no loop), how far the picture is from it: the playhead's frame less the engine's clock.
  const drifts = [];
  const sampler = setInterval(() => {
    const { project } = window.__scfStore.getState();
    frames.push([performance.now() - began, project.currentFrame]);
    if (engine.playing && !engine.waiting && !engine.loopWindow) drifts.push(project.currentFrame / project.fps - engine.positionSeconds);
  }, 20);
  const copier = setInterval(() => {
    const data = new Float32Array(SIZE);
    analyser.getFloatTimeDomainData(data);
    copies.push({ time: context.currentTime, position: engine.playing && !engine.waiting ? engine.positionSeconds : null, data });
  }, 40);
  await new Promise((done) => setTimeout(done, 150));
  const startFrame = window.__scfStore.getState().project.currentFrame;
  let firstMove = null;
  const unsubscribe = window.__scfStore.subscribe((state) => {
    if (firstMove === null && state.project.currentFrame !== startFrame) firstMove = performance.now();
  });
  const pressedAt = performance.now();
  const pressCtx = context.currentTime;
  let bare = null;
  if (raw > 0) {
    const tone = context.createBuffer(1, Math.ceil(rate * (seconds + 1)), rate);
    const plane = tone.getChannelData(0);
    // From the crest: the worst sample to start on.
    for (let i = 0; i < plane.length; i += 1) plane[i] = 0.3 * Math.cos((2 * Math.PI * raw * i) / rate);
    bare = context.createBufferSource();
    bare.buffer = tone;
    bare.connect(engine.master);
    bare.start();
  } else window.__scfStore.getState().setPlaying(true);
  const playedAt = pressedAt - began;
  await new Promise((done) => setTimeout(done, seconds * 1000));
  // Built once, by the press: never again while it played.
  const replayed = plays > 1;
  const strips = engine.strips.size;
  const stripKeys = [...engine.strips.keys()];
  clearInterval(sampler);
  unsubscribe();
  const stopCtx = context.currentTime;
  if (bare) {
    // Stopped a little way into a wave, not on a zero crossing.
    bare.stop(context.currentTime + 0.37 / raw);
  } else window.__scfStore.getState().setPlaying(false);
  if (tailMs > 0) await new Promise((done) => setTimeout(done, tailMs));
  clearInterval(copier);
  engine.master.disconnect(analyser);
  delete engine.placeStreamSpan;
  delete engine.play;
  delete engine.begin;
  bare?.disconnect();

  // Where each copy starts, in samples. The analyser moves on a render quantum
  // (128 samples) at a time, so a copy is the one before moved on by some whole
  // number of quanta; the clock says roughly how many, and the samples say
  // exactly.
  const pos = [0];
  const segment = [0];
  let missing = 0;
  for (let index = 1; index < copies.length; index += 1) {
    const last = copies[index - 1].data;
    const next = copies[index].data;
    const estimate = (copies[index].time - copies[index - 1].time) * rate;
    const candidates = [];
    for (let shift = 0; shift <= SIZE - 4096; shift += 128) candidates.push(shift);
    candidates.sort((a, b) => Math.abs(a - estimate) - Math.abs(b - estimate));
    const shift = candidates.find((candidate) => {
      for (let i = 0; i < 4096; i += 1) if (next[i] !== last[i + candidate]) return false;
      return true;
    });
    if (shift === undefined) {
      // Too far apart to overlap: what came between is not known, and the
      // copies either side of it do not vote together.
      const gap = Math.max(1, Math.round(estimate) - SIZE);
      missing += gap;
      pos.push(pos[index - 1] + SIZE + gap);
      segment.push(segment[index - 1] + 1);
    } else {
      pos.push(pos[index - 1] + shift);
      segment.push(segment[index - 1]);
    }
  }
  const total = pos[pos.length - 1] + SIZE;
  const out = new Float32Array(total).fill(NaN);
  const outvoted = new Map();
  let undecided = 0;
  const values = [];
  const owners = [];
  let low = 0;
  for (let i = 0; i < total; i += 1) {
    while (low < copies.length && pos[low] + SIZE <= i) low += 1;
    values.length = 0;
    owners.length = 0;
    for (let k = low; k < copies.length && pos[k] <= i; k += 1) {
      // Only the newest stretch of copies placed by one chain of matches.
      if (owners.length > 0 && segment[k] !== segment[owners[0]]) {
        values.length = 0;
        owners.length = 0;
      }
      values.push(copies[k].data[i - pos[k]]);
      owners.push(k);
    }
    if (values.length === 0) continue;
    let same = true;
    for (let j = 1; j < values.length && same; j += 1) same = values[j] === values[0];
    if (same) {
      out[i] = values[0];
      continue;
    }
    let best = 0;
    let bestCount = 0;
    for (let j = 0; j < values.length; j += 1) {
      let count = 0;
      for (let m = 0; m < values.length; m += 1) if (values[m] === values[j]) count += 1;
      if (count > bestCount) {
        bestCount = count;
        best = j;
      }
    }
    if (bestCount * 2 <= values.length) {
      undecided += 1;
      continue;
    }
    out[i] = values[best];
    for (let j = 0; j < values.length; j += 1) {
      if (values[j] !== values[best]) outvoted.set(owners[j], (outvoted.get(owners[j]) ?? 0) + 1);
    }
  }
  missing += undecided;
  const playing = copies.filter((copy) => copy.position !== null);
  const probes = playing.filter((_, index) => index % 3 === 1).map((copy) => ({ position: copy.position, data: Array.from(copy.data.subarray(SIZE - 8192)) }));
  // The audio clock time of the newest sample, near enough: to place a step in the recording against the schedule.
  const endTime = copies[copies.length - 1].time;
  return {
    samples: Array.from(out), sampleRate: rate, endTime, playedAt, replayed, frames, schedule, missing, strips, stripKeys, probes,
    pressCtx, stopCtx, drifts, waitedMs: begins.length && playCalls.length ? (begins[0] - playCalls[0]) * 1000 : null, firstMoveMs: firstMove === null ? null : firstMove - pressedAt,
    outvoted: [...outvoted.entries()].map(([copy, count]) => ({ copy, count })),
  };
};

/**
 * The joins as scheduled: for each time round after the first, how far its
 * first span starts from where the round before ended (a hole if positive,
 * an overlap if negative), and how far apart the rounds start - in samples.
 */
function scheduledJoins(schedule, sampleRate) {
  const passes = new Map();
  for (const span of schedule) {
    const pass = passes.get(span.pass) ?? { first: Infinity, end: -Infinity };
    pass.first = Math.min(pass.first, span.when);
    pass.end = Math.max(pass.end, span.when + span.seconds);
    passes.set(span.pass, pass);
  }
  const holes = [];
  const starts = [];
  for (const [index, pass] of [...passes.entries()].sort((a, b) => a[0] - b[0])) {
    if (index > 0) starts.push(pass.first);
    const before = passes.get(index - 1);
    if (index > 0 && before) holes.push((pass.first - before.end) * sampleRate);
  }
  const intervals = starts.slice(1).map((start, index) => (start - starts[index]) * sampleRate);
  return { passes: passes.size, holes, intervals };
}

/**
 * What the joins sound like, from a recording of a steady tone: the longest
 * run of near-silence after the sound first starts (a gap, in samples) and the
 * biggest step between neighbouring samples against the tone's own biggest
 * step (a click).
 */
function analyseJoins(recorded, frequency, sampleRate) {
  let peak = 0;
  for (const value of recorded) if (!Number.isNaN(value)) peak = Math.max(peak, Math.abs(value));
  // A block the recorder missed reads as the tone's crest: it can neither
  // look like a gap nor make a step.
  const samples = recorded.map((value) => (Number.isNaN(value) ? peak : value));
  const filled = recorded.map((value) => Number.isNaN(value));
  const quiet = peak * 0.02;
  const first = samples.findIndex((value) => Math.abs(value) > peak * 0.5);
  let last = samples.length - 1;
  while (last > 0 && Math.abs(samples[last]) <= peak * 0.5) last -= 1;
  let longest = 0;
  let run = 0;
  for (let i = first; i <= last; i += 1) {
    if (Math.abs(samples[i]) < quiet) {
      run += 1;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  // A sine of this peak moves at most 2 sin(pi f / rate) times it from one
  // sample to the next; a click is a step bigger than that.
  const steepest = 2 * Math.sin((Math.PI * frequency) / sampleRate) * peak;
  let atJoin = 0;
  let atIndex = -1;
  for (let i = first + 1; i <= last; i += 1) {
    if (filled[i] || filled[i - 1]) continue;
    const step = Math.abs(samples[i] - samples[i - 1]);
    if (step > atJoin) {
      atJoin = step;
      atIndex = i;
    }
  }
  return { peak, longest, steepest, atJoin, atIndex };
}

/**
 * What the start and the stop of play sound like, from a recording of a steady
 * tone: when the sound first comes (on the audio clock, from the press), the
 * biggest step between neighbouring samples in its first 20 ms, while it
 * plays, and from the stop on - each against the tone's own biggest step.
 */
function startAndStop(recording, frequency) {
  const samples = recording.samples;
  const rate = recording.sampleRate;
  let peak = 0;
  for (const value of samples) if (!Number.isNaN(value)) peak = Math.max(peak, Math.abs(value));
  const steepest = 2 * Math.sin((Math.PI * frequency) / rate) * peak;
  const timeOf = (index) => recording.endTime - (samples.length - 1 - index) / rate;
  const indexAt = (time) => Math.round(samples.length - 1 - (recording.endTime - time) * rate);
  const onset = samples.findIndex((value) => !Number.isNaN(value) && Math.abs(value) > peak * 0.02);
  const stop = indexAt(recording.stopCtx);
  const steepestIn = (from, to) => {
    let most = 0;
    for (let i = Math.max(1, from); i < Math.min(samples.length, to); i += 1) {
      if (Number.isNaN(samples[i]) || Number.isNaN(samples[i - 1])) continue;
      most = Math.max(most, Math.abs(samples[i] - samples[i - 1]));
    }
    return most / steepest;
  };
  const twentyMs = Math.round(0.02 * rate);
  return {
    peak,
    onsetMs: onset >= 0 ? (timeOf(onset) - recording.pressCtx) * 1000 : NaN,
    start: onset >= 0 ? steepestIn(onset - 4, onset + twentyMs) : NaN,
    playing: onset >= 0 ? steepestIn(onset + twentyMs, stop - twentyMs / 2) : NaN,
    stop: steepestIn(stop - twentyMs / 2, samples.length),
  };
}

/** The playhead's trips round a loop: how many wraps, and the wall time between them. */
function wrapsOf(frames) {
  const at = [];
  for (let index = 1; index < frames.length; index += 1) if (frames[index][1] < frames[index - 1][1]) at.push(frames[index][0]);
  const periods = at.slice(1).map((time, index) => time - at[index]);
  return { wraps: at.length, periods };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};

async function main() {
  if (process.env.SKIP_BUILD !== '1') {
    console.log('building the app');
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 });
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const sync = join(workDir, 'sync.mp4');
  const take = join(workDir, 'take.mp4');
  const tone = join(workDir, 'tone.wav');
  const longTone = join(workDir, 'long-tone.mp4');
  // A 4-second shot whose sound is noise, which never repeats: there is
  // exactly one way to line it up with anything, so a lag measured against it
  // is a lag, not a whole number of periods of a tone, and a sixth of a
  // second of it is enough to find where it is.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=4`, '-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:r=48000:a=0.5:seed=7',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-shortest', sync]);
  // A shot with a steady 440 Hz at -6 dBFS, for the joins of a streamed sound.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=4`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-filter:a', 'volume=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-shortest', take]);
  // 441 Hz for 6 s: a 2.5 s loop of it is 1102.5 cycles, so the join butts a
  // crest against a trough - the worst case for a click.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=441:sample_rate=48000:duration=6', '-filter:a', 'volume=0.5', '-c:a', 'pcm_s16le', tone]);
  // Three minutes of a steady 440 Hz under a small picture, for the start of play: long enough that
  // every start can be far from the last, which makes the decoder start again.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=180', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=180',
    '-filter:a', 'volume=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '192k', '-shortest', longTone]);
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });
  const withSilent = existsSync(silentFootage);
  const withReal = realFootage !== '' && existsSync(realFootage);
  const files = [sync, take, tone, longTone, ...(withSilent ? [silentFootage] : [])];

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  console.log(`   launched, pid ${app.process().pid}`);
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await window.waitForSelector('#root > *', { timeout: 30_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, files);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction((count) => window.__scfStore.getState().assets.length === count, files.length, { timeout: 180_000 });
    await window.evaluate(([w, h, fps]) => window.__scfStore.getState().setProjectSettings({ width: w, height: h, fps }), [W, H, FPS]);
    // The sound of every file decoded (or opened for streaming) before anything is played.
    await window.waitForFunction(() => {
      const engine = window.__scfAudioEngine();
      // A silent video has no sound to wait for: nothing was pulled out of it.
      return engine && window.__scfStore.getState().assets.every((asset) => (asset.kind !== 'audio' && !asset.audioUri) || engine.hasAudio(asset.uri));
    }, null, { timeout: 180_000 });
    const rate = await window.evaluate(() => window.__scfAudioEngine().context.sampleRate);
    console.log(`   the audio context runs at ${rate} Hz`);

    const store = (fn, arg) => window.evaluate(fn, arg);
    const depth = () => store(() => window.__scfHistory.getState().undoStack.length);
    /** One clip of the named file at `at` on the first track of that kind; returns its id. */
    const place = (name, kind, at, extra = {}) => store(([fileName, trackKind, frame, patch]) => {
      const s = window.__scfStore.getState();
      const asset = s.assets.find((candidate) => candidate.name === fileName);
      const track = s.project.tracks.find((candidate) => candidate.type === trackKind && (trackKind !== 'video' || candidate.order === 0));
      const id = s.addAssetToTimeline(asset, track.id, frame);
      if (Object.keys(patch).length) window.__scfStore.getState().updateClip(id, patch);
      window.__scfStore.getState().selectClips([]);
      return id;
    }, [name, kind, at, extra]);
    const clear = () => store(() => {
      const s = window.__scfStore.getState();
      s.setPlaying(false);
      s.removeClips(Object.keys(s.project.clips));
      s.setUi({ inFrame: null, outFrame: null, loopPlayback: false, selectedClipIds: [], pixelsPerFrame: 2, scrollLeftPx: 0 });
      s.setCurrentFrame(0);
    });
    const surface = window.getByTestId('timeline-canvas');
    /** Where a clip is on the canvas, for the pointer. */
    const clipPoint = async (id, along = 0.5) => {
      const box = await surface.boundingBox();
      const spot = await store(([clipId, fraction]) => {
        const { project, ui } = window.__scfStore.getState();
        const clip = project.clips[clipId];
        const visual = project.tracks.filter((t) => t.type !== 'audio').sort((a, b) => b.order - a.order);
        const audio = project.tracks.filter((t) => t.type === 'audio').sort((a, b) => a.order - b.order);
        const row = [...visual, ...audio].findIndex((t) => t.id === clip.trackId);
        return { x: (clip.startFrame + clip.durationFrames * fraction) * ui.pixelsPerFrame - ui.scrollLeftPx, y: 24 + row * 58 + 28 };
      }, [id, along]);
      return { x: box.x + spot.x, y: box.y + spot.y };
    };
    /** The timeline's sound from `from` to `to` (frames), mono, as the export renders it. */
    const mixOf = (from, to) => store(async ([start, end, sampleRate]) => {
      const s = window.__scfStore.getState();
      const mix = await window.__scfMix.renderTimelineAudio(s.project, s.assets, start, end, { sampleRate, channels: 1 });
      if (!mix) return [];
      const view = new DataView(mix.wav);
      let at = 12;
      let data = -1;
      let size = 0;
      let bits = 32;
      while (at < view.byteLength - 8) {
        const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
        const length = view.getUint32(at + 4, true);
        if (id === 'fmt ') bits = view.getUint16(at + 22, true);
        if (id === 'data') {
          data = at + 8;
          size = length;
          break;
        }
        at += 8 + length;
      }
      const count = size / (bits / 8);
      const out = new Array(count);
      for (let i = 0; i < count; i += 1) out[i] = bits === 32 ? view.getFloat32(data + i * 4, true) : view.getInt16(data + i * 2, true) / 32768;
      return out;
    }, [from, to, rate]).then((samples) => Float32Array.from(samples));
    const maxDifference = (a, b) => {
      if (a.length !== b.length || a.length === 0) return Infinity;
      let max = 0;
      for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i] - b[i]));
      return max;
    };
    /**
     * Play the edit from frame 0 for `seconds`, recording the master, and say
     * how far the sound heard is from where the engine's clock put the
     * playhead: for each probe, where its samples sit in the reference mix (by
     * correlation) less where the clock said the playhead was when it was
     * copied. That includes how far the analyser's newest sample trails the
     * clock, which is the same every time, so two recordings are compared with
     * each other, never one with zero. The median over the probes, so a copy
     * taken halfway through an audio callback does not decide it.
     */
    const playAgainst = async (reference, seconds) => {
      await store(() => window.__scfStore.getState().setCurrentFrame(0));
      await sleep(300);
      const recording = await store(RECORD, [seconds]);
      if (process.env.AUDIO_EDIT_DUMP) await writeFile(join(workDir, `play-${Date.now()}.json`), JSON.stringify(recording));
      const samples = Float32Array.from(recording.samples);
      const offsets = [];
      const scores = [];
      for (const probe of recording.probes) {
        const data = Float32Array.from(probe.data);
        // Only copies that are all sound: one reaching back before the start is mostly silence.
        if (probe.position * recording.sampleRate < data.length + 0.05 * recording.sampleRate) continue;
        const expected = Math.round(probe.position * recording.sampleRate) - data.length;
        const found = lagOf(data, reference, Math.round(0.3 * recording.sampleRate), expected);
        scores.push(found.score);
        if (found.score > 0.9) offsets.push(found.lag - expected);
      }
      const level = rmsOf(samples.filter((value) => !Number.isNaN(value)));
      return {
        ...recording,
        samples,
        offset: median(offsets),
        spread: offsets.length ? Math.max(...offsets) - Math.min(...offsets) : NaN,
        matched: offsets.length,
        score: median(scores),
        level,
      };
    };
    const describePlay = (label, played) =>
      `      ${label}: ${played.samples.length} samples recorded (${played.missing} missed), ${played.matched} of ${played.probes.length} probes matched (median ${played.score.toFixed(3)}), offset ${played.offset} samples (spread ${played.spread}), replayed ${played.replayed}`;

    console.log('1. detach audio: the sound in step, heard once');
    await clear();
    const picture = await place('sync.mp4', 'video', 0);
    const mixBefore = await mixOf(0, 120);
    const playedBefore = await playAgainst(mixBefore, 2.6);
    console.log(describePlay('before', playedBefore));

    // Right-click the clip: Detach audio.
    const start = await depth();
    const at = await clipPoint(picture);
    await window.mouse.click(at.x, at.y, { button: 'right' });
    await window.getByRole('menuitem', { name: 'Detach audio' }).click();
    await sleep(300);
    const after = await store((id) => {
      const { project, ui } = window.__scfStore.getState();
      const pictureClip = project.clips[id];
      const sound = Object.values(project.clips).find((clip) => clip.audioOnly);
      const track = project.tracks.find((candidate) => candidate.id === sound?.trackId);
      return {
        picture: { detached: pictureClip.audioDetached, group: pictureClip.linkGroup, span: [pictureClip.startFrame, pictureClip.durationFrames, pictureClip.sourceOffsetFrames] },
        sound: sound && { id: sound.id, track: track?.type, group: sound.linkGroup, span: [sound.startFrame, sound.durationFrames, sound.sourceOffsetFrames], uri: sound.sourceUri === pictureClip.sourceUri },
        selected: ui.selectedClipIds.length,
        waveform: Boolean(window.__scfMediaStore.getState().waveforms[pictureClip.sourceUri]),
      };
    }, picture);
    check('right-click > Detach audio puts the sound on an audio track, same time, stretch and file, linked, one undo step',
      after.sound?.track === 'audio' && JSON.stringify(after.sound.span) === JSON.stringify(after.picture.span) && after.sound.uri
        && after.picture.detached === true && after.sound.group === after.picture.group && Boolean(after.picture.group)
        && (await depth()) === start + 1 && after.selected === 2,
      JSON.stringify(after));
    check('the sound clip has a waveform to draw (the file\'s peaks, by its URI)', after.waveform);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'detach-en.png') });

    const mixDetached = await mixOf(0, 120);
    const mixLag = lagOf(mixBefore, mixDetached, rate);
    check('the app\'s mix renderer: detached, the edit sounds the same samples as before (heard once, in step)',
      mixBefore.length > rate && rmsOf(mixBefore) > 0.02 && maxDifference(mixBefore, mixDetached) < 1e-4 && mixLag.lag === 0,
      `${mixBefore.length} samples, before ${rmsOf(mixBefore).toFixed(4)} RMS, after ${rmsOf(mixDetached).toFixed(4)} RMS (${dB(rmsOf(mixDetached) / rmsOf(mixBefore)).toFixed(3)} dB; twice would be +6.02), largest difference ${maxDifference(mixBefore, mixDetached).toExponential(2)}, lag ${mixLag.lag} samples`);

    const playedAfter = await playAgainst(mixBefore, 2.6);
    console.log(describePlay('after', playedAfter));
    check('playing, the master is the clip\'s sound in step: lined up with it as the undetached clip was, to 1 ms',
      !playedBefore.replayed && !playedAfter.replayed && playedBefore.matched >= 10 && playedAfter.matched >= 10
        && Math.abs(playedAfter.offset - playedBefore.offset) <= rate / 1000,
      `offset from the engine's clock ${playedBefore.offset} samples before, ${playedAfter.offset} after (${(((playedAfter.offset - playedBefore.offset) / rate) * 1000).toFixed(2)} ms apart); ${playedBefore.matched} and ${playedAfter.matched} probes`);
    check('and at the same level, with a strip for the sound clip and none for the silent picture',
      Math.abs(dB(playedAfter.level / playedBefore.level)) < 0.5 && playedAfter.stripKeys.includes(after.sound.id) && !playedAfter.stripKeys.includes(picture),
      `before ${playedBefore.level.toFixed(4)}, after ${playedAfter.level.toFixed(4)} RMS (${dB(playedAfter.level / playedBefore.level).toFixed(2)} dB); strips ${JSON.stringify(playedAfter.stripKeys)}`);

    // A real export, decoded: the sound once, at its own level, in step with the file.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, exportDir);
    await store(() => window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', exportAlpha: false }));
    await window.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = window.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByLabel('Start frame').fill('0');
    await dialog.getByLabel('End frame').fill('120');
    await dialog.getByLabel('File name').fill('detached');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);
    await dialog.getByRole('button', { name: 'Start export' }).click();
    await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 180_000 });
    await dialog.getByTitle('Close').click();
    await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    const exportedName = (await readdir(exportDir)).find((name) => name.startsWith('detached'));
    const exported = await decodeAudio(join(exportDir, exportedName), 48000);
    const source = await decodeAudio(sync, 48000);
    const exportLag = lagOf(source, exported, 24000);
    // The middle two seconds, away from the edges' fades and codec padding.
    const exportedLevel = rmsOf(exported, 48000, 96000);
    const sourceLevel = rmsOf(source, 48000, 96000);
    check('the exported file carries the sound once and in step: decoded, it lines up with the source file to the millisecond and is at its level',
      exportLag.score > 0.95 && Math.abs(exportLag.lag) <= 48 && Math.abs(dB(exportedLevel / sourceLevel)) < 0.5,
      `lag ${exportLag.lag} samples at 48 kHz, match ${exportLag.score.toFixed(3)}; exported ${exportedLevel.toFixed(4)} RMS, source ${sourceLevel.toFixed(4)} RMS (${dB(exportedLevel / sourceLevel).toFixed(2)} dB; twice would be +6.02)`);

    console.log('2. drift, re-sync, rejoin, the key');
    // Moved on its own, 6 frames late: the measures above have to see it.
    await store((id) => window.__scfStore.getState().setClipStarts(new Map([[id, 6]])), after.sound.id);
    const mixDrifted = await mixOf(0, 120);
    const driftLag = lagOf(mixBefore, mixDrifted, rate);
    check('a sound moved 6 frames late is measured 6 frames late in the mix (the measure can fail)',
      Math.abs(driftLag.lag - (6 / FPS) * rate) <= 1, `lag ${driftLag.lag} samples, 6 frames is ${(6 / FPS) * rate}`);
    const playedDrifted = await playAgainst(mixBefore, 2.6);
    check('and 6 frames late while playing, against the same clock',
      !playedDrifted.replayed && playedDrifted.matched >= 10 && Math.abs(playedBefore.offset - playedDrifted.offset - (6 / FPS) * rate) <= rate / 1000,
      `${(((playedBefore.offset - playedDrifted.offset) / rate) * 1000).toFixed(2)} ms late; 6 frames is 200 ms`);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'out-of-sync-en.png') });
    const soundAt = await clipPoint(after.sound.id, 0.5);
    await window.mouse.click(soundAt.x, soundAt.y, { button: 'right' });
    const moveItem = window.getByRole('menuitem', { name: /Move into sync \(\+6\)/ });
    check('the sound offers Move into sync (+6)', await moveItem.isVisible().catch(() => false));
    await moveItem.click();
    await sleep(200);
    const resynced = await store((id) => window.__scfStore.getState().project.clips[id].startFrame, after.sound.id);
    const mixResynced = await mixOf(0, 120);
    check('and Move into sync puts it back: at frame 0, the mix the same samples as the clip\'s own sound again',
      resynced === 0 && maxDifference(mixBefore, mixResynced) < 1e-4, `at ${resynced}, largest difference ${maxDifference(mixBefore, mixResynced).toExponential(2)}`);

    const beforeJoin = await depth();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'rejoinAudio'));
    await sleep(300);
    const joined = await store((id) => {
      const { project } = window.__scfStore.getState();
      return { count: Object.keys(project.clips).length, detached: project.clips[id].audioDetached === true };
    }, picture);
    check('Edit > Rejoin audio puts the sound back in its picture: one clip, its own sound, one undo step',
      joined.count === 1 && !joined.detached && (await depth()) === beforeJoin + 1, JSON.stringify(joined));
    const mixRejoined = await mixOf(0, 120);
    check('and the mix is still the same samples', maxDifference(mixBefore, mixRejoined) < 1e-4, maxDifference(mixBefore, mixRejoined).toExponential(2));

    await store((id) => window.__scfStore.getState().selectClips([id]), picture);
    await surface.focus().catch(() => undefined);
    await window.keyboard.press('Control+Alt+s');
    await sleep(300);
    const byKey = await store(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.audioOnly).length);
    check('Ctrl+Alt+S detaches it again (Ctrl+Shift+S stays Save As)', byKey === 1);
    await store(() => window.__scfStore.getState().selectClips([]));
    await window.keyboard.press('Control+Alt+s');
    check('with nothing selected it says so, instead of doing nothing silently',
      await window.getByText('Select a video clip with sound', { exact: false }).first().isVisible({ timeout: 3000 }).catch(() => false));

    console.log('3. loops');
    /** Play round the loop from `from` for `seconds`, recording the master; what the joins sounded like. */
    const measure = async (label, frequency, seconds, from) => {
      await store((frame) => window.__scfStore.getState().setCurrentFrame(frame), from);
      await sleep(400);
      const recording = await store(RECORD, [seconds]);
      const joins = analyseJoins(recording.samples, frequency, recording.sampleRate);
      const schedule = scheduledJoins(recording.schedule, recording.sampleRate);
      const trips = wrapsOf(recording.frames);
      if (joins.atJoin > joins.steepest * 1.15) {
        // Where the step was, against what was scheduled: the nearest edge of a span, in samples.
        const at = recording.endTime - (recording.samples.length - 1 - joins.atIndex) / recording.sampleRate;
        const edges = recording.schedule.flatMap((span) => [['start', span], ['end', span]].map(([edge, s]) => ({ edge, pass: s.pass, at: s.at, samples: Math.round((at - s.when - (edge === 'end' ? s.seconds : 0)) * recording.sampleRate) })));
        edges.sort((a, b) => Math.abs(a.samples) - Math.abs(b.samples));
        console.log(`      the step: ${at.toFixed(4)} s on the audio clock; nearest span edges ${JSON.stringify(edges.slice(0, 2))}`);
      }
      console.log(`      ${label}: ${recording.samples.length} samples (${recording.missing} missed); longest near-silence ${joins.longest} samples; steepest step ${(joins.atJoin / joins.steepest).toFixed(2)}x the tone's own; `
        + `${schedule.passes} rounds scheduled, holes ${schedule.holes.map((hole) => hole.toFixed(3)).join(', ')} samples, rounds ${schedule.intervals.map((interval) => interval.toFixed(3)).join(', ')} samples apart; `
        + `playhead wrapped ${trips.wraps} times, every ${trips.periods.map((p) => p.toFixed(0)).join(', ')} ms; ${recording.strips} strips at the end; spans handed over late: ${recording.schedule.filter((span) => span.lateBy > 0).map((span) => `${span.at.toFixed(2)} s by ${(span.lateBy * 1000).toFixed(0)} ms`).join(', ') || 'none'}`);
      if (process.env.AUDIO_EDIT_DUMP) await writeFile(join(workDir, label.slice(0, 1) + '.json'), JSON.stringify(recording));
      return { recording, joins, schedule, trips };
    };
    const rulerAt = (page, frames, view) => page.evaluate(([list, ui]) => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      const context = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      return list.map((frame) => [...context.getImageData(Math.round((frame * ui.pixelsPerFrame - ui.scrollLeftPx) * dpr), Math.round(22 * dpr), 1, 1).data].slice(0, 3));
    }, [frames, view]);
    const viewOf = () => store(() => {
      const { pixelsPerFrame, scrollLeftPx } = window.__scfStore.getState().ui;
      return { pixelsPerFrame, scrollLeftPx };
    });
    const emerald = ([r, g, b]) => g > 180 && r < 100 && b > 120;
    const noGap = (result) => result.joins.longest < result.recording.sampleRate * 0.001;
    const noClick = (result) => result.joins.atJoin <= result.joins.steepest * 1.15;
    const loopPeriod = (result, seconds) => result.trips.periods.length >= 1 && Math.abs(median(result.trips.periods) - seconds * 1000) < seconds * 1000 * 0.1;
    /** The playhead from just after play was pressed on: before that it is wherever it was put. */
    const playing = (result) => result.recording.frames.filter(([time]) => time >= result.recording.playedAt + 40).map(([, frame]) => frame);
    const frameRange = (result) => {
      const frames = playing(result);
      return `${Math.min(...frames)}..${Math.max(...frames)}`;
    };

    // A: the whole edit, a WAV held whole - a 441 Hz tone 2.5 s long, so the
    // join butts a crest against a trough.
    await clear();
    await place('tone.wav', 'audio', 0, { durationFrames: 75 });
    await sleep(200);
    const [beforeBar] = await rulerAt(window, [40], await viewOf());
    await surface.focus().catch(() => undefined);
    await window.keyboard.press('Control+/');
    await sleep(300);
    check('Ctrl+/ turns loop playback on, and the View menu ticks it',
      (await store(() => window.__scfStore.getState().ui.loopPlayback)) && (await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('loopPlayback')?.checked)) === true);
    const [onBar] = await rulerAt(window, [40], await viewOf());
    check('the ruler shows the loop only while it is on', !emerald(beforeBar) && emerald(onBar), JSON.stringify({ beforeBar, onBar }));
    const whole = await measure('A. whole edit, a WAV held whole, 2.5 s round', 441, 6.2, 45);
    check('round the whole edit the playhead goes round again and again, never leaving it, once every 2.5 s',
      whole.trips.wraps >= 2 && playing(whole).length > 100 && playing(whole).every((frame) => frame >= 0 && frame < 75) && loopPeriod(whole, 2.5),
      `${whole.trips.wraps} wraps, every ${whole.trips.periods.map((p) => p.toFixed(0)).join(', ')} ms; frames ${frameRange(whole)}`);
    check('as scheduled, each round of a whole buffer starts exactly one loop (2.5 s) after the last',
      whole.schedule.intervals.length >= 1 && whole.schedule.intervals.every((interval) => Math.abs(interval - 2.5 * whole.recording.sampleRate) < 1),
      whole.schedule.intervals.map((interval) => interval.toFixed(3)).join(', '));
    check('as heard, no gap at the joins: under 1 ms of near-silence', noGap(whole), `${whole.joins.longest} samples`);
    check('and no click: no step bigger than the tone itself makes', noClick(whole), `${(whole.joins.atJoin / whole.joins.steepest).toFixed(2)}x the tone's steepest`);

    // B: the whole edit, a streamed sound - the take's AAC, 2.5 s of it.
    await clear();
    await place('take.mp4', 'video', 0, { durationFrames: 75 });
    await store(() => window.__scfStore.getState().setUi({ loopPlayback: true }));
    const wholeStreamed = await measure('B. whole edit, a streamed AAC sound, 2.5 s round', 440, 6.2, 45);
    check('a streamed sound round the whole edit: the playhead goes round every 2.5 s', wholeStreamed.trips.wraps >= 2 && loopPeriod(wholeStreamed, 2.5),
      `${wholeStreamed.trips.wraps} wraps, every ${wholeStreamed.trips.periods.map((p) => p.toFixed(0)).join(', ')} ms`);
    check('no gap at the joins', noGap(wholeStreamed), `${wholeStreamed.joins.longest} samples`);
    check('and no click', noClick(wholeStreamed), `${(wholeStreamed.joins.atJoin / wholeStreamed.joins.steepest).toFixed(2)}x`);

    // C: In to Out across a streamed sound - the take's 440 Hz from 1 s to 2.5 s.
    await clear();
    await place('take.mp4', 'video', 0);
    await store(() => window.__scfStore.getState().setUi({ inFrame: 30, outFrame: 75, loopPlayback: true }));
    await sleep(300);
    const [inside, outside] = await rulerAt(window, [50, 100], await viewOf());
    check('the ruler marks the loop: emerald along its foot from In to Out, not beyond', emerald(inside) && !emerald(outside), JSON.stringify({ inside, outside }));
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'loop-ruler-en.png') });
    const marked = await measure('C. In to Out across a streamed sound, 1.5 s round', 440, 7.2, 0);
    check('started outside In-Out, playback starts at In, stays inside it, and goes round every 1.5 s',
      playing(marked).every((frame) => frame >= 30 && frame < 75) && marked.trips.wraps >= 3 && loopPeriod(marked, 1.5),
      `frames ${frameRange(marked)}, ${marked.trips.wraps} wraps every ${marked.trips.periods.map((p) => p.toFixed(0)).join(', ')} ms`);
    const length = 1.5 * marked.recording.sampleRate;
    check('as scheduled, each round starts on the sample the one before ends, and one loop after the last began',
      marked.schedule.holes.length >= 2 && marked.schedule.holes.every((hole) => Math.abs(hole) < 1) && marked.schedule.intervals.every((interval) => Math.abs(interval - length) < 1),
      `holes ${marked.schedule.holes.map((hole) => hole.toFixed(3)).join(', ')} samples; rounds ${marked.schedule.intervals.map((interval) => interval.toFixed(3)).join(', ')} samples apart against ${length}`);
    check('as heard, no gap at the joins, mid-clip', noGap(marked), `${marked.joins.longest} samples of near-silence at most`);
    check('and no click at them, though the join cuts the sound mid-wave', noClick(marked), `${(marked.joins.atJoin / marked.joins.steepest).toFixed(2)}x`);
    check('going round, the sound is never rebuilt: a wrap is not read as a scrub (A, B and C)',
      !whole.recording.replayed && !wholeStreamed.recording.replayed && !marked.recording.replayed, JSON.stringify([whole.recording.replayed, wholeStreamed.recording.replayed, marked.recording.replayed]));
    check('the engine lets go of the strips of rounds it is past: a few, not one per time round',
      marked.schedule.passes >= 4 && marked.recording.strips <= 3, `${marked.recording.strips} strips after ${marked.schedule.passes} rounds: ${marked.recording.stripKeys.join(', ')}`);
    // Nothing marked: a selected clip is the loop.
    await store(() => {
      const s = window.__scfStore.getState();
      s.setUi({ inFrame: null, outFrame: null });
      s.selectClips(Object.keys(s.project.clips));
    });
    await sleep(300);
    const [selectedEnd] = await rulerAt(window, [110], await viewOf());
    check('with nothing marked, the selected clip is the loop: the bar runs to its end (frame 120)', emerald(selectedEnd), JSON.stringify(selectedEnd));

    console.log('4. the timeline in a window of its own');
    await store(() => {
      const s = window.__scfStore.getState();
      s.selectClips([]);
      s.setUi({ inFrame: 30, outFrame: 75, loopPlayback: true });
    });
    const opened = app.waitForEvent('window', { timeout: 15_000 });
    await window.getByTestId('detach-timeline').click();
    const panel = await opened;
    await panel.waitForSelector('[data-testid="timeline-canvas"]', { timeout: 15_000 });
    await sleep(600);
    const panelBar = await rulerAt(panel, [50, 100], await viewOf());
    check('the loop bar is drawn on the detached timeline too: In to Out, not beyond', emerald(panelBar[0]) && !emerald(panelBar[1]), JSON.stringify(panelBar));
    if (shotsDir) await panel.screenshot({ path: join(shotsDir, 'loop-ruler-panel-en.png') });
    await panel.locator('[data-testid="timeline-canvas"]').focus().catch(() => undefined);
    await panel.keyboard.press('Control+/');
    await sleep(300);
    const offFromPanel = await store(() => window.__scfStore.getState().ui.loopPlayback);
    const [panelOff] = await rulerAt(panel, [50], await viewOf());
    await panel.keyboard.press('Control+/');
    await sleep(300);
    check('Ctrl+/ pressed in the timeline\'s window turns the loop off and on, and its bar with it',
      offFromPanel === false && !emerald(panelOff) && (await store(() => window.__scfStore.getState().ui.loopPlayback)) === true, JSON.stringify({ offFromPanel, panelOff }));
    const panelLoop = await measure('D. In to Out with the timeline out', 440, 4.2, 0);
    check('with the timeline out, playback still goes round In to Out every 1.5 s',
      panelLoop.trips.wraps >= 2 && loopPeriod(panelLoop, 1.5) && playing(panelLoop).every((frame) => frame >= 30 && frame < 75),
      `${panelLoop.trips.wraps} wraps every ${panelLoop.trips.periods.map((p) => p.toFixed(0)).join(', ')} ms; frames ${frameRange(panelLoop)}`);
    const closed = panel.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined);
    // The window closes under the click, which Playwright reports as an error.
    await panel.getByTestId('dock-timeline').click().catch(() => undefined);
    await closed;
    await window.getByTestId('timeline-canvas').waitFor({ state: 'visible', timeout: 10_000 });

    console.log('4b. the start of play, with the machine loaded');
    /*
      Every start of play part-way into a streamed sound clicked on
      v1.42.0-beta.1 - 13 to 16 times the tone's own steepest step, idle or
      loaded - and under load the picture set off up to a quarter of a second
      before the sound. A three-minute tone, each start 33 s from the last so
      that the decoder starts again every time, while every core but one spins
      in a worker and the page's own thread is busy 25 ms in every 40.
    */
    await clear();
    await place('long-tone.mp4', 'video', 0);
    const control = startAndStop(await store(RECORD, [1.0, 200, 440]), 440);
    check('the measure hears a click: a bare tone started and stopped on the master on whatever sample it reached',
      control.start > 3 && control.stop > 3, `start ${control.start.toFixed(1)}x, stop ${control.stop.toFixed(1)}x the tone's steepest`);
    const hogs = await store(() => {
      const code = 'let x = 0; for (;;) x += Math.sqrt(x + 1);';
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      window.__audioEditHogs = Array.from({ length: Math.max(1, navigator.hardwareConcurrency - 1) }, () => new Worker(url));
      window.__audioEditJank = setInterval(() => {
        const until = performance.now() + 25;
        while (performance.now() < until);
      }, 40);
      return window.__audioEditHogs.length;
    });
    const starts = [];
    for (const second of [12, 45, 78, 111, 144]) {
      // A frame and a bit past the second: the start lands mid-wave.
      await store((frame) => window.__scfStore.getState().setCurrentFrame(frame), second * FPS + 7);
      await sleep(300);
      const recording = await store(RECORD, [1.0, 200]);
      starts.push({ second, ...startAndStop(recording, 440), drift: median(recording.drifts.slice(5).map((drift) => Math.abs(drift) * 1000)), waitedMs: recording.waitedMs, firstMoveMs: recording.firstMoveMs, replayed: recording.replayed, late: recording.schedule.filter((span) => span.lateBy > 0).length, outvoted: recording.outvoted.length });
    }
    await store(() => {
      for (const worker of window.__audioEditHogs) worker.terminate();
      clearInterval(window.__audioEditJank);
    });
    for (const start of starts) {
      console.log(`      from ${start.second} s: waited ${start.waitedMs?.toFixed(1)} ms for the first span, sound from ${start.onsetMs.toFixed(1)} ms, the playhead moved at ${start.firstMoveMs?.toFixed(1)} ms and ran ${start.drift.toFixed(1)} ms from the sound (median); steepest step ${start.start.toFixed(2)}x at the start, ${start.playing.toFixed(2)}x playing, ${start.stop.toFixed(2)}x at the stop; ${start.late} spans late, ${start.outvoted} copies outvoted, replayed ${start.replayed}`);
    }
    const waits = starts.map((start) => start.waitedMs ?? 0);
    check(`the load is real: with ${hogs} workers spinning, the first span kept the start waiting in every run, up to ${Math.max(...waits).toFixed(0)} ms`,
      starts.length === 5 && starts.every((start) => start.waitedMs !== null) && Math.max(...waits) >= 10, waits.map((wait) => wait.toFixed(1)).join(', '));
    check('no click at the start of play: the sound fades in, from where the playhead is',
      starts.every((start) => start.onsetMs >= 0 && start.peak > 0.01 && start.start <= 1.15), starts.map((start) => `${start.start.toFixed(2)}x`).join(', '));
    check('nor while it plays on, nor at the stop', starts.every((start) => start.playing <= 1.15 && start.stop <= 1.15),
      starts.map((start) => `${start.playing.toFixed(2)}x/${start.stop.toFixed(2)}x`).join(', '));
    // On v1.42.0-beta.1 the picture set off with the press and the sound up to 650 ms after it.
    check('picture and sound set off together: the playhead never moves before the sound begins, and then keeps to it within three frames',
      starts.every((start) => start.firstMoveMs !== null && start.firstMoveMs >= start.onsetMs - 15 && start.drift <= 3000 / FPS),
      starts.map((start) => `moved ${(start.firstMoveMs - start.onsetMs).toFixed(1)} ms after the sound, ${start.drift.toFixed(1)} ms apart`).join('; '));
    // The wait is cut off at 300 ms (START_WAIT_MS); the press reaching the engine and the start's 20 ms margin come on top.
    check('and the wait is bounded: the sound is under way within 400 ms of the press, however loaded, and never rebuilt',
      starts.every((start) => start.onsetMs <= 400 && !start.replayed), `median ${median(starts.map((start) => start.onsetMs)).toFixed(1)} ms, at most ${Math.max(...starts.map((start) => start.onsetMs)).toFixed(1)} ms`);

    if (withSilent) {
      console.log(`5. a video with no sound: ${silentFootage}`);
      await clear();
      const silentClip = await place(basename(silentFootage), 'video', 0, { durationFrames: 90 });
      await store((id) => window.__scfStore.getState().selectClips([id]), silentClip);
      const point = await clipPoint(silentClip);
      await window.mouse.click(point.x, point.y, { button: 'right' });
      await window.getByRole('menuitem').first().waitFor({ state: 'visible', timeout: 5000 });
      const items = await window.getByRole('menuitem').allInnerTexts();
      await window.keyboard.press('Escape');
      check('its right-click menu does not offer Detach audio', items.length > 3 && !items.some((text) => /Detach audio/.test(text)), `${items.length} items`);
      await store((id) => window.__scfStore.getState().selectClips([id]), silentClip);
      // The message from part 2 is long gone; it has to come up again, for this clip.
      const shownBefore = await window.getByText('Select a video clip with sound', { exact: false }).count();
      await surface.focus().catch(() => undefined);
      await window.keyboard.press('Control+Alt+s');
      await sleep(300);
      const detachedSilent = await store(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.audioOnly || clip.audioDetached).length);
      check('and Ctrl+Alt+S on it detaches nothing, and says it needs a clip with sound',
        shownBefore === 0 && detachedSilent === 0 && (await window.getByText('Select a video clip with sound', { exact: false }).first().isVisible({ timeout: 3000 }).catch(() => false)), `${detachedSilent} clips changed, ${shownBefore} messages up before the key`);
    } else {
      console.log(`5. a video with no sound: skipped, ${silentFootage} is not there`);
    }

    if (withReal) {
      console.log(`5b. real footage with sound: ${realFootage}`);
      await clear();
      // Imported only now: measuring a long file's waveform keeps the page busy
      // for a while, and the loops above are not to be measured under that.
      await app.evaluate(({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      }, [realFootage]);
      await window.getByRole('button', { name: 'Import' }).click();
      await window.waitForFunction((name) => {
        const asset = window.__scfStore.getState().assets.find((candidate) => candidate.name === name);
        return asset && window.__scfAudioEngine().hasAudio(asset.uri);
      }, basename(realFootage), { timeout: 300_000 });
      const seconds = 10;
      const realAsset = await store((name) => {
        const asset = window.__scfStore.getState().assets.find((candidate) => candidate.name === name);
        return { name: asset.name, durationFrames: asset.durationFrames };
      }, basename(realFootage));
      // Five minutes in when the file is that long: past any quiet opening.
      const intoFile = realAsset.durationFrames > (300 + seconds) * FPS ? 300 : 0;
      const realClip = await place(realAsset.name, 'video', 0, { durationFrames: seconds * FPS, sourceOffsetFrames: intoFile * FPS });
      const realBefore = await mixOf(0, seconds * FPS);
      const realPlayedBefore = await playAgainst(realBefore, 2.6);
      console.log(describePlay('before', realPlayedBefore));
      const made = await store((id) => window.__scfStore.getState().detachAudio([id]), realClip);
      const realAfter = await mixOf(0, seconds * FPS);
      const realPlayedAfter = await playAgainst(realBefore, 2.6);
      console.log(describePlay('after', realPlayedAfter));
      const realSource = await decodeAudio(realFootage, rate, seconds, intoFile);
      const realLag = lagOf(realSource, realAfter, Math.round(0.25 * rate));
      const realLagBefore = lagOf(realSource, realBefore, Math.round(0.25 * rate));
      // Where the render sits against ffmpeg's own decode of the file is the
      // decoder's business, the same before detaching as after: it is said,
      // and the check is that detaching does not move it by a sample.
      check('detached, the real footage\'s mix is the same samples as before: against the file, it sits exactly where the clip\'s own sound did',
        made.length === 1 && rmsOf(realBefore) > 0.001 && maxDifference(realBefore, realAfter) < 1e-4 && realLag.score > 0.9 && realLag.lag === realLagBefore.lag,
        `${seconds} s from ${intoFile} s in, ${rmsOf(realBefore).toFixed(4)} RMS, largest difference ${maxDifference(realBefore, realAfter).toExponential(2)}; against ffmpeg's decode of the file: ${realLagBefore.lag} samples before detaching, ${realLag.lag} after (${((realLag.lag / rate) * 1000).toFixed(2)} ms), match ${realLag.score.toFixed(3)}`);
      check('and playing it, the detached sound is where the clip\'s own was, to 1 ms, at the same level',
        !realPlayedBefore.replayed && !realPlayedAfter.replayed && realPlayedBefore.matched >= 10 && realPlayedAfter.matched >= 10
          && Math.abs(realPlayedAfter.offset - realPlayedBefore.offset) <= rate / 1000 && Math.abs(dB(realPlayedAfter.level / realPlayedBefore.level)) < 0.5,
        `offsets ${realPlayedBefore.offset} and ${realPlayedAfter.offset} samples (${realPlayedBefore.matched} and ${realPlayedAfter.matched} probes); level ${dB(realPlayedAfter.level / realPlayedBefore.level).toFixed(2)} dB`);
    } else {
      console.log('5b. real footage with sound: skipped (AUDIO_EDIT_REAL names a file to use)');
    }

    console.log('6. in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    await clear();
    const esClip = await place('sync.mp4', 'video', 0);
    const esAt = await clipPoint(esClip);
    await window.mouse.click(esAt.x, esAt.y, { button: 'right' });
    const separar = window.getByRole('menuitem', { name: 'Separar audio' });
    check('el menú del clip dice «Separar audio»', await separar.isVisible().catch(() => false));
    await separar.click();
    await sleep(300);
    check('y separa el audio', (await store(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.audioOnly).length)) === 1);
    await sleep(300);
    const menu = await app.evaluate(({ Menu }) => ({
      detach: Menu.getApplicationMenu().getMenuItemById('detachAudio')?.label,
      rejoin: Menu.getApplicationMenu().getMenuItemById('rejoinAudio')?.label,
      loop: Menu.getApplicationMenu().getMenuItemById('loopPlayback')?.label,
    }));
    check('el menú de la aplicación: Separar audio, Volver a unir el audio, Reproducir en bucle',
      menu.detach === 'Separar audio' && menu.rejoin === 'Volver a unir el audio' && menu.loop === 'Reproducir en bucle', JSON.stringify(menu));
    await store(() => window.__scfStore.getState().selectClips([]));
    await surface.focus().catch(() => undefined);
    await window.keyboard.press('Control+Alt+s');
    check('sin nada seleccionado, Ctrl+Alt+S lo dice en español',
      await window.getByText('Selecciona un clip de vídeo con sonido', { exact: false }).first().isVisible({ timeout: 3000 }).catch(() => false));
    await store((id) => window.__scfStore.getState().setClipStarts(new Map([[id, 4]])), await store(() => Object.values(window.__scfStore.getState().project.clips).find((clip) => clip.audioOnly).id));
    await sleep(200);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'detach-es.png') });

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
