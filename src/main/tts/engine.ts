import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the text-to-speech program is, and the command line for one run.
 *
 * The program is Piper's command line (`piper`, MIT), spawned as a child
 * process the way ffmpeg and whisper-cli are. The installer carries the
 * build staged by the release workflow (.github/workflows/release.yml ->
 * resources/piper); in a checkout it is found in build/piper. The espeak-ng
 * phonemiser data sits beside the executable, so Piper finds it on its own.
 *
 * Nothing in here needs Electron, so the unit tests can load it.
 */

export interface PiperEngine {
  dir: string;
  bin: string;
}

const BIN_NAME = process.platform === 'win32' ? 'piper.exe' : 'piper';

/** The engine in `dir`, or null when the program is not there. */
export function engineIn(dir: string): PiperEngine | null {
  const bin = join(dir, BIN_NAME);
  return existsSync(bin) ? { dir, bin } : null;
}

/**
 * The first place the program is found: where a test or developer points
 * (SCF_TTS_DIR), inside the installed app (resources/piper), or where the
 * release workflow puts it in a checkout (build/piper).
 */
export function findEngine(places: { resourcesPath?: string; appPath?: string; env?: NodeJS.ProcessEnv }): PiperEngine | null {
  const env = places.env ?? process.env;
  const candidates = [
    env.SCF_TTS_DIR,
    places.resourcesPath ? join(places.resourcesPath, 'piper') : undefined,
    places.appPath ? join(places.appPath, 'build', 'piper') : undefined,
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const engine = engineIn(dir);
    if (engine) return engine;
  }
  return null;
}

export interface PiperRun {
  /** The voice weight file (.onnx); its .onnx.json sits beside it. */
  model: string;
  /** Multi-speaker models choose a voice by id; ignored by single-speaker ones. */
  speakerId: number;
  /** The WAV the program writes. */
  output: string;
  /**
   * How fast to speak, as a multiplier (1 = the voice's natural pace). Piper
   * controls pace by `length_scale`, where larger is SLOWER, so the speed is
   * inverted here. Clamped to a sane range so a slider can never stall the
   * engine or make it unintelligible.
   */
  speed: number;
  /** Seconds of silence between sentences. */
  sentenceSilence?: number;
}

/**
 * The arguments for one synthesis. The text itself is NOT on the command
 * line: it is written to the program's standard input, so nothing in it is
 * ever interpreted as an argument and any length and any characters are safe.
 *
 * Piper has no pitch control (a VITS model speaks at the pitch it learned),
 * so only speed is exposed; the panel says as much.
 */
export function piperCommand(run: PiperRun): string[] {
  const lengthScale = 1 / clampSpeed(run.speed);
  const args = [
    '--model', run.model,
    '--output_file', run.output,
    '--length_scale', lengthScale.toFixed(4),
    '--speaker', String(Math.max(0, Math.round(run.speakerId))),
  ];
  if (run.sentenceSilence !== undefined) {
    args.push('--sentence_silence', Math.max(0, run.sentenceSilence).toFixed(3));
  }
  return args;
}

/**
 * Kokoro's program: sherpa-onnx's `sherpa-onnx-offline-tts` (Apache-2.0),
 * in resources/sherpa-onnx when installed and build/sherpa-onnx in a
 * checkout (or SCF_KOKORO_DIR). Its own onnxruntime.dll sits beside it,
 * apart from Piper's, which is another version.
 */
const KOKORO_BIN = process.platform === 'win32' ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts';

export function kokoroEngineIn(dir: string): PiperEngine | null {
  const bin = join(dir, KOKORO_BIN);
  return existsSync(bin) ? { dir, bin } : null;
}

export function findKokoroEngine(places: { resourcesPath?: string; appPath?: string; env?: NodeJS.ProcessEnv }): PiperEngine | null {
  const env = places.env ?? process.env;
  const candidates = [
    env.SCF_KOKORO_DIR,
    places.resourcesPath ? join(places.resourcesPath, 'sherpa-onnx') : undefined,
    places.appPath ? join(places.appPath, 'build', 'sherpa-onnx') : undefined,
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const engine = kokoroEngineIn(dir);
    if (engine) return engine;
  }
  return null;
}

/**
 * Text for a Windows program's command line, so that it receives UTF-8.
 *
 * sherpa-onnx reads its text from `argv`, which Windows hands a program in
 * the system's ANSI code page, not UTF-8: "español" arrived as "espa?ol",
 * and espeak spelled out what it could not read ("Spaya half all"). Its
 * UTF-8 bytes, read as that code page, are a string Windows turns back into
 * exactly those bytes. Every Western single-byte code page round-trips each
 * byte; anywhere else, the accents are dropped rather than garbled.
 */
export function commandLineText(text: string, codePage: number | null): string {
  if (codePage === null) return text;
  if (SINGLE_BYTE_CODE_PAGES.has(codePage)) return new TextDecoder(`windows-${codePage}`).decode(Buffer.from(text, 'utf8'));
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, ' ');
}

const SINGLE_BYTE_CODE_PAGES = new Set([874, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258]);

let codePage: number | null | undefined;
/** The system's ANSI code page on Windows (null elsewhere: there argv is UTF-8 already). */
export function windowsCodePage(): number | null {
  if (codePage !== undefined) return codePage;
  codePage = null;
  if (process.platform !== 'win32') return codePage;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { encoding: 'utf8', windowsHide: true });
    const found = Number(/ACP\s+REG_SZ\s+(\d+)/.exec(out)?.[1]);
    codePage = Number.isFinite(found) && found > 0 ? found : 1252;
  } catch {
    codePage = 1252;
  }
  return codePage;
}

export interface KokoroRun {
  /** The model's folder: model.int8.onnx, voices.bin, tokens.txt. */
  modelDir: string;
  /** espeak-ng's data (Piper's, the same files). */
  espeakData: string;
  /** Which of the model's voices. */
  speakerId: number;
  /** espeak-ng's voice for the text: es-419 for Latin American Spanish. */
  phonemes: string;
  /** The system's ANSI code page on Windows (windowsCodePage), for the text on the command line. */
  codePage?: number | null;
  output: string;
  speed: number;
  threads: number;
  text: string;
}

/**
 * The arguments for one Kokoro run. sherpa-onnx takes the text as the last
 * argument, not on stdin; spawned without a shell, nothing in it is
 * interpreted - but a leading dash would read as an option, so it goes, and
 * so do line breaks (one piece is one line).
 */
export function kokoroCommand(run: KokoroRun): string[] {
  const text = run.text.replace(/[\r\n]+/g, ' ').replace(/^[\s\-–—]+/, '').trim();
  return [
    `--kokoro-model=${join(run.modelDir, 'model.int8.onnx')}`,
    `--kokoro-voices=${join(run.modelDir, 'voices.bin')}`,
    `--kokoro-tokens=${join(run.modelDir, 'tokens.txt')}`,
    `--kokoro-data-dir=${run.espeakData}`,
    `--kokoro-lang=${run.phonemes}`,
    // Larger is slower, as Piper's length_scale.
    `--kokoro-length-scale=${(1 / clampSpeed(run.speed)).toFixed(4)}`,
    `--num-threads=${Math.max(1, Math.min(8, Math.round(run.threads)))}`,
    `--sid=${Math.max(0, Math.round(run.speakerId))}`,
    `--output-filename=${run.output}`,
    commandLineText(text, run.codePage ?? null),
  ];
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** A speed a slider can send, held to a range that stays intelligible. */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/**
 * Long text, split into pieces the engine handles well, each a sentence or a
 * run of short ones. Piper reads one line as one utterance; very long input
 * is better fed a sentence at a time so progress can be reported and a cancel
 * lands quickly. Splitting is by sentence end, then pieces are packed up to
 * `maxChars` so short sentences are not each their own process round-trip.
 */
export function splitText(text: string, maxChars = 400): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const sentences = clean
    .split(/(?<=[.!?…。])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((sentence) => (sentence.length > maxChars ? splitLongSentence(sentence, maxChars) : [sentence]));
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 <= maxChars) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * A sentence longer than `maxChars` - a pasted paragraph with no full stop,
 * a list run together - in pieces no longer than that: at a comma, semicolon,
 * colon or dash where there is one, else between words. Kokoro reads at most
 * about 500 sounds at once and a single run of thousands of characters went
 * to the engine whole; Piper's prosody drifts on one that long.
 */
export function splitLongSentence(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const add = (part: string): void => {
    if (current && current.length + part.length + 1 > maxChars) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current} ${part}` : part;
  };
  for (const clause of sentence.split(/(?<=[,;:])\s+|\s+(?=[—–-]\s)/)) {
    if (clause.length <= maxChars) {
      add(clause);
      continue;
    }
    for (const word of clause.split(' ')) {
      // A "word" longer than the budget (a URL, a run of symbols) is cut where it must be.
      for (let at = 0; at < word.length; at += maxChars) add(word.slice(at, at + maxChars));
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
