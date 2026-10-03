import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

/**
 * Does the glossary help? `node tests/bench/captions-glossary.mjs`
 *
 * A recording, made here with a Windows voice, of sentences full of names
 * nobody has heard - a town, a brand, two people, a river - is transcribed
 * in the real app with both models, without a prompt and with the glossary
 * as Whisper's prompt. For each: how many times each name was written
 * exactly as it should be (and as it should be but for case and accents),
 * the word error rate of everything else (a prompt must not make the rest
 * worse), and what the glossary's suggestions would have put right.
 *
 * The window is never shown (SCF_BACKGROUND), the network is cut. Timings
 * mean nothing here, but check no game is running all the same: it runs on
 * the GPU.
 *
 * CAPTIONS_WHISPER_DIR (build/whisper), CAPTIONS_MODELS_DIR (.whisper-dev/models),
 * CAPTIONS_VAD (.whisper-dev/vad/ggml-silero-v6.2.0.bin).
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp', 'captions-glossary');
const whisperDir = process.env.CAPTIONS_WHISPER_DIR ?? join(projectRoot, 'build', 'whisper');
const modelsDir = process.env.CAPTIONS_MODELS_DIR ?? join(projectRoot, '.whisper-dev', 'models');
const vadModel = process.env.CAPTIONS_VAD ?? join(projectRoot, '.whisper-dev', 'vad', 'ggml-silero-v6.2.0.bin');

/** Made up for this test: none of them is a word, and none is in any model's training. */
const NAMES = ['Zorbelia', 'Kratonix', 'Mirelda Quintavares', 'Tolvanegra', 'Ixquerá', 'Brunilde Ocaxa', 'Vantorio', 'Pelquerón'];

const TEXT = [
  'Esta mañana salimos de Zorbelia con Mirelda Quintavares, la guía del grupo.',
  'Mirelda Quintavares conoce cada rincón de Zorbelia desde que era niña.',
  'El primer día visitamos la fábrica de Kratonix, donde hacen bicicletas eléctricas.',
  'Los ingenieros de Kratonix nos enseñaron el nuevo modelo Vantorio.',
  'El Vantorio pesa menos de doce kilos y sube cualquier cuesta.',
  'Después cruzamos el río Ixquerá en una barca de madera.',
  'Brunilde Ocaxa, la barquera, lleva treinta años en el Ixquerá.',
  'Según Brunilde Ocaxa, el agua del Ixquerá baja helada de las montañas de Tolvanegra.',
  'En Tolvanegra dormimos en un refugio pequeño pero muy cálido.',
  'Al día siguiente bajamos hasta Pelquerón para comer en la plaza.',
  'En Pelquerón todos hablan de la feria de Kratonix del próximo verano.',
  'Volveremos a Zorbelia el año que viene, y esta vez subiremos a Tolvanegra a pie.',
  'Gracias a Mirelda Quintavares y a Brunilde Ocaxa por cuidarnos tanto.',
  'Si queréis probar un Vantorio, en Pelquerón se alquilan por horas.',
].join(' ');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const words = (text) => text.split(/\s+/).filter(Boolean);
const fold = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
const bare = (text) => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Word-level alignment: the matched pairs (reference, hypothesis) and the edits. */
function align(reference, hypothesis, same) {
  const n = reference.length;
  const m = hypothesis.length;
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i += 1) table[i][0] = i;
  for (let j = 0; j <= m; j += 1) table[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (same(reference[i - 1], hypothesis[j - 1]) ? 0 : 1));
  }
  // Which hypothesis word stands where each reference word was: matched or substituted.
  const at = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (table[i][j] === table[i - 1][j - 1] + (same(reference[i - 1], hypothesis[j - 1]) ? 0 : 1)) {
      at[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (table[i][j] === table[i - 1][j] + 1) i -= 1;
    else j -= 1;
  }
  return { errors: table[n][m], at };
}

async function main() {
  for (const needed of [join(whisperDir, 'whisper-cli.exe'), join(modelsDir, 'ggml-small-q5_1.bin'), join(modelsDir, 'ggml-large-v3-turbo-q5_0.bin')]) {
    if (!existsSync(needed)) {
      console.error(`Missing ${needed}`);
      process.exit(2);
    }
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const textFile = join(workDir, 'names.txt');
  await writeFile(textFile, TEXT, 'utf8');
  await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'captions-tts.ps1'), '-Out', workDir, '-TextFile', textFile]);
  const speech = join(workDir, 'speech.wav');
  const truth = JSON.parse((await readFile(join(workDir, 'speech.json'), 'utf8')).replace(/^﻿/, ''));
  const reference = words(TEXT).map(bare);
  // Which reference words are (part of) a name, and which name.
  const nameTokens = new Map();
  NAMES.forEach((name) => words(name).forEach((token) => nameTokens.set(fold(token), name)));
  const nameAt = reference.map((word) => nameTokens.get(fold(word)) ?? null);
  console.log(`${reference.length} words, ${nameAt.filter(Boolean).length} of them names (${NAMES.length} names), voice ${truth.voice}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
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
      ...(existsSync(vadModel) ? { SCF_WHISPER_VAD: vadModel } : {}),
    },
  });
  const report = { voice: truth.voice, names: NAMES, words: reference.length, runs: [] };
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }));
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, speech);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      store.addAssetToTimeline(store.assets[0], store.project.tracks.find((track) => track.type === 'audio').id, 0);
    });
    const prompt = await window.evaluate((names) => {
      // The prompt exactly as the dialog makes it from the glossary.
      window.__scfStore.getState().setGlossary(names);
      return names.join(', ') + '.';
    }, NAMES);

    for (const model of ['fast', 'precise']) {
      for (const withPrompt of [false, true]) {
        await window.evaluate(() => {
          for (const track of window.__scfStore.getState().project.tracks) if (track.type === 'captions') window.__scfStore.getState().removeTrack(track.id);
          window.__scfCaptions.job.setState({ last: null });
        });
        await window.evaluate(([id, text]) => { void window.__scfCaptions.job.getState().start({ language: 'es', source: 'mix', model: id, preset: 'classic', ...(text ? { prompt: text } : {}) }); }, [model, withPrompt ? prompt : '']);
        await window.waitForFunction(() => window.__scfCaptions.job.getState().phase !== 'idle', null, { timeout: 30_000 }).catch(() => undefined);
        await window.waitForFunction(() => window.__scfCaptions.job.getState().phase === 'idle', null, { timeout: 900_000 });
        await sleep(300);
        const written = await window.evaluate(() => {
          const { project } = window.__scfStore.getState();
          return Object.values(project.clips).filter((clip) => clip.caption).sort((a, b) => a.startFrame - b.startFrame).map((clip) => clip.caption.text.replace(/\n/g, ' '));
        });
        const hypothesis = words(written.join(' ')).map(bare).filter(Boolean);
        // Names spelt exactly; and spelt right but for case or accents.
        const exact = align(reference, hypothesis, (a, b) => a === b);
        const loose = align(reference, hypothesis, (a, b) => fold(a) === fold(b));
        let namesExact = 0;
        let namesLoose = 0;
        const asWritten = {};
        nameAt.forEach((name, index) => {
          if (!name) return;
          const got = exact.at[index] === null ? '(nothing)' : hypothesis[exact.at[index]];
          if (got === reference[index]) namesExact += 1;
          if (loose.at[index] !== null && fold(hypothesis[loose.at[index]]) === fold(reference[index])) namesLoose += 1;
          (asWritten[reference[index]] ??= []).push(got);
        });
        // Everything else: the word error rate with the names left out of the count.
        const others = reference.map((word, index) => ({ word, index })).filter(({ index }) => !nameAt[index]);
        let otherErrors = 0;
        for (const { word, index } of others) {
          const got = loose.at[index];
          if (got === null || fold(hypothesis[got]) !== fold(word)) otherErrors += 1;
        }
        // What the glossary's suggestions would put right, taken all.
        const suggestions = await window.evaluate((names) => {
          const { project } = window.__scfStore.getState();
          const track = project.tracks.find((candidate) => candidate.type === 'captions');
          if (!track) return [];
          const store = window.__scfStore.getState();
          const list = window.__scfCaptions.glossarySuggestions(Object.values(project.clips).filter((clip) => clip.trackId === track.id), names);
          // Each taken as the button in the Captions list takes it.
          return list.map((suggestion) => ({ ...suggestion, replaced: store.replaceInCaptions(track.id, suggestion.found, suggestion.term, { matchCase: true, wholeWord: true }) }));
        }, NAMES);
        const after = await window.evaluate(() => {
          const { project } = window.__scfStore.getState();
          return Object.values(project.clips).filter((clip) => clip.caption).sort((a, b) => a.startFrame - b.startFrame).map((clip) => clip.caption.text.replace(/\n/g, ' '));
        });
        const fixedHypothesis = words(after.join(' ')).map(bare).filter(Boolean);
        const fixed = align(reference, fixedHypothesis, (a, b) => a === b);
        let namesAfterSuggestions = 0;
        nameAt.forEach((name, index) => {
          if (name && fixed.at[index] !== null && fixedHypothesis[fixed.at[index]] === reference[index]) namesAfterSuggestions += 1;
        });
        const total = nameAt.filter(Boolean).length;
        const last = await window.evaluate(() => window.__scfCaptions.job.getState().last);
        const run = {
          model,
          prompt: withPrompt,
          namesExact,
          namesLoose,
          namesAfterSuggestions,
          nameTokens: total,
          otherErrors,
          otherWords: others.length,
          otherWer: otherErrors / others.length,
          asWritten,
          suggestions: suggestions.map(({ term, found, count, replaced }) => ({ term, found, count, replaced })),
          seconds: last?.result.elapsedSeconds ?? null,
          ran: last ? `${last.result.ran}${last.result.gpu ? ` (${last.result.gpu})` : ''}` : null,
          text: written.join(' '),
        };
        report.runs.push(run);
        console.log(
          `${model} / ${withPrompt ? 'with the glossary' : 'no prompt'}: names exact ${namesExact}/${total}, right but for case/accents ${namesLoose}/${total}, after taking the suggestions ${namesAfterSuggestions}/${total}; other words: WER ${(run.otherWer * 100).toFixed(2)}% (${otherErrors}/${others.length}); ${run.ran ?? '-'}`,
        );
        console.log(`   as written: ${Object.entries(asWritten).map(([name, list]) => `${name}: ${[...new Set(list)].join(' / ')}`).join('; ')}`);
        if (run.suggestions.length) console.log(`   suggestions: ${run.suggestions.map((s) => `${s.found} -> ${s.term} x${s.count}`).join(', ')}`);
      }
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`report: ${join(workDir, 'report.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
