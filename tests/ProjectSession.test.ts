import { describe, expect, it } from 'vitest';
import {
  formatLength,
  isDirty,
  librarySignature,
  nextUntitledName,
  projectNameFromPath,
  relativeTime,
} from '../src/renderer/project/projectSession';

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('project session', () => {
  it('knows an untouched blank project needs no saving', () => {
    expect(isDirty(null, { undoTopId: null, library: librarySignature([], []) })).toBe(false);
    expect(isDirty(null, { undoTopId: 'cmd_1', library: librarySignature([], []) })).toBe(true);
    expect(isDirty(null, { undoTopId: null, library: librarySignature([{ id: 'a' }], []) })).toBe(true);
  });

  it('is clean at the saved step, dirty after an edit, clean again when it is undone', () => {
    const library = librarySignature([{ id: 'a' }], []);
    const saved = { undoTopId: 'cmd_5', library };
    expect(isDirty(saved, { undoTopId: 'cmd_5', library })).toBe(false);
    expect(isDirty(saved, { undoTopId: 'cmd_6', library })).toBe(true);
    expect(isDirty(saved, { undoTopId: 'cmd_5', library })).toBe(false);
  });

  it('notices an import or re-filing, which the history does not record', () => {
    const saved = { undoTopId: null, library: librarySignature([{ id: 'a' }], []) };
    expect(isDirty(saved, { undoTopId: null, library: librarySignature([{ id: 'a' }, { id: 'b' }], []) })).toBe(true);
    expect(isDirty(saved, { undoTopId: null, library: librarySignature([{ id: 'a', binId: 'x' }], []) })).toBe(true);
    expect(
      librarySignature([{ id: 'a' }], [{ id: 'x', name: 'Shots', parentId: null }]),
    ).not.toBe(librarySignature([{ id: 'a' }], [{ id: 'x', name: 'B-roll', parentId: null }]));
  });

  it('says when, the way people do', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5 min ago');
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3 h ago');
    expect(relativeTime(ago(30 * 3_600_000), NOW)).toBe('yesterday');
    expect(relativeTime(ago(4 * 86_400_000), NOW)).toBe('4 days ago');
    expect(relativeTime(ago(40 * 86_400_000), NOW)).toMatch(/Aug/);
    expect(relativeTime(new Date(0).toISOString(), NOW)).toBe('a while ago');
    expect(relativeTime('not a date', NOW)).toBe('a while ago');
  });

  it('writes lengths as minutes, or hours when there are any', () => {
    expect(formatLength(245 * 30, 30)).toBe('4:05');
    expect(formatLength(3723 * 25, 25)).toBe('1:02:03');
    expect(formatLength(0, 30)).toBe('0:00');
    expect(formatLength(100, 0)).toBe('0:00');
  });

  it('names projects after their file and numbers untitled ones', () => {
    expect(projectNameFromPath('C:\\Work\\Promo final.scf')).toBe('Promo final');
    expect(nextUntitledName([])).toBe('Untitled project');
    expect(nextUntitledName(['Untitled project', 'untitled project 2'])).toBe('Untitled project 3');
  });
});
