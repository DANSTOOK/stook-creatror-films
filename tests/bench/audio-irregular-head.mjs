import { execFile, execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Sound placement in a file whose first audio packet is irregular:
 *   BENCH_SOURCE=<video> node tests/bench/audio-irregular-head.mjs
 *
 * The user's game capture starts its audio with a packet stamped 2494 samples
 * long instead of one 1024-sample AAC frame. The streamed reader placed sound
 * it reached by decoding forward from the head of the file 56.5 ms later than
 * the same sound reached by a jump - so in an hour-long export some clips were
 * more than a frame out of step with their picture and others were not.
 *
 * This reads the same moments three ways - a fresh reader, a reader that
 * started at the head and walked there, and one that started at the head and
 * jumped - and requires them to agree with each other to the sample and with
 * ffmpeg's timestamp-honouring decode to within a frame. One moment is in the
 * first seconds, where the reader is most tempted to start at packet 0.
 *
 * Needs a source with such a head (the user's footage); on a regular file the
 * three ways always agreed and the check proves nothing new.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const source = process.env.BENCH_SOURCE ?? '';
const FRAME_MS = 1000 / 30;

const reference = (start, duration, rate) => {
  const bytes = execFileSync(ffmpeg, ['-v', 'error', '-i', source, '-ss', start.toFixed(4), '-t', duration.toFixed(3), '-vn',
    '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 26 });
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readFloatLE(i * 4);
  return samples;
};

/** Best alignment of `ours` inside `window`, in ms relative to `leadSeconds`. */
const align = (ours, window, leadSeconds, rate) => {
  let best = { r: -1, offset: 0 };
  for (let offset = 0; offset + ours.length <= window.length; offset += 2) {
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < ours.length; i += 3) {
      ma += ours[i];
      mb += window[offset + i];
    }
    ma /= ours.length / 3;
    mb /= ours.length / 3;
    let num = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < ours.length; i += 3) {
      const x = ours[i] - ma;
      const y = window[offset + i] - mb;
      num += x * y;
      va += x * x;
      vb += y * y;
    }
    const r = va && vb ? num / Math.sqrt(va * vb) : 0;
    if (r > best.r) best = { r, offset };
  }
  return { r: best.r, ms: (best.offset / rate - leadSeconds) * 1000 };
};

async function main() {
  if (!source || !(await stat(source).catch(() => null))) {
    console.error('Set BENCH_SOURCE to a video whose audio starts with an irregular packet (the user footage).');
    process.exit(1);
  }
  const head = execFileSync(ffmpeg, ['-v', 'error', '-i', source, '-map', '0:a:0', '-c', 'copy', '-frames', '2', '-f', 'framemd5', '-'], { encoding: 'utf8' });
  const pts = head.split('\n').filter((line) => /^0,/.test(line)).map((line) => Number(line.split(',')[2]));
  console.log(`source audio: first packets at ${pts.join(', ')} (a regular file steps by 1024)`);

  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 });
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${join(projectRoot, '.bench-tmp', 'profile-irregular-head')}`, join(projectRoot, 'dist-electron/main/index.js')],
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
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, source);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => Boolean(window.__scfStore.getState().assets[0]?.audioUri), null, { timeout: 180_000 });

    const moments = [4.2, 492.3, 825.7];
    const read = await window.evaluate(async (ats) => {
      const AudioStream = window.__scfAudioStream;
      const url = window.__scfStore.getState().assets[0].audioUri;
      const out = [];
      for (const at of ats) {
        const ways = {};
        let s = await AudioStream.open(url);
        ways.fresh = Array.from((await s.span(at, 1)).planes[0]);
        s.close();
        s = await AudioStream.open(url);
        await s.span(0.5, 0.2);
        for (let t = 1; t < at - 2; t += 20) await s.span(t, 0.2);
        ways.walked = Array.from((await s.span(at, 1)).planes[0]);
        s.close();
        s = await AudioStream.open(url);
        await s.span(0.5, 0.2);
        ways.jumped = Array.from((await s.span(at, 1)).planes[0]);
        rate = s.sampleRate;
        s.close();
        out.push({ at, ways, rate });
      }
      return out;
      // eslint-disable-next-line no-var
      var rate;
    }, moments);

    for (const moment of read) {
      const rate = moment.rate;
      const fresh = Float32Array.from(moment.ways.fresh);
      const walked = Float32Array.from(moment.ways.walked);
      const jumped = Float32Array.from(moment.ways.jumped);
      let worstWay = 0;
      for (let i = 0; i < fresh.length; i += 1) {
        worstWay = Math.max(worstWay, Math.abs(fresh[i] - walked[i]), Math.abs(fresh[i] - jumped[i]));
      }
      const lead = Math.min(0.1, moment.at);
      const ref = reference(moment.at - lead, 1 + 2 * lead, rate);
      const placed = ['fresh', 'walked', 'jumped'].map((way) => ({ way, ...align(Float32Array.from(moment.ways[way]), ref, lead, rate) }));
      console.log(`   ${String(moment.at).padStart(6)} s: ${placed.map((p) => `${p.way} ${p.ms.toFixed(1)} ms (r ${p.r.toFixed(2)})`).join(', ')}; worst difference between ways ${worstWay.toExponential(1)}`);
      check(`at ${moment.at} s the sound lands in the same place however the reader got there`, worstWay < 1e-3,
        `worst sample difference ${worstWay.toExponential(1)}`);
      check(`at ${moment.at} s it is within a frame of ffmpeg's timestamp-honouring decode`,
        placed.every((p) => p.r > 0.8 && Math.abs(p.ms) <= FRAME_MS),
        placed.map((p) => `${p.way} ${p.ms.toFixed(1)} ms`).join(', '));
    }
  } finally {
    await app.close().catch(() => undefined);
  }

  console.log(`\n${passed}/${total} irregular-head checks passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
