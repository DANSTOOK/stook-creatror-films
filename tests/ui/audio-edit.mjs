import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Detach audio, loops and typed mixer values, in the running app:
 * `node tests/ui/audio-edit.mjs`
 *
 *   1. detach audio from the timeline's menu: the sound on the audio track at
 *      the same time and stretch, linked, one undo step, the picture's own
 *      sound silent - and the mix, the export and playback at the level the
 *      clip had before (heard once, not twice);
 *   2. drift: the red marks, Move into sync, rejoin from the Edit menu, and
 *      Ctrl+Alt+S;
 *   3. loops: Ctrl+/, the bar on the ruler, the playhead never leaving the
 *      loop, and the sound at the join recorded off the master: the longest
 *      silence there in samples, the step at the join, and the time between
 *      joins against the loop's length - for a whole buffer round the whole
 *      edit, and a streamed sound round In to Out;
 *   4. the mixer: a level, a pan and the master typed in, refused with a
 *      hint, cancelled with Escape, nudged with the arrows, -inf, one undo
 *      step each; the inspector's level and the ducking range;
 *   5. in Spanish: the menu, the hint, a decimal comma, the message.
 *
 * LOOP_ONLY=1 runs part 3's whole-edit measurement alone, and SCF_APP_ROOT
 * points it at another build (to measure the loop before this change).
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to AUDIO_EDIT_SHOTS.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const appRoot = process.env.SCF_APP_ROOT ? resolve(process.env.SCF_APP_ROOT) : projectRoot;
const loopOnly = process.env.LOOP_ONLY === '1';
const workDir = join(projectRoot, '.ui-tmp', loopOnly ? 'audio-edit-loop' : 'audio-edit');
const shotsDir = process.env.AUDIO_EDIT_SHOTS ?? '';
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

/** A file's sound, mono float at 48 kHz, decoded with ffmpeg. */
async function decodeAudio(file) {
  const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
}

const rmsOf = (samples, from, count) => {
  let sum = 0;
  for (let i = from; i < from + count; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / count);
};

/**
 * Record the master bus for `seconds`, starting playback once the recorder
 * runs. In the page: an AudioWorklet copies every block off the master into
 * an array; nothing is changed in the graph the editor hears.
 */
const RECORD = async ([seconds]) => {
  const engine = window.__scfAudioEngine();
  const context = engine.context;
  await context.resume();
  // A ScriptProcessor: the page's CSP keeps an AudioWorklet module from
  // loading. Each block carries the audio clock time it was rendered for, so
  // a block the page was too busy to take is a hole in the recording that is
  // known, not a gap mistaken for the engine's.
  const node = context.createScriptProcessor(4096, 2, 1);
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(context.destination);
  const blocks = [];
  node.onaudioprocess = (event) => blocks.push({ at: event.playbackTime, data: event.inputBuffer.getChannelData(0).slice(0) });
  engine.master.connect(node);
  // What the engine hands the audio clock, span by span: when each one
  // sounds, and for how long, and which time round the loop it belongs to.
  const schedule = [];
  const scheduleSpan = engine.scheduleSpan;
  if (typeof engine.passOffset === 'function') {
    engine.scheduleSpan = function logged(project, span, pass) {
      schedule.push({ pass, at: span.atTimeline, seconds: span.seconds, when: this.startedAtContextTime + (span.atTimeline + this.passOffset(pass) - this.startedAtSeconds) });
      return scheduleSpan.call(this, project, span, pass);
    };
  }
  const frames = [];
  let sampling = true;
  const watch = () => {
    if (!sampling) return;
    frames.push(window.__scfStore.getState().project.currentFrame);
    requestAnimationFrame(watch);
  };
  await new Promise((done) => setTimeout(done, 150));
  const before = blocks.length;
  window.__scfStore.getState().setPlaying(true);
  requestAnimationFrame(watch);
  await new Promise((done) => setTimeout(done, seconds * 1000));
  window.__scfStore.getState().setPlaying(false);
  sampling = false;
  await new Promise((done) => setTimeout(done, 100));
  engine.master.disconnect(node);
  node.disconnect();
  sink.disconnect();
  delete engine.scheduleSpan;
  const kept = blocks.slice(before);
  const rate = context.sampleRate;
  // Blocks follow one another exactly; the clock time on each says only how
  // many whole blocks the page missed in between (it jitters by a fraction
  // of one), so each is laid a whole number of blocks after the last.
  const size = kept[0].data.length;
  const places = [0];
  for (let index = 1; index < kept.length; index += 1) {
    const blocksOn = Math.max(1, Math.round(((kept[index].at - kept[index - 1].at) * rate) / size));
    places.push(places[index - 1] + blocksOn * size);
  }
  // NaN where no block arrived.
  const out = new Float32Array(places[places.length - 1] + size).fill(NaN);
  kept.forEach((block, index) => out.set(block.data, places[index]));
  let missing = 0;
  for (const value of out) if (Number.isNaN(value)) missing += 1;
  return { samples: Array.from(out), sampleRate: rate, frames, schedule, missing };
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
    // The first round starts wherever playback did; the rest at the loop's start.
    if (index > 0) starts.push(pass.first);
    const before = passes.get(index - 1);
    if (index > 0 && before) holes.push((pass.first - before.end) * sampleRate);
  }
  const intervals = starts.slice(1).map((start, index) => (start - starts[index]) * sampleRate);
  return { passes: passes.size, holes, intervals };
}

/**
 * What the join sounds like, from a recording of a steady tone: the longest
 * run of near-silence after the sound first starts (a gap, in samples), the
 * biggest step between neighbouring samples near each dip against the tone's
 * own biggest step (a click), and where the dips are (the joins).
 */
function analyseJoins(recorded, sampleRate, frequency) {
  // A block the recorder missed is NaN: read as the steady tone's crest, it
  // can neither look like a gap nor like a dip, and makes no step.
  let peak = 0;
  for (const value of recorded) if (!Number.isNaN(value)) peak = Math.max(peak, Math.abs(value));
  const samples = recorded.map((value) => (Number.isNaN(value) ? peak : value));
  const filled = recorded.map((value) => Number.isNaN(value));
  const quiet = peak * 0.02;
  const first = samples.findIndex((value) => Math.abs(value) > peak * 0.5);
  let last = samples.length - 1;
  while (last > 0 && Math.abs(samples[last]) <= peak * 0.5) last -= 1;
  // Longest run of near-silence inside the sounding stretch.
  let longest = 0;
  let longestAt = -1;
  let run = 0;
  for (let i = first; i <= last; i += 1) {
    if (Math.abs(samples[i]) < quiet) {
      run += 1;
      if (run > longest) {
        longest = run;
        longestAt = i - run + 1;
      }
    } else run = 0;
  }
  // Dips: 32-sample windows, every 8 samples, whose peak falls under a third
  // of the tone's; a dip is the middle of a run of them, to within 8 samples.
  const window = 32;
  const dips = [];
  let runStart = -1;
  for (let start = first; start + window <= last; start += 8) {
    let max = 0;
    for (let i = start; i < start + window; i += 1) max = Math.max(max, Math.abs(samples[i]));
    const low = max < peak / 3;
    if (low && runStart < 0) runStart = start;
    if (!low && runStart >= 0) {
      dips.push((runStart + start - 8) / 2 + window / 2);
      runStart = -1;
    }
  }
  // A click is a step between two neighbouring samples bigger than the tone
  // can make: a sine of this peak moves at most 2 sin(pi f / rate) times it
  // from one sample to the next. The steepest step anywhere, against that.
  const steepest = 2 * Math.sin((Math.PI * frequency) / sampleRate) * peak;
  let atJoin = 0;
  let atJoinIndex = -1;
  const step = (i) => (filled[i] || filled[i - 1] ? 0 : Math.abs(samples[i] - samples[i - 1]));
  for (let i = first + 1; i <= last; i += 1) {
    if (step(i) > atJoin) {
      atJoin = step(i);
      atJoinIndex = i;
    }
  }
  return { peak, longest, longestAt, dips, steepest, atJoin, atJoinIndex, first, last };
}

/** One line of what a recording round a loop showed. */
const describeJoins = (label, recording, joins, schedule) =>
  `      ${label}: ${recording.samples.length} samples at ${recording.sampleRate} Hz (${recording.missing} the recorder missed); `
  + `longest near-silence ${joins.longest} samples (${((joins.longest / recording.sampleRate) * 1000).toFixed(2)} ms); `
  + `steepest step ${joins.atJoin.toFixed(4)} at ${(joins.atJoinIndex / recording.sampleRate).toFixed(3)} s against the tone's own ${joins.steepest.toFixed(4)} (${(joins.atJoin / joins.steepest).toFixed(2)}x)`
  + (schedule.passes ? `; scheduled rounds ${schedule.passes}, holes ${schedule.holes.map((hole) => hole.toFixed(3)).join(', ')} samples, rounds ${schedule.intervals.map((interval) => interval.toFixed(3)).join(', ')} samples apart` : '');

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const take = join(workDir, 'take.mp4');
  const tone = join(workDir, 'tone.wav');
  const song = join(workDir, 'song.wav');
  // A 4-second shot with its own sound: a steady 440 Hz at -12 dBFS.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=4`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-filter:a', 'volume=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-shortest', take]);
  // 441 Hz for 6 s: a 2.5 s loop of it is 1102.5 cycles, so the join butts a
  // crest against a trough - the worst case for a click.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=441:sample_rate=48000:duration=6', '-filter:a', 'volume=0.5', '-c:a', 'pcm_s16le', tone]);
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=3', song]);
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(appRoot, 'dist-electron/main/index.js')],
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [take, tone, song]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 3, null, { timeout: 60_000 });
    await window.evaluate(([w, h, fps]) => window.__scfStore.getState().setProjectSettings({ width: w, height: h, fps }), [W, H, FPS]);
    // The sound of every file decoded (or opened for streaming) before anything is played.
    await window.waitForFunction(() => {
      const engine = window.__scfAudioEngine();
      return engine && window.__scfStore.getState().assets.every((asset) => engine.hasAudio(asset.uri));
    }, null, { timeout: 60_000 });

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
    /** The audible mix of the whole edit, as the export renders it: RMS of its first channel. */
    const mixLevel = (from, to) => store(async ([start, end]) => {
      const s = window.__scfStore.getState();
      const mix = await window.__scfMix.renderTimelineAudio(s.project, s.assets, start, end, { sampleRate: 48000, channels: 1 });
      if (!mix) return 0;
      const view = new DataView(mix.wav);
      let at = 12;
      let data = -1;
      let size = 0;
      let bits = 32;
      while (at < view.byteLength - 8) {
        const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
        const length = view.getUint32(at + 4, true);
        if (id === 'fmt ') bits = view.getUint16(at + 22, true);
        if (id === 'data') { data = at + 8; size = length; break; }
        at += 8 + length;
      }
      const count = size / (bits / 8);
      let sum = 0;
      // The middle half, away from the clip's edges.
      const from = Math.floor(count / 4);
      const to = Math.floor((count * 3) / 4);
      for (let i = from; i < to; i += 1) {
        const value = bits === 32 ? view.getFloat32(data + i * 4, true) : view.getInt16(data + i * 2, true) / 32768;
        sum += value * value;
      }
      return Math.sqrt(sum / (to - from));
    }, [from, to]);

    if (!loopOnly) {
      console.log('1. detach audio');
      await clear();
      const picture = await place('take.mp4', 'video', 0);
      const before = await mixLevel(0, 120);
      const playLevel = async () => store(async () => {
        const s = window.__scfStore.getState();
        s.setCurrentFrame(0);
        await new Promise((done) => setTimeout(done, 300));
        s.setPlaying(true);
        const engineOf = () => window.__scfAudioEngine();
        const readings = [];
        const began = performance.now();
        while (performance.now() - began < 1800) {
          await new Promise((done) => setTimeout(done, 50));
          const engine = engineOf();
          if (engine.positionSeconds > 0.6 && engine.positionSeconds < 3.4) readings.push(engine.meterLevels().master.rms[0]);
        }
        const strips = [...engineOf().strips.keys()];
        window.__scfStore.getState().setPlaying(false);
        readings.sort((a, b) => a - b);
        return { level: readings[Math.floor(readings.length / 2)], strips };
      });
      const playedBefore = await playLevel();

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
      check('right-click > Detach audio puts the sound on the audio track, same time, stretch and file, linked, one undo step',
        after.sound?.track === 'audio' && JSON.stringify(after.sound.span) === JSON.stringify(after.picture.span) && after.sound.uri
          && after.picture.detached === true && after.sound.group === after.picture.group && Boolean(after.picture.group)
          && (await depth()) === start + 1 && after.selected === 2,
        JSON.stringify(after));
      check('the sound clip has a waveform to draw (the file\'s peaks, by its URI)', after.waveform);
      if (shotsDir) await window.screenshot({ path: join(shotsDir, 'detach-en.png') });

      const detachedMix = await mixLevel(0, 120);
      check('the export mix is at the level it had before: heard once, not twice', before > 0 && Math.abs(dB(detachedMix / before)) < 0.1,
        `before ${before.toFixed(4)} RMS, after ${detachedMix.toFixed(4)} RMS (${dB(detachedMix / before).toFixed(2)} dB; twice would be +6.02)`);
      const playedAfter = await playLevel();
      check('playback too: the master at the same level, and only the sound clip has a strip',
        Math.abs(dB(playedAfter.level / playedBefore.level)) < 0.5 && playedAfter.strips.includes(after.sound.id) && !playedAfter.strips.includes(picture),
        `before ${playedBefore.level.toFixed(4)}, after ${playedAfter.level.toFixed(4)} RMS (${dB(playedAfter.level / playedBefore.level).toFixed(2)} dB); strips ${playedAfter.strips.length}`);

      // A real export, decoded: the sound once, at its own level.
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportDir);
      await store(() => window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', exportAlpha: false }));
      await window.getByRole('button', { name: 'Export' }).click();
      const dialog = window.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Whole timeline' }).click();
      await dialog.getByLabel('File name').fill('detached');
      await dialog.getByRole('button', { name: 'Browse' }).click();
      await sleep(400);
      await dialog.getByRole('button', { name: 'Start export' }).click();
      await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 180_000 });
      await dialog.getByTitle('Close').click();
      await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
      const file = (await readdir(exportDir)).find((name) => name.startsWith('detached'));
      const exported = await decodeAudio(join(exportDir, file));
      const exportedLevel = rmsOf(exported, 48000, 96000);
      // Every fader at unity: the file's sound comes out at its own level.
      const sourceLevel = rmsOf(await decodeAudio(take), 48000, 96000);
      check('the exported file carries the sound once: decoded, its level is the source file\'s',
        Math.abs(dB(exportedLevel / sourceLevel)) < 0.5,
        `exported ${exportedLevel.toFixed(4)} RMS, source ${sourceLevel.toFixed(4)} RMS: ${dB(exportedLevel / sourceLevel).toFixed(2)} dB (twice would be +6.02)`);

      console.log('2. drift, re-sync, rejoin, the key');
      await store((id) => window.__scfStore.getState().setClipStarts(new Map([[id, 6]])), after.sound.id);
      const marks = await store(() => {
        const { project } = window.__scfStore.getState();
        return Object.values(project.clips).map((clip) => [clip.audioOnly ? 'sound' : 'picture', clip.startFrame]);
      });
      if (shotsDir) await window.screenshot({ path: join(shotsDir, 'out-of-sync-en.png') });
      const soundAt = await clipPoint(after.sound.id, 0.5);
      await window.mouse.click(soundAt.x, soundAt.y, { button: 'right' });
      const moveItem = window.getByRole('menuitem', { name: /Move into sync \(\+6\)/ });
      check('a sound moved 6 frames late offers Move into sync (+6)', await moveItem.isVisible().catch(() => false), JSON.stringify(marks));
      await moveItem.click();
      await sleep(200);
      const resynced = await store((id) => window.__scfStore.getState().project.clips[id].startFrame, after.sound.id);
      check('and Move into sync puts it back at frame 0', resynced === 0, `at ${resynced}`);

      const beforeJoin = await depth();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'rejoinAudio'));
      await sleep(300);
      const joined = await store((id) => {
        const { project } = window.__scfStore.getState();
        return { count: Object.keys(project.clips).length, detached: project.clips[id].audioDetached === true };
      }, picture);
      check('Edit > Rejoin audio puts the sound back in its picture: one clip, its own sound, one undo step',
        joined.count === 1 && !joined.detached && (await depth()) === beforeJoin + 1, JSON.stringify(joined));
      const rejoinedMix = await mixLevel(0, 120);
      check('and the mix is still at the level it started at', Math.abs(dB(rejoinedMix / before)) < 0.1, `${dB(rejoinedMix / before).toFixed(2)} dB`);

      await store((id) => window.__scfStore.getState().selectClips([id]), picture);
      await surface.focus().catch(() => undefined);
      await window.keyboard.press('Control+Alt+s');
      await sleep(300);
      const byKey = await store(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.audioOnly).length);
      check('Ctrl+Alt+S detaches it again (Ctrl+Shift+S stays Save As)', byKey === 1);
      // Nothing selected: the key says why nothing happened.
      await store(() => window.__scfStore.getState().selectClips([]));
      await window.keyboard.press('Control+Alt+s');
      check('with nothing selected it says so, instead of doing nothing silently',
        await window.getByText('Select a video clip with sound', { exact: false }).first().isVisible({ timeout: 3000 }).catch(() => false));
    }

    console.log(`3. loops${loopOnly ? ` (${appRoot === projectRoot ? 'this build' : appRoot})` : ''}`);
    /** Play round the loop from `from` for `seconds`, recording the master; what the joins sounded like. */
    const measure = async (label, frequency, seconds, from) => {
      await store((frame) => window.__scfStore.getState().setCurrentFrame(frame), from);
      await sleep(400);
      const recording = await store(RECORD, [seconds]);
      const joins = analyseJoins(recording.samples, recording.sampleRate, frequency);
      const schedule = scheduledJoins(recording.schedule, recording.sampleRate);
      console.log(describeJoins(label, recording, joins, schedule));
      return { recording, joins, schedule };
    };
    const rulerAt = (frames) => store((list) => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      const context = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const { pixelsPerFrame, scrollLeftPx } = window.__scfStore.getState().ui;
      return list.map((frame) => [...context.getImageData(Math.round((frame * pixelsPerFrame - scrollLeftPx) * dpr), Math.round(22 * dpr), 1, 1).data].slice(0, 3));
    }, frames);
    const emerald = ([r, g, b]) => g > 180 && r < 100 && b > 120;
    const noGap = (result) => result.joins.longest < result.recording.sampleRate * 0.001;
    const noClick = (result) => result.joins.atJoin <= result.joins.steepest * 1.15;

    // A: the whole edit, a WAV held whole - a 441 Hz tone 2.5 s long, so the
    // join butts a crest against a trough.
    await clear();
    await place('tone.wav', 'audio', 0, { durationFrames: 75 });
    await store(() => window.__scfStore.getState().setProjectSettings({ durationFrames: 75 }, false));
    if (loopOnly) await store(() => window.__scfStore.getState().setUi({ loopPlayback: true }));
    else {
      await surface.focus().catch(() => undefined);
      await window.keyboard.press('Control+/');
      check('Ctrl+/ turns loop playback on', await store(() => window.__scfStore.getState().ui.loopPlayback));
    }
    const whole = await measure('A. whole edit, a WAV held whole, 2.5 s round', 441, 4.2, 45);
    const wraps = whole.recording.frames.filter((frame, index) => index > 0 && frame < whole.recording.frames[index - 1]).length;
    if (!loopOnly) {
      check('round the whole edit, the playhead went round and never left it',
        wraps >= 1 && whole.recording.frames.every((frame) => frame >= 0 && frame < 75), `${wraps} wraps, frames ${Math.min(...whole.recording.frames)}..${Math.max(...whole.recording.frames)}`);
      check('as scheduled, each round of a whole buffer starts exactly one loop (120000 samples) after the last',
        whole.schedule.intervals.length >= 1 && whole.schedule.intervals.every((interval) => Math.abs(interval - 120000 * (whole.recording.sampleRate / 48000)) < 1),
        whole.schedule.intervals.map((interval) => interval.toFixed(3)).join(', '));
      check('as heard, no gap at the join: under 1 ms of near-silence', noGap(whole), `${whole.joins.longest} samples`);
      check('and no click: no step bigger than the tone itself makes', noClick(whole), `${(whole.joins.atJoin / whole.joins.steepest).toFixed(2)}x the tone's steepest`);
    }

    // B: the whole edit, a streamed sound - the take's AAC, 2.5 s of it.
    await clear();
    await place('take.mp4', 'video', 0, { durationFrames: 75 });
    await store(() => {
      window.__scfStore.getState().setProjectSettings({ durationFrames: 75 }, false);
      window.__scfStore.getState().setUi({ loopPlayback: true });
    });
    const wholeStreamed = await measure('B. whole edit, a streamed AAC sound, 2.5 s round', 440, 4.2, 45);
    if (!loopOnly) {
      check('a streamed sound round the whole edit: no gap at the join', noGap(wholeStreamed), `${wholeStreamed.joins.longest} samples`);
      check('and no click', noClick(wholeStreamed), `${(wholeStreamed.joins.atJoin / wholeStreamed.joins.steepest).toFixed(2)}x`);
    }

    if (!loopOnly) {
      // C: In to Out across a streamed sound - the take's 440 Hz from 1 s to 2.5 s.
      await clear();
      await place('take.mp4', 'video', 0);
      await store(() => window.__scfStore.getState().setUi({ inFrame: 30, outFrame: 75, loopPlayback: true }));
      await sleep(300);
      const [inside, outside] = await rulerAt([50, 100]);
      check('the ruler marks the loop: emerald along its foot from In to Out, not beyond', emerald(inside) && !emerald(outside), JSON.stringify({ inside, outside }));
      if (shotsDir) await window.screenshot({ path: join(shotsDir, 'loop-ruler-en.png') });
      const marked = await measure('C. In to Out across a streamed sound, 1.5 s round', 440, 5.2, 0);
      check('starting outside In-Out, playback starts at In and the playhead stays inside it', marked.recording.frames.every((frame) => frame >= 30 && frame < 75),
        `frames ${Math.min(...marked.recording.frames)}..${Math.max(...marked.recording.frames)}`);
      const length = 1.5 * marked.recording.sampleRate;
      check('as scheduled, each round starts on the sample the one before ends, and one loop after the last began',
        marked.schedule.holes.length >= 2 && marked.schedule.holes.every((hole) => Math.abs(hole) < 1) && marked.schedule.intervals.every((interval) => Math.abs(interval - length) < 1),
        `holes ${marked.schedule.holes.map((hole) => hole.toFixed(3)).join(', ')} samples; rounds ${marked.schedule.intervals.map((interval) => interval.toFixed(3)).join(', ')} samples apart against ${length}`);
      check('as heard, no gap at the joins, mid-clip', noGap(marked), `${marked.joins.longest} samples of near-silence at most`);
      check('and no click at them, though the join cuts the sound mid-wave', noClick(marked), `${(marked.joins.atJoin / marked.joins.steepest).toFixed(2)}x`);
      // Nothing marked: a selected clip is the loop.
      await store(() => {
        const s = window.__scfStore.getState();
        s.setUi({ inFrame: null, outFrame: null });
        s.selectClips(Object.keys(s.project.clips));
      });
      await sleep(300);
      const [selectedEnd] = await rulerAt([110]);
      check('with nothing marked, the selected clip is the loop: the bar runs to its end (frame 120)', emerald(selectedEnd), JSON.stringify(selectedEnd));
    }

    if (!loopOnly) {
      console.log('4. typed values in the mixer');
      await clear();
      const clipId = await place('take.mp4', 'video', 0);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'mixer'));
      await window.getByTestId('mixer-panel').waitFor({ state: 'visible', timeout: 5000 });
      const trackId = await store(() => window.__scfStore.getState().project.tracks.find((t) => t.type === 'video' && t.order === 0).id);
      const level = () => store((id) => window.__scfStore.getState().project.tracks.find((t) => t.id === id).volume, trackId);
      let steps = await depth();
      await window.getByTestId(`mixer-level-${trackId}`).click();
      const field = window.getByTestId(`mixer-level-${trackId}-field`);
      await field.fill('-6');
      await field.press('Enter');
      check('a track level typed as -6 is -6.0 dB, one undo step', Math.abs(dB(await level()) + 6) < 0.01 && (await depth()) === steps + 1, `${dB(await level()).toFixed(3)} dB`);
      await window.getByTestId(`mixer-pan-${trackId}`).click();
      await window.getByTestId(`mixer-pan-${trackId}-field`).fill('L30');
      await window.getByTestId(`mixer-pan-${trackId}-field`).press('Enter');
      const pan = await store((id) => window.__scfStore.getState().project.tracks.find((t) => t.id === id).pan, trackId);
      check('its pan typed as L30 is -0.30, one more step', Math.abs(pan + 0.3) < 1e-9 && (await depth()) === steps + 2, `${pan}`);
      check('and the readout says so', (await window.getByTestId(`mixer-pan-${trackId}`).innerText()).trim() === 'L30');

      steps = await depth();
      await window.getByTestId(`mixer-level-${trackId}`).click();
      await field.fill('loud');
      await field.press('Enter');
      const hint = window.getByTestId(`mixer-level-${trackId}-hint`);
      const hinted = await hint.isVisible().catch(() => false);
      const hintText = hinted ? await hint.innerText() : '';
      check('text that is not a level is refused, with a hint saying what is taken, and nothing changes',
        hinted && /-inf/.test(hintText) && (await field.isVisible()) && Math.abs(dB(await level()) + 6) < 0.01 && (await depth()) === steps, hintText);
      if (shotsDir) await window.screenshot({ path: join(shotsDir, 'typed-hint-en.png') });
      await field.press('Escape');
      check('Escape leaves it as it was', !(await field.isVisible().catch(() => false)) && (await depth()) === steps && (await window.getByTestId('mixer-panel').isVisible()));

      await window.getByTestId('master-level').click();
      const master = window.getByTestId('master-level-field');
      await master.press('ArrowDown');
      await master.press('ArrowDown');
      await master.press('Shift+ArrowDown');
      const nudged = await master.inputValue();
      await master.press('Enter');
      const masterVolume = await store(() => window.__scfStore.getState().project.audio.masterVolume);
      check('the arrows nudge the master a tenth of a dB, Shift a whole one: -1.2 dB', nudged === '-1.2' && Math.abs(dB(masterVolume) + 1.2) < 0.01, `${nudged}, ${dB(masterVolume).toFixed(3)} dB`);
      await window.getByTestId('master-level').click();
      await master.fill('-inf');
      await master.press('Enter');
      check('-inf silences it', (await store(() => window.__scfStore.getState().project.audio.masterVolume)) === 0
        && (await window.getByTestId('master-level').innerText()).trim() === '-inf');
      await store(() => window.__scfStore.getState().undo());
      check('and one undo brings back -1.2 dB', Math.abs(dB(await store(() => window.__scfStore.getState().project.audio.masterVolume)) + 1.2) < 0.01);

      // The inspector's clip level, and the ducking range.
      await store((id) => window.__scfStore.getState().selectClips([id]), clipId);
      await window.getByRole('tab', { name: 'Audio' }).click().catch(() => undefined);
      await window.getByTestId('inspector-volume').click();
      await window.getByTestId('inspector-volume-field').fill('-3 dB');
      await window.getByTestId('inspector-volume-field').press('Enter');
      const clipVolume = await store((id) => window.__scfStore.getState().project.clips[id].volume, clipId);
      check('the inspector\'s clip level takes "-3 dB"', Math.abs(dB(clipVolume) + 3) < 0.01, `${dB(clipVolume).toFixed(3)} dB`);
      if (shotsDir) await window.screenshot({ path: join(shotsDir, 'typed-mixer-en.png') });
      await window.getByTestId('ducking-button').click();
      await window.getByTestId('ducking-rangeDb').click();
      await window.getByTestId('ducking-rangeDb-field').fill('-18');
      await window.getByTestId('ducking-rangeDb-field').press('Escape');
      check('Escape in a ducking value cancels the typing and leaves the popover open', await window.getByTestId('ducking-popover').isVisible());
      await window.getByTestId('ducking-rangeDb').click();
      await window.getByTestId('ducking-rangeDb-field').fill('-18');
      await window.getByTestId('ducking-rangeDb-field').press('Enter');
      check('the ducking range takes "-18"', (await store(() => window.__scfStore.getState().project.audio.ducking.rangeDb)) === 18);
      await window.keyboard.press('Escape');

      console.log('5. in Spanish');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
      await window.getByTestId('language-select').selectOption('es');
      await window.keyboard.press('Escape');
      await sleep(400);
      await clear();
      const esClip = await place('take.mp4', 'video', 0);
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
      await window.getByTestId(`mixer-level-${trackId}`).click();
      await field.fill('-6,5');
      await field.press('Enter');
      check('un nivel escrito con coma decimal, «-6,5», es -6,5 dB', Math.abs(dB(await level()) + 6.5) < 0.01, `${dB(await level()).toFixed(3)} dB`);
      await window.getByTestId(`mixer-level-${trackId}`).click();
      await field.fill('fuerte');
      await field.press('Enter');
      const esHint = await window.getByTestId(`mixer-level-${trackId}-hint`).innerText().catch(() => '');
      check('y lo que no es un nivel se rechaza con la pista en español', /Un nivel en dB/.test(esHint), esHint);
      if (shotsDir) await window.screenshot({ path: join(shotsDir, 'typed-hint-es.png') });
      await field.press('Escape');
      await store(() => window.__scfStore.getState().selectClips([]));
      await window.keyboard.press('Control+Alt+s');
      check('sin nada seleccionado, Ctrl+Alt+S lo dice en español',
        await window.getByText('Selecciona un clip de vídeo con sonido', { exact: false }).first().isVisible({ timeout: 3000 }).catch(() => false));
      await store((id) => window.__scfStore.getState().setClipStarts(new Map([[id, 4]])), await store(() => Object.values(window.__scfStore.getState().project.clips).find((clip) => clip.audioOnly).id));
      await sleep(200);
      if (shotsDir) await window.screenshot({ path: join(shotsDir, 'detach-es.png') });

      check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
    }
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
