import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CAPTION_MODELS, type CaptionModel } from './catalog';

/**
 * The speech models on this computer: downloading, checking, importing and
 * deleting them.
 *
 * A model is only ever used after its SHA-256 has matched the one fixed in
 * the catalogue. Hashing half a gigabyte takes a couple of seconds, so it is
 * done once - as the file arrives - and remembered in a small file beside
 * the model (`<model>.verified`: the hash, the size and the modified time).
 * If the model changes on disk, that no longer matches and it is hashed
 * again before it is run.
 *
 * Nothing here needs Electron: the download takes the `fetch` to use, so
 * the app passes Chromium's (which honours the system proxy) and the tests
 * pass their own.
 */

export class ChecksumError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`SHA-256 mismatch: expected ${expected}, got ${actual}`);
    this.name = 'ChecksumError';
  }
}

export const modelPath = (dir: string, model: CaptionModel): string => join(dir, model.file);
const markerPath = (dir: string, model: CaptionModel): string => `${modelPath(dir, model)}.verified`;
const partPath = (dir: string, model: CaptionModel): string => `${modelPath(dir, model)}.part`;

export async function sha256OfFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024, signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function writeMarker(dir: string, model: CaptionModel): Promise<void> {
  const info = await stat(modelPath(dir, model));
  await writeFile(markerPath(dir, model), JSON.stringify({ sha256: model.sha256, size: info.size, mtimeMs: info.mtimeMs }), 'utf8');
}

/**
 * Whether the model is here and is the real one. Cheap when it was checked
 * before and has not changed since; otherwise the file is hashed.
 */
export async function isModelReady(dir: string, model: CaptionModel): Promise<boolean> {
  const path = modelPath(dir, model);
  let info;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (info.size !== model.bytes) return false;
  try {
    const marker = JSON.parse(await readFile(markerPath(dir, model), 'utf8')) as { sha256?: string; size?: number; mtimeMs?: number };
    if (marker.sha256 === model.sha256 && marker.size === info.size && marker.mtimeMs === info.mtimeMs) return true;
  } catch {
    // No marker, or not one of ours: hash the file.
  }
  if ((await sha256OfFile(path)) !== model.sha256) return false;
  await writeMarker(dir, model);
  return true;
}

export interface DownloadOptions {
  fetch: (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Response>;
  signal: AbortSignal;
  onProgress?: (received: number, total: number) => void;
}

/**
 * Download a model into `dir`, hashing it as it arrives. The file only
 * takes its real name once the hash has matched; anything else - a wrong
 * hash, a cancel, a dropped connection - leaves nothing behind.
 */
export async function downloadModel(dir: string, model: CaptionModel, options: DownloadOptions): Promise<void> {
  await mkdir(dir, { recursive: true });
  const part = partPath(dir, model);
  const hash = createHash('sha256');
  let received = 0;
  try {
    const response = await options.fetch(model.url, { signal: options.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || model.bytes;
    const out = createWriteStream(part);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve));
        options.onProgress?.(received, total);
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
    const actual = hash.digest('hex');
    if (received !== model.bytes || actual !== model.sha256) throw new ChecksumError(model.sha256, actual);
    await rename(part, modelPath(dir, model));
    await writeMarker(dir, model);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/**
 * Take a model from a file the user already has (copied from another
 * computer, say). Which model it is, is told by its hash: a file that is
 * neither of the two is refused, whatever it is called.
 */
export async function importModel(dir: string, source: string): Promise<CaptionModel> {
  const info = await stat(source);
  const candidates = CAPTION_MODELS.filter((model) => model.bytes === info.size);
  const actual = candidates.length > 0 ? await sha256OfFile(source) : '';
  const model = candidates.find((candidate) => candidate.sha256 === actual);
  if (!model) throw new ChecksumError(CAPTION_MODELS.map((candidate) => candidate.sha256).join(' | '), actual || `a file of ${info.size} bytes`);
  await mkdir(dir, { recursive: true });
  const part = partPath(dir, model);
  try {
    await new Promise<void>((resolve, reject) => {
      const from = createReadStream(source);
      const to = createWriteStream(part);
      from.on('error', reject);
      to.on('error', reject);
      to.on('finish', resolve);
      from.pipe(to);
    });
    // The copy is what will be run, so the copy is what is checked.
    const copied = await sha256OfFile(part);
    if (copied !== model.sha256) throw new ChecksumError(model.sha256, copied);
    await rename(part, modelPath(dir, model));
    await writeMarker(dir, model);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return model;
}

export async function deleteModel(dir: string, model: CaptionModel): Promise<void> {
  await rm(modelPath(dir, model), { force: true });
  await rm(markerPath(dir, model), { force: true });
  await rm(partPath(dir, model), { force: true });
}

/** Whether a download left half a file behind (a crash, the power going). */
export const hasLeftover = (dir: string, model: CaptionModel): boolean => existsSync(partPath(dir, model));
