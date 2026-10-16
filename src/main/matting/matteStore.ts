import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MatteModelId } from '@shared/types';
import { MATTE_FORMAT_VERSION } from '@shared/matte/format';
import { proxyKey, type SourceStamp } from '../media/proxies';

/**
 * The mattes kept on this computer, one file per source file and model,
 * the way proxies are kept (media/proxies.ts): beside the app's other data,
 * never in the project, rebuilt on demand if thrown away.
 *
 * Keyed by the file's path, size and modification time - so a file changed
 * on disk, or a clip relinked to another, never finds the old file's mattes -
 * and by the model and by how the mattes are made. MATTE_RECIPE goes up
 * whenever that changes (the smoothing, the size they are kept at), so a
 * cache made the old way is not read as if it were the new.
 */

export const MATTE_RECIPE = 1;

export const MATTE_EXTENSION = '.scfmatte';

export function matteKey(stamp: SourceStamp, model: MatteModelId): string {
  return `${proxyKey(stamp)}-${model}-v${MATTE_FORMAT_VERSION}.${MATTE_RECIPE}`;
}

export interface MatteRecord {
  key: string;
  file: string;
  bytes: number;
}

export class MatteFolder {
  constructor(readonly folder: string) {}

  fileFor(key: string): string {
    return join(this.folder, `${key}${MATTE_EXTENSION}`);
  }

  /** Where a build writes until it is complete. Never read: see the worker. */
  partFor(key: string): string {
    return join(this.folder, `${key}.building-${process.pid}${MATTE_EXTENSION}.part`);
  }

  async stampFor(path: string): Promise<SourceStamp | null> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    return { path, bytes: info.size, modifiedMs: info.mtimeMs };
  }

  async keyFor(path: string, model: MatteModelId): Promise<string | null> {
    const stamp = await this.stampFor(path);
    return stamp ? matteKey(stamp, model) : null;
  }

  /** The finished mattes for this file and model, or null. */
  async find(path: string, model: MatteModelId): Promise<MatteRecord | null> {
    const key = await this.keyFor(path, model);
    if (!key) return null;
    const file = this.fileFor(key);
    const info = await stat(file).catch(() => null);
    return info?.isFile() && info.size > 0 ? { key, file, bytes: info.size } : null;
  }

  async ensure(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
  }

  async list(): Promise<MatteRecord[]> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(MATTE_EXTENSION))
        .map(async (name) => {
          const file = join(this.folder, name);
          const info = await stat(file).catch(() => null);
          return info?.isFile() ? { key: name.slice(0, -MATTE_EXTENSION.length), file, bytes: info.size } : null;
        }),
    );
    return records.filter((record): record is MatteRecord => record !== null);
  }

  /** Throw every matte away, and whatever a crashed build left behind. */
  async clear(): Promise<number> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    const doomed = names.filter((name) => name.endsWith(MATTE_EXTENSION) || name.endsWith(`${MATTE_EXTENSION}.part`));
    await Promise.all(doomed.map((name) => rm(join(this.folder, name), { force: true })));
    return doomed.filter((name) => name.endsWith(MATTE_EXTENSION)).length;
  }

  /** Half-written files from a session that did not finish (a crash, the power going). */
  async sweepLeftovers(): Promise<void> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    const mine = `.building-${process.pid}`;
    await Promise.all(
      names
        .filter((name) => name.endsWith(`${MATTE_EXTENSION}.part`) && !name.includes(mine))
        .map((name) => rm(join(this.folder, name), { force: true })),
    );
  }
}
