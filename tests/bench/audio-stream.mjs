import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Streamed audio against a full decode: `npm run test:bench:audio`
 *
 * Playback used to hold every source as one AudioBuffer (~1 GB per 45
 * minutes). `AudioStream` decodes a few seconds at a time instead, which is
 * only worth anything if it returns the SAME samples.
 *
 * It generates its own source, for two reasons learned the hard way:
 *  - a screen recording's audio track is often SILENT, and comparing silence
 *    with silence passes while proving nothing. The source here is pink noise
 *    and the run fails if what it compared turns out to be quiet.
 *  - noise, not a tone: a 1 kHz sine shifted by a whole period looks
 *    identical, so a tone would hide exactly the alignment mistake this is
 *    meant to catch.
 *
 * The alignment between the two paths is measured, not assumed: AAC carries
 * encoder priming that the container says to discard, and if the two
 * disagreed about it the sound would be ~21 ms out.
 *
 * Not covered here: a file whose container does NOT declare that priming in
 * an edit list. The reader handles it (`primingSeconds`), but every file
 * ffmpeg writes for this check carries an edit list, so that path is
 * reasoned about rather than measured - worth saying plainly instead of
 * implying it was tested.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp');

/** Signal quieter than this means the comparison would prove nothing. */
const SILENCE = 0.01;
/** How far the alignment search looks, in samples. */
const SEARCH = 2048;

async function reference() {
  if (process.env.BENCH_SOURCE) return process.env.BENCH_SOURCE;

  const file = join(workDir, 'audio-ref.mp4');
  await mkdir(workDir, { recursive: true });
  if (await stat(file).catch(() => null)) return file;

  // 15 s, so the spans below straddle the reader's 4 s chunk boundaries. A
  // small video track too, so the app's own audio extraction runs on it.
  await execFileAsync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=15',
    '-f', 'lavfi', '-i', 'anoisesrc=d=15:c=pink:r=48000:a=0.5',
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest',
    file,
  ]);
  return file;
}

async function main() {
  const source = await reference();

  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot });
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile-audio')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });

  let ok = false;
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => console.log(`   pageerror: ${error.message}`));

    await app.evaluate(({ dialog }, video) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
    }, source);
    await window.getByRole('button', { name: 'Import' }).click();
    const name = source.split(/[\\/]/).pop();
    await window.getByText(name, { exact: false }).first().waitFor({ timeout: 120_000 });

    // The app extracts the audio track to its own .m4a; that is the file
    // playback reads, so that is the file to check.
    const url = await window.evaluate(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const asset = window.__scfStore.getState().assets[0];
        if (asset?.audioUri) return asset.audioUri;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    });
    if (!url) throw new Error('the asset never got an extracted audio track');

    const result = await window.evaluate(async ({ audioUrl, silence, search }) => {
      const AudioStream = window.__scfAudioStream;
      const stream = await AudioStream.open(audioUrl);
      if (!stream) return { error: 'AudioStream.open returned null - not AAC in MP4?' };

      // The reference: the whole file through the browser's own decoder, in a
      // context at the file's rate so nothing is resampled on either side.
      const bytes = await (await fetch(audioUrl)).arrayBuffer();
      const context = new OfflineAudioContext(stream.channels, 1, stream.sampleRate);
      const whole = await context.decodeAudioData(bytes);
      const reference = whole.getChannelData(0);

      const level = (data, from, count) => {
        let sum = 0;
        for (let i = 0; i < count; i += 1) sum += Math.abs(data[from + i] ?? 0);
        return sum / Math.max(1, count);
      };

      /**
       * Who keeps the codec's run-up samples.
       *
       * AAC hands back ~1024 samples before the sound starts. Whoever keeps
       * them has a quiet first frame followed by signal; whoever drops them
       * starts on signal straight away. Comparing the two frames answers it
       * outright, without depending on anyone's idea of where zero is.
       */
      const ours = await stream.span(0, 0.05);
      const priming = {
        reference: { first: level(reference, 0, 1024), second: level(reference, 1024, 1024) },
        streamed: { first: level(ours.planes[0], 0, 1024), second: level(ours.planes[0], 1024, 1024) },
        info: stream.debugInfo ? stream.debugInfo() : null,
      };

      /**
       * The offset between the two decodes at one moment, searched rather
       * than assumed.
       *
       * Measured at SEVERAL moments on purpose. Fitting one global offset
       * once hid a real defect: the first seconds of a file sat 1024 samples
       * off (the codec's run-up, which the container does not always declare)
       * while the rest was exact, and a single fitted offset made the
       * correct part look broken instead.
       */
      const offsetAt = async (fromSeconds) => {
        const probe = await stream.span(fromSeconds, 0.1);
        const mine = probe.planes[0];
        const base = Math.round(fromSeconds * stream.sampleRate);
        let best = 0;
        let bestError = Infinity;
        let ties = 0;
        for (let offset = -search; offset <= search; offset += 1) {
          let error = 0;
          for (let i = 0; i < 512; i += 1) error += Math.abs(mine[i] - (reference[base + offset + i] ?? 0));
          if (error < bestError - 1e-9) {
            bestError = error;
            best = offset;
            ties = 0;
          } else if (Math.abs(error - bestError) <= 1e-9) {
            ties += 1;
          }
        }
        return { from: fromSeconds, offset: best, residual: bestError / 512, ties, level: level(mine, 0, Math.min(4096, mine.length)) };
      };

      // One inside the first decoded chunk, the others well past it.
      const offsets = [];
      for (const at of [0.5, 2, 6, 10]) {
        if (at + 0.1 < Math.min(whole.duration, stream.duration)) offsets.push(await offsetAt(at));
      }

      const bestOffset = offsets[0]?.offset ?? 0;
      const ties = offsets[0]?.ties ?? 0;
      const probeLevel = Math.max(...offsets.map((entry) => entry.level));
      const referenceLevel = level(reference, Math.round(2 * stream.sampleRate) - search, 2 * search);

      /**
       * Spans chosen for the seams, not at random.
       *
       * The reader decodes in 4 s chunks, and the FIRST chunk is special: it
       * starts at the head of the stream, where the decoder's labels and its
       * content are a frame apart. So there is a span inside the head chunk,
       * one on each of its edges, ones straddling later chunk boundaries,
       * and one at the very end of the file - the tail of the head chunk is
       * where a 1024-sample hole once hid.
       */
      const spans = [
        { from: 0, seconds: 0.5 },
        { from: 1.5, seconds: 0.5 },
        { from: 3.8, seconds: 0.5 },
        { from: 3.95, seconds: 0.1 },
        { from: 7.9, seconds: 0.4 },
        { from: 11.95, seconds: 0.2 },
        { from: 14.6, seconds: 0.3 },
      ].filter((span) => span.from + span.seconds < Math.min(whole.duration, stream.duration));

      const windows = [];
      for (const span of spans) {
        const decoded = await stream.span(span.from, span.seconds);
        const at = Math.round(span.from * stream.sampleRate) + bestOffset;
        let worst = 0;
        let sum = 0;
        let count = 0;
        let energy = 0;
        for (let channel = 0; channel < decoded.channels; channel += 1) {
          const ours = decoded.planes[channel];
          const theirs = whole.getChannelData(Math.min(channel, whole.numberOfChannels - 1));
          for (let i = 0; i < ours.length; i += 1) {
            const them = theirs[at + i] ?? 0;
            const diff = Math.abs(ours[i] - them);
            if (diff > worst) worst = diff;
            sum += diff;
            energy += Math.abs(them);
            count += 1;
          }
        }
        windows.push({ from: span.from, worst, mean: sum / Math.max(1, count), level: energy / Math.max(1, count) });
      }

      return {
        sampleRate: stream.sampleRate,
        channels: stream.channels,
        streamDuration: stream.duration,
        referenceDuration: whole.duration,
        alignment: bestOffset,
        alignmentTies: ties,
        atSearchEdge: offsets.some((entry) => Math.abs(entry.offset) >= search),
        offsets,
        probeLevel,
        referenceLevel,
        silence,
        windows,
        priming,
      };
    }, { audioUrl: url, silence: SILENCE, search: SEARCH });

    if (result.error) throw new Error(result.error);

    console.log(`   ${result.channels} ch @ ${result.sampleRate} Hz; streamed ${result.streamDuration.toFixed(6)} s vs decoded ${result.referenceDuration.toFixed(6)} s`);
    if (result.priming?.info) {
      const info = result.priming.info;
      console.log(`   reader: ${info.sampleCount} frames, first sample time ${info.firstSampleTime.toExponential(3)} s, second ${info.secondSampleTime.toExponential(3)} s, priming ${info.primingSeconds.toExponential(3)} s (${Math.round(info.primingSeconds * info.sampleRate)} samples)`);
    }
    if (result.priming) {
      const { reference: ref, streamed } = result.priming;
      console.log(`   first 1024 samples vs next 1024 - reference ${ref.first.toFixed(4)} / ${ref.second.toFixed(4)}, streamed ${streamed.first.toFixed(4)} / ${streamed.second.toFixed(4)}`);
      const keeps = (pair) => (pair.first < pair.second * 0.5 ? 'keeps the run-up' : 'starts on signal');
      console.log(`   so the reference ${keeps(ref)}, and the streamed audio ${keeps(streamed)}`);
    }
    console.log(`   signal: streamed ${result.probeLevel.toFixed(3)}, reference ${result.referenceLevel.toFixed(3)}`);
    for (const entry of result.offsets) {
      console.log(`   offset at ${String(entry.from).padStart(5)} s: ${String(entry.offset).padStart(6)} samples, residual ${entry.residual.toExponential(2)}${Math.abs(entry.offset) >= SEARCH ? ' [AT SEARCH EDGE]' : ''}${entry.ties ? ` [${entry.ties} ties]` : ''}`);
    }
    // The same offset everywhere, and zero: the streamed audio lines up with
    // the full decode the whole way through, not just on average.
    const offsets = result.offsets.map((entry) => entry.offset);
    const uniform = offsets.every((offset) => offset === offsets[0]);
    console.log(`   offsets ${uniform ? 'agree' : 'DISAGREE'} across the file: ${offsets.join(', ')}`);
    for (const w of result.windows) {
      console.log(`   from ${String(w.from).padStart(5)} s: worst |diff| ${w.worst.toExponential(2)}, mean ${w.mean.toExponential(2)} (signal ${w.level.toFixed(3)})`);
    }

    // Silence would make every comparison trivially pass, so it fails here.
    const quiet = result.probeLevel < SILENCE || result.referenceLevel < SILENCE;
    const compared = result.windows.filter((w) => w.level >= SILENCE);
    const worst = compared.length > 0 ? Math.max(...compared.map((w) => w.worst)) : Infinity;

    if (quiet) console.log(`   FAIL  the source is silent (level < ${SILENCE}): nothing was actually compared`);
    if (compared.length < result.windows.length) {
      console.log(`   note: ${result.windows.length - compared.length} of ${result.windows.length} windows were too quiet to count`);
    }

    // Sample-for-sample equality is too strict across decoder runs, but the
    // same decoder two ways should agree far below one bit of 16-bit audio.
    ok =
      !quiet &&
      compared.length >= 3 &&
      worst < 1e-3 &&
      uniform &&
      offsets.every((offset) => Math.abs(offset) <= 1) &&
      !result.atSearchEdge;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  streamed audio matches the full decode (worst ${worst.toExponential(2)}, offsets ${offsets.join('/')}, ${compared.length} windows compared)`);
  } finally {
    await app.close().catch(() => undefined);
  }

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
