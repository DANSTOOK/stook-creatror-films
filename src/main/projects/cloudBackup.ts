import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { backupFileName, backupFolderName, prunable } from './backups';
import { renameWithRetry } from './recentProjects';

/**
 * A copy of every save in a folder the cloud keeps: OneDrive's, Google
 * Drive's or Dropbox's on this computer, or any folder chosen - so a dead
 * disk or a stolen laptop does not take the project with it. The sync
 * client does the uploading, as it does for everything else in there; the
 * editor never signs in anywhere.
 *
 * Each project has its own folder under "STOOK Backups", a dated copy per
 * save, the newest twenty kept - the same names as the backups kept on this
 * computer (backups.ts), so either opens with File > Open. The media is not
 * copied: it is usually far bigger than the cloud's free space, and the
 * project names it by path.
 */

export const CLOUD_FOLDER_NAME = 'STOOK Backups';

export interface CloudCandidate {
  label: string;
  path: string;
}

export interface CloudBackupState {
  /** Where copies go, or null when off. */
  folder: string | null;
  /** The cloud folders found on this computer. */
  candidates: CloudCandidate[];
  /** When the last copy was made, and of what. */
  lastAt: string | null;
  lastFile: string | null;
  /** Why the last copy failed, if it did. */
  lastError: string | null;
}

/** The synced folders of the usual clients, where they put them on Windows (and elsewhere). */
export function findCloudFolders(env: NodeJS.ProcessEnv = process.env, home = homedir(), exists = existsSync): CloudCandidate[] {
  const found: CloudCandidate[] = [];
  const add = (label: string, path: string | undefined): void => {
    if (!path || !exists(path)) return;
    if (found.some((candidate) => candidate.path.toLowerCase() === path.toLowerCase())) return;
    found.push({ label, path });
  };
  add('OneDrive', env.OneDrive);
  add('OneDrive', env.OneDriveConsumer);
  add('OneDrive', env.OneDriveCommercial);
  add('Google Drive', join(home, 'Google Drive'));
  add('Google Drive', join(home, 'My Drive'));
  // Google Drive for desktop: a drive of its own, "My Drive" in it.
  if (process.platform === 'win32') {
    for (const letter of 'GHIJKLMNOPQRSTUVWXYZ') {
      for (const name of ['My Drive', 'Mi unidad']) add('Google Drive', `${letter}:\\${name}`);
    }
  }
  add('Dropbox', join(home, 'Dropbox'));
  add('iCloud Drive', join(home, 'iCloudDrive'));
  add('iCloud Drive', join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  return found;
}

export class CloudBackup {
  private folder: string | null = null;
  private lastAt: string | null = null;
  private lastFile: string | null = null;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void>;

  constructor(
    private readonly settingsFile: string,
    private readonly candidates: () => CloudCandidate[] = () => findCloudFolders(),
  ) {
    this.loaded = readFile(settingsFile, 'utf8')
      .then((text) => {
        const folder = (JSON.parse(text) as { folder?: unknown }).folder;
        this.folder = typeof folder === 'string' && folder ? folder : null;
      })
      .catch(() => undefined);
  }

  async state(): Promise<CloudBackupState> {
    await this.loaded;
    await this.queue;
    return { folder: this.folder, candidates: this.candidates(), lastAt: this.lastAt, lastFile: this.lastFile, lastError: this.lastError };
  }

  /** Copies from now on into `folder`, or none (null). */
  async setFolder(folder: string | null): Promise<void> {
    await this.loaded;
    this.folder = folder;
    this.lastError = null;
    await mkdir(join(this.settingsFile, '..'), { recursive: true });
    await writeFile(this.settingsFile, JSON.stringify({ folder }), 'utf8');
  }

  /** Where this project's copies go. */
  root(): string | null {
    return this.folder ? join(this.folder, CLOUD_FOLDER_NAME) : null;
  }

  /**
   * A copy of what was just saved to `path`. Best effort and in order: a
   * save never waits on it or fails because of it.
   */
  copy(path: string, contents: string, when = new Date()): Promise<void> {
    const run = this.queue.then(async () => {
      await this.loaded;
      const root = this.root();
      if (!root || contents.length === 0) return;
      try {
        const folder = join(root, backupFolderName(path));
        await mkdir(folder, { recursive: true });
        const target = join(folder, backupFileName(when));
        await writeFile(`${target}.tmp`, contents, 'utf8');
        await renameWithRetry(`${target}.tmp`, target);
        const names = await readdir(folder).catch(() => []);
        await Promise.all(prunable(names).map((name) => rm(join(folder, name), { force: true })));
        this.lastAt = when.toISOString();
        this.lastFile = target;
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
