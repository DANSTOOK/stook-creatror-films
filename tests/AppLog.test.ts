import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppLog, formatEntry } from '../src/main/logging/log';

const made: string[] = [];
const temp = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), 'scf-log-'));
  made.push(folder);
  return folder;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe('the app log', () => {
  it('writes an entry as one line - time, level, where, what - with its stack under it', () => {
    const error = new Error('Export failed');
    const line = formatEntry({ level: 'error', source: 'ipc:export:start', message: error.message, stack: error.stack, context: { jobId: 'j1' } }, new Date(Date.UTC(2026, 9, 23, 18, 40, 1, 123)));
    expect(line.startsWith('2026-10-23T18:40:01.123Z ERROR [ipc:export:start] Export failed {"jobId":"j1"}\n')).toBe(true);
    expect(line).toMatch(/\n {4}at /);
  });

  it('keeps a day a file, folds a message repeated within seconds, and counts the errors', async () => {
    const folder = await temp();
    let now = new Date(Date.UTC(2026, 9, 23, 10, 0, 0));
    const log = new AppLog(folder, () => now);
    for (let index = 0; index < 5; index += 1) log.error('renderer:window', new Error('Cannot read properties of undefined'));
    now = new Date(now.getTime() + 500);
    log.warn('renderer:console', 'Something else');
    log.flush();
    const text = await readFile(join(folder, 'scf-2026-10-23.log'), 'utf8');
    expect(text.match(/Cannot read properties of undefined/g)?.length).toBe(2);
    expect(text).toContain('(repeated) (x4)');
    expect(text).toContain('WARN  [renderer:console] Something else');
    expect(log.errorsToday).toBe(5);
    expect(log.lastError?.message).toBe('Cannot read properties of undefined');
  });

  it('deletes the files of more than two weeks ago', async () => {
    const folder = await temp();
    await writeFile(join(folder, 'scf-2026-09-01.log'), 'old\n');
    await writeFile(join(folder, 'scf-2026-10-20.log'), 'recent\n');
    new AppLog(folder, () => new Date(Date.UTC(2026, 9, 23)));
    expect((await readdir(folder)).sort()).toEqual(['scf-2026-10-20.log']);
  });
});
