import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the speech-to-text program is, and which GPU it should use.
 *
 * The program is whisper.cpp's command line (`whisper-cli`, MIT), run as a
 * child process the way ffmpeg is. The installer carries the build the
 * project's own release workflow compiles with Vulkan and dynamic backends
 * (.github/workflows/release.yml -> resources/whisper): `ggml-vulkan.dll`
 * is loaded when the computer has a Vulkan driver, and when it does not -
 * or has no GPU worth using - the same program runs on the CPU. Nothing is
 * installed on the user's system and no CUDA is needed.
 *
 * Nothing in here needs Electron, so the unit tests can load it.
 */

export interface WhisperEngine {
  dir: string;
  cli: string;
  /** The Vulkan backend ships with this build. */
  vulkan: boolean;
  /** The Silero voice detector's model, when it ships with the build. */
  vadModel: string | null;
}

const CLI_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

/** The engine in `dir`, or null when the program is not there. */
export function engineIn(dir: string): WhisperEngine | null {
  const cli = join(dir, CLI_NAME);
  if (!existsSync(cli)) return null;
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    // Unreadable: no GPU backend, no voice detector.
  }
  const vad = files.find((file) => /^ggml-silero-.*\.bin$/i.test(file));
  return {
    dir,
    cli,
    vulkan: files.some((file) => /^(lib)?ggml-vulkan\.(dll|so|dylib)$/i.test(file)),
    vadModel: vad ? join(dir, vad) : null,
  };
}

/**
 * The first place the program is found: where a test or a developer points
 * (SCF_WHISPER_DIR), inside the installed app (resources/whisper), or where
 * the release workflow puts it in a checkout (build/whisper).
 */
export function findEngine(places: { resourcesPath?: string; appPath?: string; env?: NodeJS.ProcessEnv }): WhisperEngine | null {
  const env = places.env ?? process.env;
  const candidates = [
    env.SCF_WHISPER_DIR,
    places.resourcesPath ? join(places.resourcesPath, 'whisper') : undefined,
    places.appPath ? join(places.appPath, 'build', 'whisper') : undefined,
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const engine = engineIn(dir);
    if (engine) return withVadOverride(engine, env.SCF_WHISPER_VAD);
  }
  return null;
}

/**
 * For measuring the voice detector against the same engine with and without
 * it (tests/bench/captions-vad.mjs): SCF_WHISPER_VAD names a model file to
 * use, or is `off` to use none, whatever the engine's folder holds.
 */
function withVadOverride(engine: WhisperEngine, override: string | undefined): WhisperEngine {
  if (!override) return engine;
  if (override === 'off') return { ...engine, vadModel: null };
  return existsSync(override) ? { ...engine, vadModel: override } : engine;
}

/* Which GPU ------------------------------------------------------------------- */

export interface VulkanDevice {
  /** Its place in Vulkan's own list, which is what GGML_VK_VISIBLE_DEVICES counts in. */
  index: number;
  name: string;
  /** Shares the computer's memory: an integrated GPU. */
  integrated: boolean;
}

/**
 * The GPUs whisper.cpp's Vulkan backend lists as it loads, e.g.
 *   ggml_vulkan: 0 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1 | fp16: 1 | ...
 *   ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | ...
 */
export function parseVulkanDevices(log: string): VulkanDevice[] {
  const devices: VulkanDevice[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /ggml_vulkan:\s*(\d+)\s*=\s*(.+?)\s*(?:\(([^)|]*)\)\s*)?\|(.*)$/.exec(line);
    if (!match) continue;
    const name = match[2].trim();
    const uma = /uma:\s*1/.test(match[4]);
    devices.push({ index: Number(match[1]), name, integrated: uma || isIntegratedName(name) });
  }
  return devices;
}

const isIntegratedName = (name: string): boolean => /\b(intel|uhd|iris|radeon\(tm\) graphics|vega \d|adreno|mali)\b/i.test(name) && !/\barc\b/i.test(name);

/** Not a GPU at all: the CPU drawing as one. */
const isSoftware = (name: string): boolean => /llvmpipe|lavapipe|swiftshader|microsoft basic|software/i.test(name);

/**
 * The GPU to transcribe on: the dedicated one - NVIDIA first, then any other
 * that is not integrated. Never the integrated GPU: on a laptop with both,
 * it is the slow one and the one the screen is drawn with; and alone, it is
 * no faster at this than the processor, which is what is used instead.
 */
export function chooseVulkanDevice(devices: readonly VulkanDevice[]): VulkanDevice | null {
  const real = devices.filter((device) => !isSoftware(device.name) && !device.integrated);
  return real.find((device) => /nvidia|geforce|rtx|gtx|quadro/i.test(device.name)) ?? real[0] ?? null;
}

/** No computer this runs on has more GPUs than this; it only bounds the asking. */
export const MAX_VULKAN_DEVICES = 8;

/**
 * The environment that shows one GPU alone, by Vulkan's own number for it.
 *
 * The GPUs are asked for one at a time. Left to itself the backend lists the
 * ones it would use renumbered from zero - numbers GGML_VK_VISIBLE_DEVICES
 * does not take - and a list naming a GPU that is not there is refused whole
 * ("Invalid device index 2 in GGML_VK_VISIBLE_DEVICES"), with the backend
 * not loading at all: asking for 0 to 7 at once read as "no GPU" on every
 * computer, and every transcription ran on the processor (v1.34.0-beta.1).
 */
export const vulkanProbeEnv = (index: number): Record<string, string> => ({ GGML_VK_VISIBLE_DEVICES: String(index) });

export interface VulkanProbe {
  /** The GPU at that number, when there is one. */
  device: VulkanDevice | null;
  /** That number is past the last GPU: stop asking. */
  past: boolean;
  /** The Vulkan backend said nothing at all: no driver, or it did not load. */
  silent: boolean;
}

/** What the program printed when shown only the GPU at `index`. */
export function readVulkanProbe(log: string, index: number): VulkanProbe {
  if (/invalid device index/i.test(log)) return { device: null, past: true, silent: false };
  const [alone] = parseVulkanDevices(log);
  if (!alone) return { device: null, past: true, silent: !/ggml_vulkan/i.test(log) };
  // Shown alone it calls itself 0; its real number is the one asked for.
  return { device: { ...alone, index }, past: false, silent: false };
}

/* The command line ------------------------------------------------------------- */

export interface WhisperRun {
  model: string;
  /** whisper.cpp's name for the model's alignment heads. */
  dtw: string;
  audio: string;
  /** Output path without its extension; whisper adds `.json`. */
  output: string;
  language: 'es' | 'en';
  threads: number;
  /**
   * The GPU to use; `auto` leaves the choice to the program (which takes
   * dedicated GPUs before integrated ones) when its list could not be read;
   * null runs on the CPU.
   */
  gpu: VulkanDevice | 'auto' | null;
  vadModel: string | null;
}

/**
 * The arguments, and the environment, for one transcription.
 *
 * - `-ojf` writes every token with its times; `-dtw` adds the alignment the
 *   word times are taken from (see shared/captions/whisperOutput), which
 *   needs flash attention off (`-nfa`).
 * - The language is given, never guessed: a wrong guess in the first thirty
 *   seconds transcribes the whole file in the wrong language.
 * - `-pp` prints progress.
 * - With the voice detector, only what it hears as speech is transcribed,
 *   which is what keeps Whisper from writing over silence and music.
 */
export function whisperCommand(run: WhisperRun): { args: string[]; env: Record<string, string> } {
  const args = [
    '-m', run.model,
    '-f', run.audio,
    '-l', run.language,
    '-ojf',
    '-of', run.output,
    '-pp',
    '-t', String(Math.max(1, Math.round(run.threads))),
    '-dtw', run.dtw,
    '-nfa',
  ];
  if (run.vadModel) args.push('--vad', '-vm', run.vadModel);
  const env: Record<string, string> = {};
  if (run.gpu === null) {
    args.push('-ng');
  } else if (run.gpu !== 'auto') {
    // Only this GPU exists as far as the program is concerned, so it is device 0.
    env.GGML_VK_VISIBLE_DEVICES = String(run.gpu.index);
    args.push('-dev', '0');
  }
  return { args, env };
}

/**
 * Threads for a run. On the GPU the processor only feeds it. On the CPU,
 * half the cores, eight at most: transcription must not take the editor's
 * playback down with it, and past eight threads whisper gains little.
 */
export function threadsFor(cores: number, onGpu: boolean): number {
  if (onGpu) return Math.max(1, Math.min(4, cores));
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}
