import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The voice detector (Silero VAD), measured before it is trusted:
 * `node tests/bench/captions-vad.mjs`
 *
 * The same recordings are transcribed in the real app with the detector and
 * without it, with both models, and compared:
 *
 *   - speech:  the known Spanish recording (tests/bench/captions-tts.ps1) -
 *              word error rate, and how far each caption starts from its
 *              first word (the detector cuts the sound up before Whisper
 *              hears it: does it cut word beginnings, or shift the times?);
 *   - gap:     the same with thirty seconds of silence put in the middle -
 *              the same measures, and whether anything is written in the
 *              silence;
 *   - under:   the recording with music under the voice all the way - does
 *              the detector cut speech it takes for music?
 *   - loud:    the same with the music as loud as the voice;
 *   - faint:   the recording 30 dB down over a hiss - does the detector
 *              miss a voice recorded far too quiet?
 *   - intro:   twenty seconds of music and then the recording - whether
 *              anything is written over the intro, and the times after it;
 *   - music:   a minute of synthetic music with nobody speaking - whatever
 *              is written is invented;
 *   - silence: a minute of nothing.
 *
 * Timings mean something only on an idle machine: check no game is running.
 * The window is never shown (SCF_BACKGROUND).
 *
 * CAPTIONS_WHISPER_DIR (default build/whisper), CAPTIONS_MODELS_DIR
 * (.whisper-dev/models), CAPTIONS_VAD (.whisper-dev/vad/ggml-silero-v6.2.0.bin).
 * CAPTIONS_MINUTES=10 measures a ten-minute recording instead, and only it;
 * CAPTIONS_ONLY=speech,gap only those recordings.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp', 'captions-vad');
const whisperDir = process.env.CAPTIONS_WHISPER_DIR ?? join(projectRoot, 'build', 'whisper');
const modelsDir = process.env.CAPTIONS_MODELS_DIR ?? join(projectRoot, '.whisper-dev', 'models');
const vadModel = process.env.CAPTIONS_VAD ?? join(projectRoot, '.whisper-dev', 'vad', 'ggml-silero-v6.2.0.bin');
const FPS = 30;
const GAP = 30;
const INTRO = 20;
// CAPTIONS_MINUTES: a longer recording, and only it - whether the times hold over hundreds of stretches of speech.
const minutes = process.env.CAPTIONS_MINUTES ? Number(process.env.CAPTIONS_MINUTES) : null;
const signed = (ms) => `${ms > 0 ? '+' : ''}${ms}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const fold = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

function wordErrors(reference, hypothesis) {
  const n = reference.length;
  const m = hypothesis.length;
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i += 1) table[i][0] = i;
  for (let j = 0; j <= m; j += 1) table[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
  }
  const matched = new Map();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const same = reference[i - 1] === hypothesis[j - 1];
    if (table[i][j] === table[i - 1][j - 1] + (same ? 0 : 1)) {
      if (same) matched.set(j - 1, i - 1);
      i -= 1;
      j -= 1;
    } else if (table[i][j] === table[i - 1][j] + 1) i -= 1;
    else j -= 1;
  }
  return { errors: table[n][m], rate: n > 0 ? table[n][m] / n : 0, matched };
}

const stats = (values) => {
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  if (abs.length === 0) return null;
  const signed = [...values].sort((a, b) => a - b);
  return {
    count: abs.length,
    medianMs: Math.round(abs[abs.length >> 1] * 1000),
    worstMs: Math.round(abs[abs.length - 1] * 1000),
    within200: abs.filter((value) => value <= 0.2 + 1 / FPS).length,
    // Signed: positive is late (a word beginning cut off), negative is early.
    latestMs: Math.round(signed[signed.length - 1] * 1000),
    earliestMs: Math.round(signed[0] * 1000),
  };
};

async function main() {
  for (const needed of [join(whisperDir, 'whisper-cli.exe'), join(modelsDir, 'ggml-small-q5_1.bin'), join(modelsDir, 'ggml-large-v3-turbo-q5_0.bin'), vadModel]) {
    if (!existsSync(needed)) {
      console.error(`Missing ${needed}`);
      process.exit(2);
    }
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'captions-tts.ps1'), '-Out', workDir, ...(minutes ? ['-Minutes', String(minutes)] : [])], { maxBuffer: 16 * 1024 * 1024 });
  const truth = JSON.parse((await readFile(join(workDir, 'speech.json'), 'utf8')).replace(/^﻿/, ''));
  const words = [...truth.words].sort((a, b) => a.char - b.char).map((word) => ({ text: fold(word.text)[0], start: word.startMs / 1000 })).filter((word) => word.text);
  const speech = join(workDir, 'speech.wav');
  const seconds = ((await stat(speech)).size - 44) / 32_000;

  // The longest pause between two words near the middle: where the silence goes.
  let cutIndex = 1;
  for (let index = 1; index < words.length; index += 1) {
    const middle = Math.abs(words[index].start - seconds / 2) < 8;
    if (middle && words[index].start - words[index - 1].start > words[cutIndex].start - words[cutIndex - 1].start) cutIndex = index;
  }
  const cut = words[cutIndex].start - 0.35;
  const gap = join(workDir, 'gap.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', speech, '-f', 'lavfi', '-t', String(GAP), '-i', 'anullsrc=r=16000:cl=mono', '-filter_complex',
    `[0:a]asplit[x][y];[x]atrim=0:${cut},asetpts=PTS-STARTPTS[a];[y]atrim=${cut},asetpts=PTS-STARTPTS[b];[a][1:a][b]concat=n=3:v=0:a=1[out]`, '-map', '[out]', '-ar', '16000', '-ac', '1', gap]);
  const gapWords = words.map((word, index) => (index >= cutIndex ? { ...word, start: word.start + GAP } : word));
  // A minute of something like music: three notes that swell and fade, a bass line, and a noise bed.
  const music = join(workDir, 'music.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.22*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.16*sin(2*PI*277.18*t)*(0.6+0.4*sin(2*PI*0.33*t))+0.16*sin(2*PI*329.63*t)+0.2*sin(2*PI*110*t)*lt(mod(t\\,0.5)\\,0.25)':s=16000:d=60",
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.04:sample_rate=16000:duration=60', '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0[out]', '-map', '[out]', '-ac', '1', music]);
  const silence = join(workDir, 'silence.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-t', '60', '-i', 'anullsrc=r=16000:cl=mono', silence]);
  // The voice with that music under it all the way, 15 dB down: -29 dB of
  // music under -20 dB of voice, as a video with a music bed has it.
  const under = join(workDir, 'under.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', speech, '-stream_loop', '-1', '-i', music, '-filter_complex',
    '[1:a]volume=0.18[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[out]', '-map', '[out]', '-ar', '16000', '-ac', '1', under]);
  // The music as loud as the voice (-20 dB each): harder than a video should be.
  const loud = join(workDir, 'loud.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', speech, '-stream_loop', '-1', '-i', music, '-filter_complex',
    '[1:a]volume=0.5[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[out]', '-map', '[out]', '-ar', '16000', '-ac', '1', loud]);
  // The voice 30 dB down (-50 dB) over a faint hiss: a recording made far too quiet.
  const faint = join(workDir, 'faint.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', speech, '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.002:sample_rate=16000:duration=${Math.ceil(seconds)}`, '-filter_complex',
    '[0:a]volume=0.0316[voice];[voice][1:a]amix=inputs=2:duration=first:normalize=0[out]', '-map', '[out]', '-ar', '16000', '-ac', '1', faint]);
  // Twenty seconds of the music at full level, then the voice: an intro.
  const intro = join(workDir, 'intro.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-t', String(INTRO), '-i', music, '-i', speech, '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]', '-ar', '16000', '-ac', '1', intro]);
  const introWords = words.map((word) => ({ ...word, start: word.start + INTRO }));
  console.log(`speech: ${seconds.toFixed(1)} s, ${words.length} words (${truth.voice}); the gap goes in at ${cut.toFixed(2)} s, before "${words[cutIndex].text}"`);

  const recordings = [
    { name: 'speech', path: speech, truth: words },
    { name: 'gap', path: gap, truth: gapWords, quiet: [cut + 0.5, cut + GAP - 0.5] },
    { name: 'under', path: under, truth: words },
    { name: 'loud', path: loud, truth: words },
    { name: 'faint', path: faint, truth: words },
    { name: 'intro', path: intro, truth: introWords, quiet: [0, INTRO - 0.5] },
    { name: 'music', path: music, truth: null },
    { name: 'silence', path: silence, truth: null },
  ];
  const only = process.env.CAPTIONS_ONLY ? process.env.CAPTIONS_ONLY.split(',') : null;
  const files = (minutes ? recordings.slice(0, 1) : recordings).filter((file) => !only || only.includes(file.name));
  const report = { voice: truth.voice, seconds, gapAt: cut, runs: [] };

  for (const vad of [false, true]) {
    const app = await electron.launch({
      args: [`--user-data-dir=${join(workDir, `profile-${vad ? 'vad' : 'plain'}`)}`, join(projectRoot, 'dist-electron/main/index.js')],
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        ELECTRON_RUN_AS_NODE: undefined,
        SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
        SCF_SKIP_HOME: '1',
        SCF_NO_CLOSE_PROMPT: '1',
        SCF_WHISPER_DIR: whisperDir,
        SCF_WHISPER_MODELS_DIR: modelsDir,
        SCF_WHISPER_VAD: vad ? vadModel : 'off',
      },
    });
    try {
      const window = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
      await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
      await app.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }));
      const status = await window.evaluate(() => window.filmora.captionsStatus());
      console.log(`\n--- voice detector ${vad ? 'ON' : 'off'} (engine says vad: ${status.vad}, gpu: ${status.gpu ?? 'none'}) ---`);
      if (status.vad !== vad) throw new Error(`The engine reports vad=${status.vad}, wanted ${vad}`);

      await app.evaluate(({ dialog }, list) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list });
        dialog.showMessageBox = async () => ({ response: 1 });
      }, files.map((file) => file.path));
      await window.evaluate((fps) => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps }), FPS);
      await window.getByRole('button', { name: 'Import' }).click();
      await window.waitForFunction((count) => window.__scfStore.getState().assets.length === count, files.length, { timeout: 60_000 });

      for (const file of files) {
        for (const model of ['fast', 'precise']) {
          // One file alone on the timeline, muted on the speakers but not for the job (it reads the project as it starts).
          await window.evaluate((name) => {
            const store = window.__scfStore.getState();
            for (const clip of Object.values(store.project.clips)) window.__scfStore.getState().removeClips([clip.id]);
            for (const track of window.__scfStore.getState().project.tracks) if (track.type === 'captions') window.__scfStore.getState().removeTrack(track.id);
            const fresh = window.__scfStore.getState();
            const asset = fresh.assets.find((candidate) => candidate.name === name);
            fresh.addAssetToTimeline(asset, fresh.project.tracks.find((track) => track.type === 'audio').id, 0);
            window.__scfStore.getState().setCurrentFrame(0);
          }, `${file.name}.wav`);
          const started = Date.now();
          await window.evaluate(() => window.__scfCaptions.job.setState({ last: null }));
          await window.evaluate((id) => { void window.__scfCaptions.job.getState().start({ language: 'es', source: 'mix', model: id, preset: 'classic' }); }, model);
          await window.waitForFunction(() => window.__scfCaptions.job.getState().phase !== 'idle', null, { timeout: 30_000 }).catch(() => undefined);
          await window.waitForFunction(() => window.__scfCaptions.job.getState().phase === 'idle', null, { timeout: 900_000 });
          const elapsed = (Date.now() - started) / 1000;
          await sleep(300);
          const outcome = await window.evaluate(() => {
            const { project } = window.__scfStore.getState();
            const clips = Object.values(project.clips).filter((clip) => clip.caption).sort((a, b) => a.startFrame - b.startFrame);
            const last = window.__scfCaptions.job.getState().last;
            return {
              captions: clips.map((clip) => ({ start: clip.startFrame / project.fps, end: (clip.startFrame + clip.durationFrames) / project.fps, text: clip.caption.text })),
              // The words as the engine timed them, before they were cut into captions.
              words: last ? last.result.words : [],
              dropped: last ? last.result.dropped : null,
              ran: last ? `${last.result.ran}${last.result.gpu ? ` (${last.result.gpu})` : ''}` : null,
              transcribeSeconds: last ? last.result.elapsedSeconds : null,
              vadSegments: last ? last.result.vadSegments : null,
            };
          });
          // Over the reading speed with time left before the next caption: a caption that could have stayed up and did not.
          const hurried = outcome.captions.filter((caption, at) => {
            const next = outcome.captions[at + 1];
            const speed = caption.text.replace(/\n/g, '').length / (caption.end - caption.start);
            return speed > 17.05 && next && Math.round((next.start - caption.end) * FPS) > 2;
          }).map((caption) => `${caption.start.toFixed(2)}-${caption.end.toFixed(2)} ${caption.text.replace(/\n/g, ' / ')}`);
          const run = { file: file.name, model, vad, elapsed, hurried, list: outcome.captions, ran: outcome.ran, transcribeSeconds: outcome.transcribeSeconds, vadSegments: outcome.vadSegments, captions: outcome.captions.length, dropped: outcome.dropped };
          if (file.truth) {
            const reference = file.truth.map((word) => word.text);
            const hypothesis = outcome.captions.flatMap((caption) => fold(caption.text));
            const { errors, rate, matched } = wordErrors(reference, hypothesis);
            const starts = [];
            let index = 0;
            for (const caption of outcome.captions) {
              const at = matched.get(index);
              if (at !== undefined) starts.push(caption.start - file.truth[at].start);
              index += fold(caption.text).length;
            }
            // Every word, not only the first of each caption.
            const heard = outcome.words.flatMap((word) => fold(word.text).map((text) => ({ text, start: word.start })));
            const all = wordErrors(reference, heard.map((word) => word.text));
            const wordStarts = [...all.matched].map(([h, r]) => heard[h].start - file.truth[r].start);
            // What was heard differently: the words said that are not there, and the ones written that were not said.
            const found = new Set(matched.values());
            const missed = reference.map((text, at) => (found.has(at) ? null : `${text}@${file.truth[at].start.toFixed(1)}`)).filter(Boolean);
            const extra = hypothesis.filter((_, at) => !matched.has(at));
            Object.assign(run, { errors, words: reference.length, wer: rate, missed, extra, captionStarts: stats(starts), wordStarts: stats(wordStarts) });
            if (file.quiet) run.inSilence = outcome.captions.filter((caption) => caption.start > file.quiet[0] && caption.start < file.quiet[1]).map((caption) => caption.text.replace(/\n/g, ' '));
          } else {
            run.invented = outcome.captions.map((caption) => `${caption.start.toFixed(1)}s ${caption.text.replace(/\n/g, ' ')}`);
          }
          // The detector on, and its table not read: the times would be those of the sound without its silences.
          if (vad && outcome.captions.length > 0 && !(run.vadSegments > 0)) throw new Error(`${file.name} / ${model}: captions, but the voice detector's table was not read`);
          report.runs.push(run);
          const tail = file.truth
            ? `WER ${(run.wer * 100).toFixed(2)}% (${run.errors}/${run.words}); caption starts: median ${run.captionStarts?.medianMs} ms, worst ${run.captionStarts?.worstMs} ms, ${run.captionStarts?.within200}/${run.captionStarts?.count} within 200 ms, latest ${signed(run.captionStarts?.latestMs)} ms, earliest ${signed(run.captionStarts?.earliestMs)} ms; all words: median ${run.wordStarts?.medianMs} ms, worst ${run.wordStarts?.worstMs} ms, ${run.wordStarts?.within200}/${run.wordStarts?.count} within 200 ms${file.quiet ? `; where nobody speaks: ${run.inSilence.length} captions ${JSON.stringify(run.inSilence)}` : ''}`
            : `${run.captions} captions written over nothing said: ${JSON.stringify(run.invented)}`;
          if (hurried.length > 0) console.log(`   over 17 characters a second with room to stay: ${JSON.stringify(hurried)}`);
          const differences = file.truth && run.errors > 0 ? `; said ${JSON.stringify(run.missed)}, written ${JSON.stringify(run.extra)}` : '';
          console.log(`${file.name} / ${model} / vad ${vad ? 'on' : 'off'}: ${elapsed.toFixed(1)} s (transcription ${run.transcribeSeconds?.toFixed(1) ?? '-'} s), ${run.ran ?? 'no captions'}${vad ? `, ${run.vadSegments ?? 'no'} stretches of speech` : ''}; ${tail}${differences}${run.dropped && run.dropped.length ? `; dropped by the filter: ${JSON.stringify(run.dropped)}` : ''}`);
        }
      }
    } finally {
      await app.close().catch(() => undefined);
    }
  }
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nreport: ${join(workDir, 'report.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
