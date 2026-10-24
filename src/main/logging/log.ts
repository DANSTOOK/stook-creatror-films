import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app's own log: what went wrong, where and when, in a text file a day
 * on this computer, so a fault that only happens on someone's machine can be
 * found afterwards instead of guessed at. Errors from the main process (an
 * exception, a promise nobody caught, a request from the page that failed -
 * by its channel's name), from the page (the same, its console's errors and
 * warnings, and every error it showed the user), and the crashes of the
 * page's or the GPU's process. Nothing is sent anywhere.
 *
 * One line an entry, readable as it is and easy to search:
 *
 *   2026-10-23T18:40:01.123Z ERROR [renderer] Export failed: … {"jobId":"…"}
 *       at startExport (…)
 *
 * A message repeated within a few seconds is written once, with how many
 * times it came. A day's file stops at 8 MB (the rest of the day goes to a
 * ".1" beside it); files older than 14 days are deleted at start.
 *
 * Nothing in here needs Electron, so the unit tests can load it.
 */

export type LogLevel = 'error' | 'warn' | 'info';

export interface LogEntry {
  level: LogLevel;
  /** Where it came from: main, renderer, ipc:<channel>, gpu, ffmpeg, ... */
  source: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export const KEEP_DAYS = 14;
export const MAX_BYTES = 8 * 1024 * 1024;
const REPEAT_MS = 3000;

const day = (when: Date): string => when.toISOString().slice(0, 10);

/** One entry as its line(s) in the file. */
export function formatEntry(entry: LogEntry, when: Date, repeats = 1): string {
  const context = entry.context && Object.keys(entry.context).length > 0 ? ` ${safeJson(entry.context)}` : '';
  const times = repeats > 1 ? ` (x${repeats})` : '';
  const head = `${when.toISOString()} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${oneLine(entry.message)}${times}${context}`;
  const stack = entry.stack
    ? `\n${entry.stack
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.includes(entry.message))
        .slice(0, 12)
        .map((line) => `    ${line.trim()}`)
        .join('\n')}`
    : '';
  return `${head}${stack}\n`;
}

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' / ').slice(0, 2000);

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' && item.length > 300 ? `${item.slice(0, 300)}…` : item)).slice(0, 1500);
  } catch {
    return '"(unserialisable)"';
  }
}

/** The text of anything thrown, and its stack when it has one. */
export function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: `${error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  return { message: safeJson(error) };
}

export class AppLog {
  private last: { key: string; entry: LogEntry; at: Date; count: number } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Errors written today, for the Preferences' Diagnostics. */
  errorsToday = 0;
  lastError: { at: string; message: string } | null = null;

  constructor(
    readonly folder: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    try {
      mkdirSync(folder, { recursive: true });
      this.prune();
    } catch {
      // No folder: nothing is written, nothing else breaks.
    }
  }

  /** Today's file. */
  file(when = this.now()): string {
    return join(this.folder, `scf-${day(when)}.log`);
  }

  write(entry: LogEntry): void {
    const at = this.now();
    if (entry.level === 'error') {
      this.errorsToday += 1;
      this.lastError = { at: at.toISOString(), message: oneLine(entry.message).slice(0, 300) };
    }
    const key = `${entry.level}|${entry.source}|${entry.message}`;
    if (this.last && this.last.key === key && at.getTime() - this.last.at.getTime() < REPEAT_MS) {
      this.last.count += 1;
      return;
    }
    this.flush();
    this.append(formatEntry(entry, at));
    this.last = { key, entry, at, count: 1 };
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), REPEAT_MS);
    this.flushTimer.unref?.();
  }

  error(source: string, error: unknown, context?: Record<string, unknown>): void {
    this.write({ level: 'error', source, ...describeError(error), ...(context ? { context } : {}) });
  }

  warn(source: string, message: string, context?: Record<string, unknown>): void {
    this.write({ level: 'warn', source, message, ...(context ? { context } : {}) });
  }

  info(source: string, message: string, context?: Record<string, unknown>): void {
    this.write({ level: 'info', source, message, ...(context ? { context } : {}) });
  }

  /** A repeat still being counted, written now. */
  flush(): void {
    if (this.last && this.last.count > 1) {
      // One line: the stack is the first one's.
      const { stack: _stack, ...repeated } = this.last.entry;
      void _stack;
      this.append(formatEntry({ ...repeated, message: `${repeated.message} (repeated)` }, this.now(), this.last.count - 1));
    }
    if (this.last) this.last.count = 1;
  }

  /** The newest lines, today's and yesterday's, for a report. */
  tail(lines = 300): string {
    const files = this.files().slice(-3);
    const text = files.map((name) => readFileSync(join(this.folder, name), 'utf8')).join('');
    return text.split('\n').slice(-lines - 1).join('\n');
  }

  private files(): string[] {
    try {
      return readdirSync(this.folder).filter((name) => /^scf-\d{4}-\d{2}-\d{2}\.log(\.1)?$/.test(name)).sort((a, b) => a.replace('.log.1', '.log0').localeCompare(b.replace('.log.1', '.log0')));
    } catch {
      return [];
    }
  }

  private append(text: string): void {
    try {
      const file = this.file();
      try {
        if (statSync(file).size > MAX_BYTES) {
          rmSync(`${file}.1`, { force: true });
          renameSync(file, `${file}.1`);
        }
      } catch {
        // No file yet today.
      }
      appendFileSync(file, text, 'utf8');
    } catch {
      // A full disk or a locked file: the log is a help, never a cause.
    }
  }

  /** Files older than KEEP_DAYS deleted. */
  private prune(): void {
    const oldest = day(new Date(this.now().getTime() - KEEP_DAYS * 86_400_000));
    for (const name of this.files()) {
      const date = name.slice(4, 14);
      if (date < oldest) rmSync(join(this.folder, name), { force: true });
    }
  }
}
