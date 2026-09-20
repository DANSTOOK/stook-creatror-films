import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanProjectName, projectNameFromPath, renameWithRetry } from './recentProjects';

/**
 * Copies of a project as it was before each save, and a net under work that
 * has never been saved at all.
 *
 * Two different fears, kept apart on purpose:
 *
 * - A **backup** is the file as it stood before the save that replaced it. It
 *   costs nothing to keep - the previous contents are already on disk when a
 *   save begins - and it is the only way back from an edit that looked right
 *   at the time. The newest twenty are kept per project, which is an evening's
 *   work at five-minute autosaves.
 * - The **recovery snapshot** is for a project with no file yet. Nothing on
 *   disk would survive the window closing, so the snapshot is written into the
 *   app's own folder and offered back on the next start. It is cleared as soon
 *   as the work is saved properly or deliberately let go, so an offer to
 *   recover always means something really was left behind.
 *
 * Both live under the app's user data, never beside the user's project: a
 * folder full of dated copies next to the file is somebody else's idea of
 * tidy, and on a shared drive it is a mess.
 */

export const MAX_BACKUPS = 20;

/** A short, stable stand-in for a full path, so two projects of the same name do not share a folder. */
export function pathKey(path: string): string {
  // Case and slashes do not distinguish a file on Windows, so they do not
  // distinguish a folder of its backups either.
  const normalised = path.replace(/\\/g, '/').toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < normalised.length; index += 1) {
    hash ^= normalised.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** The folder a project's backups go in: readable name, unique key. */
export function backupFolderName(path: string): string {
  const name = cleanProjectName(projectNameFromPath(path)) || 'project';
  return `${name}-${pathKey(path)}`;
}

/** A file name that sorts by time and survives every file system. */
export function backupFileName(when: Date): string {
  return `${when.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}.scf`;
}

/** The moment a backup file name stands for, or null if it is not one of ours. */
export function backupTime(fileName: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})\.scf$/.exec(fileName);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, ms] = match;
  const when = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`,
  );
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * Which files to delete to keep only the newest `keep`.
 *
 * Pure, and it decides by the time in the name rather than by the file's own
 * timestamp: copying a backups folder between machines rewrites those, and the
 * order they were made in is the only order that matters here.
 */
export function prunable(fileNames: readonly string[], keep = MAX_BACKUPS): string[] {
  const ours = fileNames
    .map((name) => ({ name, when: backupTime(name) }))
    .filter((entry): entry is { name: string; when: Date } => entry.when !== null)
    .sort((a, b) => b.when.getTime() - a.when.getTime());
  return ours.slice(Math.max(0, keep)).map((entry) => entry.name);
}

export interface BackupEntry {
  /** The file, as `read` takes it. */
  file: string;
  /** When the save that replaced this copy happened. */
  savedAt: string;
  bytes: number;
}

export class BackupStore {
  constructor(private readonly folder: string) {}

  private folderFor(path: string): string {
    return join(this.folder, backupFolderName(path));
  }

  /**
   * Keep what is in `path` now, before something else is written over it.
   *
   * Best effort by design: a project that cannot be backed up must still be
   * saveable, so every failure here is swallowed by the caller. A first save
   * has nothing to keep, which is not a failure either.
   */
  async keep(path: string, when = new Date()): Promise<string | null> {
    const previous = await readFile(path, 'utf8').catch(() => null);
    if (previous === null || previous.length === 0) return null;

    const folder = this.folderFor(path);
    await mkdir(folder, { recursive: true });
    const target = join(folder, backupFileName(when));
    const temporary = `${target}.tmp`;
    await writeFile(temporary, previous, 'utf8');
    await renameWithRetry(temporary, target);

    const names = await readdir(folder).catch(() => []);
    await Promise.all(prunable(names).map((name) => rm(join(folder, name), { force: true })));
    return target;
  }

  /** The copies of this project, newest first. */
  async list(path: string): Promise<BackupEntry[]> {
    const folder = this.folderFor(path);
    const names = await readdir(folder).catch(() => []);
    const entries = await Promise.all(
      names.map(async (name) => {
        const when = backupTime(name);
        if (!when) return null;
        const info = await stat(join(folder, name)).catch(() => null);
        if (!info) return null;
        return { file: join(folder, name), savedAt: when.toISOString(), bytes: info.size };
      }),
    );
    return entries
      .filter((entry): entry is BackupEntry => entry !== null)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /** A copy's contents, for opening it. Only files inside the backups folder. */
  async read(file: string): Promise<string | null> {
    const inside = file.replace(/\\/g, '/').toLowerCase().startsWith(this.folder.replace(/\\/g, '/').toLowerCase());
    if (!inside) return null;
    return readFile(file, 'utf8').catch(() => null);
  }
}

export interface RecoverySnapshot {
  /** What the project was called on screen. */
  name: string;
  /** The file it belongs to, or null when it has never been saved. */
  path: string | null;
  savedAt: string;
  contents: string;
}

/** Shape check for a snapshot read back off disk, which may be from any older build. */
export function readSnapshot(raw: unknown): RecoverySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<RecoverySnapshot>;
  if (typeof entry.contents !== 'string' || entry.contents.length === 0) return null;
  return {
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : 'Untitled project',
    path: typeof entry.path === 'string' ? entry.path : null,
    savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : new Date(0).toISOString(),
    contents: entry.contents,
  };
}

export class RecoveryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly folder: string) {}

  get file(): string {
    return join(this.folder, 'recovery.json');
  }

  /** Write the snapshot, one at a time, so a slow write cannot be overtaken by the next. */
  write(snapshot: RecoverySnapshot): Promise<void> {
    const run = this.queue.then(async () => {
      await mkdir(this.folder, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
      await renameWithRetry(temporary, this.file);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async read(): Promise<RecoverySnapshot | null> {
    const text = await readFile(this.file, 'utf8').catch(() => null);
    if (text === null) return null;
    try {
      return readSnapshot(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.queue = this.queue.then(() => rm(this.file, { force: true })).catch(() => undefined);
    await this.queue;
  }
}
