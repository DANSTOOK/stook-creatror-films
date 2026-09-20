import { describe, expect, it } from 'vitest';

import {
  AUTOSAVE_INTERVALS,
  DEFAULT_AUTOSAVE_MINUTES,
  autosaveAction,
  autosaveLabel,
  readAutosaveMinutes,
  type AutosaveState,
} from '@renderer/project/autosave';
import {
  MAX_BACKUPS,
  backupFileName,
  backupFolderName,
  backupTime,
  prunable,
  readSnapshot,
} from '../src/main/projects/backups';

const state = (overrides: Partial<AutosaveState> = {}): AutosaveState => ({
  minutes: 5,
  dirty: true,
  hasPath: true,
  busy: false,
  snapshotOnDisk: false,
  sinceMs: 10 * 60_000,
  ...overrides,
});

describe('when to save without being asked', () => {
  it('saves a project that has a file, once the interval has passed', () => {
    expect(autosaveAction(state())).toBe('save');
  });

  it('waits until then', () => {
    expect(autosaveAction(state({ sinceMs: 4 * 60_000 }))).toBe('wait');
    expect(autosaveAction(state({ sinceMs: 5 * 60_000 }))).toBe('save');
  });

  it('keeps a snapshot for work that has nowhere to be saved', () => {
    expect(autosaveAction(state({ hasPath: false }))).toBe('snapshot');
  });

  it('does nothing while something else is saving or exporting', () => {
    expect(autosaveAction(state({ busy: true }))).toBe('wait');
  });

  it('leaves an unchanged project alone', () => {
    expect(autosaveAction(state({ dirty: false }))).toBe('idle');
  });

  it('throws the snapshot away once the work is saved for real', () => {
    // Otherwise the next start offers to recover what is already in the file.
    expect(autosaveAction(state({ dirty: false, snapshotOnDisk: true }))).toBe('clear');
  });

  it('cleans up after itself when it is turned off', () => {
    expect(autosaveAction(state({ minutes: 0 }))).toBe('idle');
    expect(autosaveAction(state({ minutes: 0, snapshotOnDisk: true }))).toBe('clear');
  });
});

describe('the interval setting', () => {
  it('falls back to the default for anything it cannot read', () => {
    expect(readAutosaveMinutes(null)).toBe(DEFAULT_AUTOSAVE_MINUTES);
    expect(readAutosaveMinutes('nonsense')).toBe(DEFAULT_AUTOSAVE_MINUTES);
    expect(readAutosaveMinutes('7')).toBe(DEFAULT_AUTOSAVE_MINUTES);
  });

  it('keeps one it offered', () => {
    for (const minutes of AUTOSAVE_INTERVALS) expect(readAutosaveMinutes(String(minutes))).toBe(minutes);
  });

  it('says what it does', () => {
    expect(autosaveLabel(0)).toBe('Off');
    expect(autosaveLabel(5)).toBe('Every 5 min');
  });
});

describe('backup files', () => {
  it('names a copy after the moment it was replaced, and reads it back', () => {
    const when = new Date('2026-09-19T21:45:03.250Z');
    const name = backupFileName(when);
    expect(name).toBe('2026-09-19T21-45-03-250.scf');
    expect(backupTime(name)?.toISOString()).toBe(when.toISOString());
  });

  it('ignores a file that is not one of ours', () => {
    expect(backupTime('notes.txt')).toBeNull();
    expect(backupTime('2026-13-45T99-99-99-999.scf')).toBeNull();
  });

  it('gives two projects of the same name folders of their own', () => {
    const one = backupFolderName('C:/work/Trailer.scf');
    const other = backupFolderName('D:/archive/Trailer.scf');
    expect(one).not.toBe(other);
    expect(one.startsWith('Trailer-')).toBe(true);
  });

  it('gives one project the same folder however its path is spelled', () => {
    // The same file on Windows, so the same backups.
    expect(backupFolderName('C:/work/Trailer.scf')).toBe(backupFolderName('C:\\Work\\Trailer.scf'));
  });

  it('keeps the newest copies and drops the rest', () => {
    const names = Array.from({ length: MAX_BACKUPS + 5 }, (_, index) =>
      backupFileName(new Date(Date.UTC(2026, 8, 19, 10, index, 0))),
    );
    const dropped = prunable(names);
    expect(dropped).toHaveLength(5);
    // The five oldest, and nothing that is still among the newest twenty.
    expect(new Set(dropped)).toEqual(new Set(names.slice(0, 5)));
  });

  it('leaves anything that is not a backup where it is', () => {
    expect(prunable(['readme.txt', backupFileName(new Date())], 0)).toHaveLength(1);
  });
});

describe('a recovery snapshot read back off disk', () => {
  it('needs contents to mean anything', () => {
    expect(readSnapshot({ name: 'x', contents: '' })).toBeNull();
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot('{}')).toBeNull();
  });

  it('fills in what an older build did not write', () => {
    const snapshot = readSnapshot({ contents: '{"project":{}}' });
    expect(snapshot).toMatchObject({ name: 'Untitled project', path: null });
    expect(snapshot?.savedAt).toBe(new Date(0).toISOString());
  });
});
