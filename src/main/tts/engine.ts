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
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    // A single sentence longer than the budget still goes on its own.
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(sentence);
      continue;
    }
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
