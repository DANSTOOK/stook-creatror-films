import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

/**
 * The streamed export mix against the single render: `node tests/bench/audio-chunks.mjs`
 *
 * The export renders its sound a minute at a time now, so an hour no longer
 * needs 1.4 GB at once. That is only worth having if the sound is the same.
 * This builds a real edit in the app - cuts, a removed piece, two tracks
 * overlapping, a clip turned down and EQ'd, and a second pass with auto
 * ducking on - and renders the same range both ways, in pieces of 7 seconds
 * (boundaries everywhere, inside clips and on cuts) and of the real 60.
 *
 * Pass: the same number of samples, and the difference at least 60 dB below
 * the signal (40 dB with ducking, whose envelope is the least settled thing
 * at a boundary). Uses the 45-minute file the long-footage check generates.
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const source = process.env.BENCH_SOURCE ?? join(projectRoot, '.long-tmp', 'long45.mp4');

async function main() {
  if (!(await stat(source).catch(() => null))) {
    console.error(`no source at ${source} - run tests/long/run.mjs once, or set BENCH_SOURCE`);
    process.exit(1);
  }
  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${join(projectRoot, '.bench-tmp', 'profile-audio-chunks')}`, join(projectRoot, 'dist-electron/main/index.js')],
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
    await app.evaluate(({ dialog }, video) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
    }, source);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => Boolean(window.__scfStore.getState().assets[0]?.audioUri), null, { timeout: 180_000 });

    const results = await window.evaluate(async () => {
      const s = () => window.__scfStore.getState();
      const { renderTimelineAudio, streamTimelineAudio } = window.__scfMix;
      const asset = s().assets[0];
      const fps = s().project.fps;
      const video1 = s().project.tracks.find((t) => t.name === 'Video 1');

      // Two minutes of edit starting from minute 10 of the file.
      const first = s().addAssetToTimeline(asset, video1.id, 0);
      s().trimClip(first, 'start', 0);
      s().updateClip(first, { sourceOffsetFrames: 10 * 60 * fps, durationFrames: 150 * fps });
      s().razorAtFrame(40 * fps + 7, [first]);
      const right = Object.values(s().project.clips).find((c) => c.startFrame === 40 * fps + 7);
      s().razorAtFrame(55 * fps + 3, [right.id]);
      const middle = Object.values(s().project.clips).find((c) => c.startFrame === 40 * fps + 7);
      s().removeClips([middle.id]);
      const quiet = Object.values(s().project.clips).find((c) => c.startFrame > 0);
      if (quiet) s().updateClip(quiet.id, { volume: 0.4, eq: { low: 6, mid: -3, high: 4 } });
      // A second, overlapping source on its own track.
      s().addTrack('audio');
      const audio2 = s().project.tracks.filter((t) => t.type === 'audio').at(-1);
      const overlay = s().addAssetToTimeline(asset, audio2.id, 20 * fps);
      s().updateClip(overlay, { sourceOffsetFrames: 30 * 60 * fps, durationFrames: 60 * fps, volume: 0.5 });

      const project = s().project;
      const endFrame = Math.max(...Object.values(project.clips).map((c) => c.startFrame + c.durationFrames));

      const collect = async (chunkSeconds, projectState) => {
        const pieces = [];
        const mix = await streamTimelineAudio(projectState, s().assets, 0, endFrame, async (samples) => {
          pieces.push(samples.slice());
        }, { chunkSeconds });
        const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
        const joined = new Float32Array(length);
        let offset = 0;
        for (const piece of pieces) {
          joined.set(piece, offset);
          offset += piece.length;
        }
        return { mix, joined, pieces: pieces.length };
      };

      const compare = async (label, projectState) => {
        const single = await renderTimelineAudio(projectState, s().assets, 0, endFrame);
        // The single render's WAV: 44-byte header, then interleaved float32.
        const reference = new Float32Array(single.wav, 44);
        const rows = [];
        for (const chunkSeconds of [7, 60]) {
          const streamed = await collect(chunkSeconds, projectState);
          let worst = 0;
          let errorEnergy = 0;
          let signalEnergy = 0;
          const count = Math.min(reference.length, streamed.joined.length);
          for (let i = 0; i < count; i += 1) {
            const diff = streamed.joined[i] - reference[i];
            worst = Math.max(worst, Math.abs(diff));
            errorEnergy += diff * diff;
            signalEnergy += reference[i] * reference[i];
          }
          rows.push({
            label,
            chunkSeconds,
            pieces: streamed.pieces,
            referenceSamples: reference.length,
            streamedSamples: streamed.joined.length,
            worst,
            snrDb: errorEnergy === 0 ? Infinity : 10 * Math.log10(signalEnergy / errorEnergy),
            peakSingle: single.peak,
            peakStreamed: streamed.mix.peak,
            signalRms: Math.sqrt(signalEnergy / Math.max(1, count)),
          });
        }
        return rows;
      };

      const plain = await compare('edit', project);
      const dialogueTrack = project.tracks.find((t) => t.id === audio2.id);
      const ducked = {
        ...project,
        tracks: project.tracks.map((t) => (t.id === dialogueTrack.id ? { ...t, bus: 'dialogue' } : t)),
        audio: { ...project.audio, ducking: { ...project.audio.ducking, enabled: true } },
      };
      const withDucking = await compare('edit + ducking', ducked);
      return { rows: [...plain, ...withDucking], seconds: endFrame / fps };
    });

    console.log(`edit: ${results.seconds.toFixed(1)} s, 2 tracks, a removed piece, EQ, volume`);
    for (const row of results.rows) {
      console.log(`   ${row.label.padEnd(15)} pieces of ${String(row.chunkSeconds).padStart(2)} s (${row.pieces}): samples ${row.streamedSamples} vs ${row.referenceSamples}, worst |diff| ${row.worst.toExponential(1)}, error ${Number.isFinite(row.snrDb) ? row.snrDb.toFixed(1) : 'inf'} dB below the signal (rms ${row.signalRms.toFixed(3)})`);
    }

    for (const row of results.rows) {
      const limit = row.label.includes('ducking') ? 40 : 60;
      check(`${row.label}, ${row.chunkSeconds} s pieces: same length, and the sound the same`,
        row.streamedSamples === row.referenceSamples && row.snrDb >= limit && row.signalRms > 0.01,
        `${row.streamedSamples === row.referenceSamples ? 'same length' : 'LENGTH DIFFERS'}, error ${Number.isFinite(row.snrDb) ? row.snrDb.toFixed(1) : 'inf'} dB down (limit ${limit} dB)`);
    }
  } finally {
    await app.close().catch(() => undefined);
  }

  console.log(`\n${passed}/${total} audio-chunk checks passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
