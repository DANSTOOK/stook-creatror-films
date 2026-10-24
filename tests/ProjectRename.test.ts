import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renameRecent, type RecentProjectEntry } from '../src/main/projects/recentProjects';
import { BackupStore, backupFolderName } from '../src/main/projects/backups';

const made: string[] = [];
const temp = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), 'scf-rename-'));
  made.push(folder);
  return folder;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const entry = (path: string, name: string): RecentProjectEntry => ({
  path,
  name,
  lastOpened: new Date(Date.UTC(2026, 9, 24)).toISOString(),
  width: 1920,
  height: 1080,
  fps: 30,
  durationFrames: 900,
  clipCount: 3,
});

describe('a project renamed from the title bar', () => {
  it('keeps its place on the start screen, under its new path and name', () => {
    const list = [entry('C:\\Projects\\Trip.scf', 'Trip'), entry('C:\\Projects\\Other.scf', 'Other')];
    const renamed = renameRecent(list, 'c:/projects/trip.scf', 'C:\\Projects\\Beach day.scf', 'Beach day', true);
    expect(renamed.map((item) => [item.path, item.name])).toEqual([
      ['C:\\Projects\\Beach day.scf', 'Beach day'],
      ['C:\\Projects\\Other.scf', 'Other'],
    ]);
    expect(renamed[0].lastOpened).toBe(list[0].lastOpened);
  });

  it('takes its backups with it', async () => {
    const root = await temp();
    const store = new BackupStore(root);
    const project = join(root, 'Trip.scf');
    await writeFile(project, '{"v":1}');
    await store.keep(project);
    await store.move(project, join(root, 'Beach day.scf'));
    expect(await readdir(root)).toContain(backupFolderName(join(root, 'Beach day.scf')));
    expect((await store.list(join(root, 'Beach day.scf'))).length).toBe(1);
    expect(await store.list(project)).toEqual([]);
  });
});
