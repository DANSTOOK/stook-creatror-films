import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadModel, isModelReady, type DownloadOptions, type ModelFile } from '../subtitles/models';
import type { TtsVoice } from './catalog';

/**
 * Where a voice's files are on this computer, and fetching the optional ones.
 *
 * A voice is two files: `<file>.onnx` and `<file>.onnx.json`. Bundled voices
 * ship in the installer (resources/tts-voices) and in a checkout sit in
 * build/tts-voices; downloadable voices land in the app's data folder next to
 * the captions models. Downloading and checksumming reuse the captions code
 * (main/subtitles/models.ts), which already does exactly this for one file -
 * here it is called once for the weights and once for the configuration, each
 * against the SHA-256 fixed in the catalogue.
 */

export interface VoiceDirs {
  /** Read-only, inside the build/installer. */
  bundled: string[];
  /** Writable, in the app's data folder, for downloaded voices. */
  downloaded: string;
}

/** The two files a voice is made of, as `ModelFile`s the download code understands. */
function voiceFiles(voice: TtsVoice): { onnx: ModelFile; json: ModelFile } | null {
  if (!voice.onnx || !voice.json) return null;
  return {
    onnx: { file: `${voice.file}.onnx`, bytes: voice.onnx.bytes, sha256: voice.onnx.sha256, url: voice.onnx.url },
    json: { file: `${voice.file}.onnx.json`, bytes: voice.json.bytes, sha256: voice.json.sha256, url: voice.json.url },
  };
}

/** The folder a voice's .onnx is in, or null when it is not on this computer. */
export function voiceDir(voice: TtsVoice, dirs: VoiceDirs): string | null {
  const onnx = `${voice.file}.onnx`;
  const json = `${voice.file}.onnx.json`;
  for (const dir of dirs.bundled) {
    if (existsSync(join(dir, onnx)) && existsSync(join(dir, json))) return dir;
  }
  if (existsSync(join(dirs.downloaded, onnx)) && existsSync(join(dirs.downloaded, json))) return dirs.downloaded;
  return null;
}

/** The path to a voice's .onnx, or null when it is not here. */
export function voiceModelPath(voice: TtsVoice, dirs: VoiceDirs): string | null {
  const dir = voiceDir(voice, dirs);
  return dir ? join(dir, `${voice.file}.onnx`) : null;
}

/**
 * Whether a voice is ready to use. Bundled voices need only be present (they
 * are part of the trusted build); a downloaded voice is checked against its
 * SHA-256 the way captions models are.
 */
export async function isVoiceReady(voice: TtsVoice, dirs: VoiceDirs): Promise<boolean> {
  const dir = voiceDir(voice, dirs);
  if (!dir) return false;
  if (dirs.bundled.includes(dir)) return true;
  const files = voiceFiles(voice);
  if (!files) return true;
  return (await isModelReady(dir, files.onnx)) && (await isModelReady(dir, files.json));
}

/** Download an optional voice (both files) into the writable folder, each verified. */
export async function downloadVoice(
  voice: TtsVoice,
  dirs: VoiceDirs,
  options: Omit<DownloadOptions, 'onProgress'> & { onProgress?: (received: number, total: number) => void },
): Promise<void> {
  const files = voiceFiles(voice);
  if (!files) throw new Error('This voice has no download');
  await mkdir(dirs.downloaded, { recursive: true });
  // The configuration is tiny; the weights dominate, so progress tracks them.
  await downloadModel(dirs.downloaded, files.json, { ...options, onProgress: undefined });
  await downloadModel(dirs.downloaded, files.onnx, options);
}

/** Remove a downloaded voice's files (bundled voices are left alone). */
export async function deleteVoice(voice: TtsVoice, dirs: VoiceDirs): Promise<void> {
  const files = voiceFiles(voice);
  if (!files) return;
  await rm(join(dirs.downloaded, files.onnx.file), { force: true });
  await rm(join(dirs.downloaded, `${files.onnx.file}.verified`), { force: true });
  await rm(join(dirs.downloaded, `${files.onnx.file}.part`), { force: true });
  await rm(join(dirs.downloaded, files.json.file), { force: true });
  await rm(join(dirs.downloaded, `${files.json.file}.verified`), { force: true });
  await rm(join(dirs.downloaded, `${files.json.file}.part`), { force: true });
}
