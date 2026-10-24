import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOUD_FOLDER_NAME, CloudBackup, findCloudFolders } from '../src/main/projects/cloudBackup';

const made: string[] = [];
const temp = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), 'scf-cloud-'));
  made.push(folder);
  return folder;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe('cloud backup', () => {
  it('finds the sync folders that are there, once each', () => {
    const there = new Set(['C:\\Users\\me\\OneDrive', 'C:\\Users\\me\\Dropbox']);
    const found = findCloudFolders({ OneDrive: 'C:\\Users\\me\\OneDrive', OneDriveConsumer: 'C:\\Users\\me\\onedrive' }, 'C:\\Users\\me', (path) => there.has(String(path)) || String(path).toLowerCase() === 'c:\\users\\me\\onedrive');
    expect(found.map((candidate) => candidate.label)).toEqual(['OneDrive', 'Dropbox']);
  });

  it('copies each save, dated, into the project\'s own folder, the newest twenty kept, and remembers where', async () => {
    const cloud = await temp();
    const settings = join(await temp(), 'cloud-backup.json');
    const backup = new CloudBackup(settings, () => []);
    await backup.copy('D:\\work\\Trip.scf', '{"a":1}');
    expect((await backup.state()).lastAt).toBeNull();
    await backup.setFolder(cloud);
    for (let index = 0; index < 22; index += 1) await backup.copy('D:\\work\\Trip.scf', `{"save":${index}}`, new Date(Date.UTC(2026, 9, 1, 10, 0, index)));
    const [folder] = await readdir(join(cloud, CLOUD_FOLDER_NAME));
    expect(folder.startsWith('Trip-')).toBe(true);
    const files = (await readdir(join(cloud, CLOUD_FOLDER_NAME, folder))).sort();
    expect(files.length).toBe(20);
    expect(await readFile(join(cloud, CLOUD_FOLDER_NAME, folder, files[19]), 'utf8')).toBe('{"save":21}');
    const state = await backup.state();
    expect(state.folder).toBe(cloud);
    expect(state.lastFile?.endsWith(files[19])).toBe(true);
    expect((await new CloudBackup(settings, () => []).state()).folder).toBe(cloud);
  });
});
