import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The recent-projects list behind the start screen.
 *
 * DaVinci Resolve opens on its Project Manager and Premiere on a Home screen
 * of recent projects: the first thing an editor wants is the edit they left.
 * This keeps that list - path, name, when, the project's shape and a small
 * thumbnail - in a folder of its own under userData, as Electron recommends
 * (userData itself also holds Chromium's caches).
 *
 * The file is replaced atomically (written aside, then renamed over), and
 * updates are serialised, so a crash mid-write or two saves at once cannot
 * leave a truncated or half-merged list. Whatever is on disk is validated on
 * the way in: a damaged entry is dropped, never trusted.
 */

export interface RecentProjectEntry {
  path: string;
  name: string;
  /** ISO time the project was last opened, created or saved. */
  lastOpened: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  clipCount: number;
  /** File name of its thumbnail in the thumbnails folder, if one was taken. */
  thumbnail?: string;
}

export const MAX_RECENT_PROJECTS = 20;

/**
 * Rename over a file, retrying briefly when Windows says it is in use.
 *
 * An antivirus or indexer holding the old file for a moment makes the rename
 * fail with EPERM or EBUSY; a few milliseconds later it goes through.
 */
export async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
      await new Promise((done) => setTimeout(done, 30 * attempt));
    }
  }
}

/** Characters Windows does not allow in a file name, and control characters. */
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** A project name made safe to use as a file name; empty when nothing usable is left. */
export function cleanProjectName(name: string): string {
  return name
    .replace(INVALID_NAME_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
}

export function projectNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(scf|fep|json)$/i, '') || base;
}

/** Windows paths compare without case and with either slash; elsewhere, exactly. */
export function samePath(a: string, b: string, caseInsensitive = process.platform === 'win32'): boolean {
  const normalise = (path: string): string => {
    const slashed = path.replace(/[\\/]+/g, '/');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  return normalise(a) === normalise(b);
}

export function thumbnailNameFor(path: string, caseInsensitive = process.platform === 'win32'): string {
  const key = path.replace(/[\\/]+/g, '/');
  return `${createHash('sha1').update(caseInsensitive ? key.toLowerCase() : key).digest('hex').slice(0, 16)}.jpg`;
}

const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A list read from disk: validated, newest first, one entry per file, at most MAX_RECENT_PROJECTS. */
export function normalizeRecent(raw: unknown, caseInsensitive?: boolean): RecentProjectEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: RecentProjectEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) continue;

    const lastOpened =
      typeof record.lastOpened === 'string' && !Number.isNaN(Date.parse(record.lastOpened))
        ? record.lastOpened
        : new Date(0).toISOString();
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : projectNameFromPath(record.path);
    const thumbnail =
      typeof record.thumbnail === 'string' && /^[a-f0-9]{16}\.jpg$/.test(record.thumbnail) ? record.thumbnail : undefined;

    entries.push({
      path: record.path,
      name,
      lastOpened,
      width: finite(record.width),
      height: finite(record.height),
      fps: finite(record.fps),
      durationFrames: finite(record.durationFrames),
      clipCount: finite(record.clipCount),
      ...(thumbnail ? { thumbnail } : {}),
    });
  }

  entries.sort((a, b) => Date.parse(b.lastOpened) - Date.parse(a.lastOpened));
  const unique: RecentProjectEntry[] = [];
  for (const entry of entries) {
    if (!unique.some((kept) => samePath(kept.path, entry.path, caseInsensitive))) unique.push(entry);
  }
  return unique.slice(0, MAX_RECENT_PROJECTS);
}

/** `entry` at the top of the list; what falls off the end is returned so its thumbnail can go. */
export function recordRecent(
  list: readonly RecentProjectEntry[],
  entry: RecentProjectEntry,
  caseInsensitive?: boolean,
): { list: RecentProjectEntry[]; dropped: RecentProjectEntry[] } {
  const next = [entry, ...list.filter((existing) => !samePath(existing.path, entry.path, caseInsensitive))];
  return { list: next.slice(0, MAX_RECENT_PROJECTS), dropped: next.slice(MAX_RECENT_PROJECTS) };
}

/** The entry for `from`, now at `to` and called `name`; the list otherwise as it was. */
export function renameRecent(
  list: readonly RecentProjectEntry[],
  from: string,
  to: string,
  name: string,
  caseInsensitive?: boolean,
): RecentProjectEntry[] {
  return list.map((entry) => (samePath(entry.path, from, caseInsensitive) ? { ...entry, path: to, name } : entry));
}

export function removeRecent(
  list: readonly RecentProjectEntry[],
  path: string,
  caseInsensitive?: boolean,
): { list: RecentProjectEntry[]; removed: RecentProjectEntry | undefined } {
  return {
    list: list.filter((entry) => !samePath(entry.path, path, caseInsensitive)),
    removed: list.find((entry) => samePath(entry.path, path, caseInsensitive)),
  };
}

export function findRecent(
  list: readonly RecentProjectEntry[],
  path: string,
  caseInsensitive?: boolean,
): RecentProjectEntry | undefined {
  return list.find((entry) => samePath(entry.path, path, caseInsensitive));
}

export class RecentProjectsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly folder: string) {}

  get file(): string {
    return join(this.folder, 'recent-projects.json');
  }

  thumbnailPath(name: string): string {
    return join(this.folder, 'thumbnails', name);
  }

  async read(): Promise<RecentProjectEntry[]> {
    const text = await readFile(this.file, 'utf8').catch(() => null);
    if (text === null) return [];
    try {
      return normalizeRecent(JSON.parse(text));
    } catch {
      return [];
    }
  }

  /**
   * Read, change and write back, one update at a time.
   *
   * Serialised because a save records its project while the start screen may
   * be removing another: two read-modify-writes interleaved would lose one.
   */
  update<T>(
    change: (list: RecentProjectEntry[]) => { list: RecentProjectEntry[]; result?: T; deleteThumbnails?: string[] },
  ): Promise<T | undefined> {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const { list, result, deleteThumbnails = [] } = change(current);
      await mkdir(this.folder, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
      await renameWithRetry(temporary, this.file);
      await Promise.all(deleteThumbnails.map((name) => rm(this.thumbnailPath(name), { force: true })));
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async writeThumbnail(name: string, bytes: Uint8Array): Promise<void> {
    await mkdir(join(this.folder, 'thumbnails'), { recursive: true });
    await writeFile(this.thumbnailPath(name), bytes);
  }
}
