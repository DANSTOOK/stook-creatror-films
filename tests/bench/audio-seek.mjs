import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

/**
 * Far jumps in streamed audio: `node tests/bench/audio-seek.mjs`
 *
 * v1.9.0-beta.1 listed as a known issue that going a long way back in a long
 * file made the reader wind through it again from the head - about 3.7 s to
 * reach minute 40 - and later betas left it under "not verified" once the
 * reader learned to start next to what it is asked for. This measures it.
 *
 * On the 45-minute file the long-footage check generates (npm run test:long
 * creates it; BENCH_SOURCE points elsewhere), through the app's own extracted
 * audio, it times a cold jump to minute 40, a small step on, far jumps back to
 * minute 5 and one minute back, and a jump to the head. Every span must be
 * signal, not silence, and match what a reader opened fresh at that moment
 * decodes: a restart that lands somewhere slightly wrong would be fast and
 * still wrong.
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const source = process.env.BENCH_SOURCE ?? join(projectRoot, '.long-tmp', 'long45.mp4');

/** The old wind-from-the-head cost was ~3700 ms at minute 40. */
const LIMIT_MS = 1000;
const SILENCE = 0.01;

async function main() {
  if (!(await stat(source).catch(() => null))) {
    console.error(`no source at ${source} - run tests/long/run.mjs once to generate it, or set BENCH_SOURCE`);
    process.exit(1);
  }

  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${join(projectRoot, '.bench-tmp', 'profile-audio-seek')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined },
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
    await app.evaluate(({ dialog }, video) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
    }, source);
    await window.getByRole('button', { name: 'Import' }).click();

    const url = await window.evaluate(async () => {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const asset = window.__scfStore.getState().assets[0];
        if (asset?.audioUri) return asset.audioUri;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    });
    if (!url) throw new Error('the asset never got an extracted audio track');

    const result = await window.evaluate(async (audioUrl) => {
      const AudioStream = window.__scfAudioStream;
      const stream = await AudioStream.open(audioUrl);
      if (!stream) return { error: 'AudioStream.open returned null' };

      const level = (plane) => {
        let sum = 0;
        for (let i = 0; i < plane.length; i += 1) sum += Math.abs(plane[i]);
        return sum / Math.max(1, plane.length);
      };

      const steps = [
        ['cold jump to 40:00', 40 * 60],
        ['step on to 40:05', 40 * 60 + 5],
        ['far back to 05:00', 5 * 60],
        ['far ahead to 39:00', 39 * 60],
        ['one minute back to 38:00', 38 * 60],
        ['back to the head, 00:03', 3],
        ['far ahead again to 44:00', 44 * 60],
      ];

      const rows = [];
      for (const [label, at] of steps) {
        const started = performance.now();
        const span = await stream.span(at, 0.5);
        const ms = performance.now() - started;

        // What a reader that has never been anywhere else decodes there.
        const fresh = await AudioStream.open(audioUrl);
        const expected = await fresh.span(at, 0.5);
        fresh.close();
        let worst = 0;
        for (let channel = 0; channel < span.planes.length; channel += 1) {
          const a = span.planes[channel];
          const b = expected.planes[channel];
          for (let i = 0; i < Math.min(a.length, b.length); i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
        }

        rows.push({ label, at, ms: Math.round(ms), level: level(span.planes[0]), worst, heldMb: stream.heldBytes / 1024 / 1024 });
      }
      stream.close();
      return { rows, duration: stream.duration };
    }, url);

    if (result.error) throw new Error(result.error);

    console.log(`source: ${source} (${(result.duration / 60).toFixed(1)} min of audio)`);
    for (const row of result.rows) {
      console.log(`   ${row.label.padEnd(28)} ${String(row.ms).padStart(5)} ms  level ${row.level.toFixed(3)}  worst |diff| ${row.worst.toExponential(1)}  held ${row.heldMb.toFixed(1)} MB`);
    }

    const farBack = result.rows.filter((row) => /back/.test(row.label));
    const worstBack = Math.max(...farBack.map((row) => row.ms));
    check('a far jump back no longer winds from the head of the file', worstBack < LIMIT_MS,
      `slowest backward jump ${worstBack} ms, limit ${LIMIT_MS} ms (was ~3700 ms at minute 40)`);
    const slowest = Math.max(...result.rows.map((row) => row.ms));
    check('no jump anywhere in 45 minutes takes a second', slowest < LIMIT_MS, `slowest ${slowest} ms`);
    const quiet = result.rows.filter((row) => row.level < SILENCE);
    check('every span is signal, not silence', quiet.length === 0,
      quiet.length ? `silent at ${quiet.map((row) => row.label).join(', ')}` : 'all above the silence floor');
    const worstDiff = Math.max(...result.rows.map((row) => row.worst));
    check('after any jump the samples match a reader opened fresh there', worstDiff === 0,
      `worst difference ${worstDiff.toExponential(1)}`);
    const heldMb = Math.max(...result.rows.map((row) => row.heldMb));
    check('the window it keeps stays small', heldMb < 30, `at most ${heldMb.toFixed(1)} MB held`);
  } finally {
    await app.close().catch(() => undefined);
  }

  console.log(`\n${passed}/${total} audio-seek checks passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
