import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_RECENT_PROJECTS,
  RecentProjectsStore,
  cleanProjectName,
  findRecent,
  normalizeRecent,
  projectNameFromPath,
  recordRecent,
  removeRecent,
  samePath,
  thumbnailNameFor,
  type RecentProjectEntry,
} from '../src/main/projects/recentProjects';

const entry = (path: string, minutesAgo: number, extra: Partial<RecentProjectEntry> = {}): RecentProjectEntry => ({
  path,
  name: projectNameFromPath(path),
  lastOpened: new Date(Date.UTC(2026, 8, 15, 12, 0) - minutesAgo * 60_000).toISOString(),
  width: 1920,
  height: 1080,
  fps: 30,
  durationFrames: 900,
  clipCount: 3,
  ...extra,
});

describe('recent projects list', () => {
  it('turns a typed name into a file name Windows accepts', () => {
    expect(cleanProjectName('  Boda: Ana & Luis / final?  ')).toBe('Boda Ana & Luis final');
    expect(cleanProjectName('trailer...')).toBe('trailer');
    expect(cleanProjectName('<>:"/\\|?*')).toBe('');
    expect(cleanProjectName('x'.repeat(200))).toHaveLength(80);
  });

  it('names a project after its file', () => {
    expect(projectNameFromPath('C:\\Projects\\Teaser v2.scf')).toBe('Teaser v2');
    expect(projectNameFromPath('/home/me/old.fep')).toBe('old');
  });

  it('compares Windows paths without case and with either slash', () => {
    expect(samePath('C:\\Projects\\A.scf', 'c:/projects/a.SCF', true)).toBe(true);
    expect(samePath('/p/A.scf', '/p/a.scf', false)).toBe(false);
    expect(thumbnailNameFor('C:\\P\\A.scf', true)).toBe(thumbnailNameFor('c:/p/a.scf', true));
    expect(thumbnailNameFor('C:\\P\\A.scf', true)).toMatch(/^[a-f0-9]{16}\.jpg$/);
  });

  it('reads a list from disk defensively: junk dropped, newest first, one entry per file', () => {
    const list = normalizeRecent(
      [
        entry('C:\\p\\old.scf', 90),
        { path: 42 },
        'nonsense',
        entry('C:\\p\\new.scf', 5),
        { ...entry('c:/P/OLD.scf', 1), name: 'Old, opened again' },
        { path: 'C:\\p\\bad-time.scf', lastOpened: 'yesterday-ish', thumbnail: '../../escape.jpg' },
      ],
      true,
    );
    expect(list.map((item) => item.name)).toEqual(['Old, opened again', 'new', 'bad-time']);
    expect(list[2].lastOpened).toBe(new Date(0).toISOString());
    expect(list[2]).not.toHaveProperty('thumbnail');
    expect(normalizeRecent({ not: 'a list' })).toEqual([]);
  });

  it('puts a project back on top when it is used again, and caps the list', () => {
    let list: RecentProjectEntry[] = [];
    for (let i = 0; i < MAX_RECENT_PROJECTS + 3; i += 1) {
      const result = recordRecent(list, entry(`C:\\p\\${i}.scf`, 0), true);
      list = result.list;
      if (i >= MAX_RECENT_PROJECTS) expect(result.dropped).toHaveLength(1);
    }
    expect(list).toHaveLength(MAX_RECENT_PROJECTS);
    expect(list[0].path).toBe(`C:\\p\\${MAX_RECENT_PROJECTS + 2}.scf`);

    const again = recordRecent(list, entry('c:/p/10.SCF', 0), true);
    expect(again.list[0].path).toBe('c:/p/10.SCF');
    expect(again.list).toHaveLength(MAX_RECENT_PROJECTS);
    expect(again.dropped).toHaveLength(0);
  });

  it('finds and removes by path', () => {
    const list = [entry('C:\\p\\a.scf', 1), entry('C:\\p\\b.scf', 2)];
    expect(findRecent(list, 'c:/p/B.scf', true)?.name).toBe('b');
    const { list: after, removed } = removeRecent(list, 'C:/P/A.SCF', true);
    expect(removed?.name).toBe('a');
    expect(after.map((item) => item.name)).toEqual(['b']);
  });
});

describe('recent projects store', () => {
  let folder = '';
  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  it('survives a missing or damaged file, and writes a readable one', async () => {
    folder = await mkdtemp(join(tmpdir(), 'scf-recent-'));
    const store = new RecentProjectsStore(folder);
    expect(await store.read()).toEqual([]);

    await writeFile(store.file, '{ this is not json', 'utf8');
    expect(await store.read()).toEqual([]);

    await store.update((list) => recordRecent(list, entry('C:\\p\\a.scf', 0)));
    expect((await store.read()).map((item) => item.name)).toEqual(['a']);
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toHaveLength(1);
  });

  it('loses none of many updates made at once', async () => {
    folder = await mkdtemp(join(tmpdir(), 'scf-recent-'));
    const store = new RecentProjectsStore(folder);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.update((list) => recordRecent(list, entry(`C:\\p\\${i}.scf`, 0)))),
    );
    expect(await store.read()).toHaveLength(12);
  });
});
