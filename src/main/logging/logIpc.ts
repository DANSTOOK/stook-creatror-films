import { app, BrowserWindow, ipcMain, shell, webContents } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { IPC, type LogState } from '@shared/types/ipc';
import { AppLog, type LogEntry } from './log';

/**
 * The log, wired into the app (main/logging/log.ts): one for the whole main
 * process, fed by the main process's own failures, by every request from the
 * page that throws (ipcMain.handle is wrapped before any handler is
 * registered), by the page through IPC.logWrite, and by the page's and the
 * GPU's process going away. SCF_LOG_DIR moves it, for the tests.
 */

let log: AppLog | null = null;

/** The app's version: installed, its own; run from a checkout, Electron answers with its own, so the project's is read. */
function version(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    return String((JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? app.getVersion());
  } catch {
    return app.getVersion();
  }
}

export const appLog = (): AppLog => {
  if (!log) log = new AppLog(process.env.SCF_LOG_DIR || join(app.getPath('userData'), 'scf', 'logs'));
  return log;
};

/** Every request from the page that fails, written with its channel's name. Call before any handler is registered. */
export function logFailedRequests(): void {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    handle(channel, async (event, ...args: unknown[]) => {
      try {
        return await listener(event, ...args);
      } catch (error) {
        appLog().error(`ipc:${channel}`, error);
        throw error;
      }
    });
}

const LEVELS = new Set(['error', 'warn', 'info']);

/** What the page sends, checked: it is a request from a page, like any other. */
function fromPage(raw: unknown): LogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<LogEntry>;
  if (typeof entry.message !== 'string' || !LEVELS.has(String(entry.level))) return null;
  return {
    level: entry.level as LogEntry['level'],
    source: typeof entry.source === 'string' ? `renderer:${entry.source.slice(0, 40)}` : 'renderer',
    message: entry.message.slice(0, 4000),
    ...(typeof entry.stack === 'string' ? { stack: entry.stack.slice(0, 6000) } : {}),
    ...(entry.context && typeof entry.context === 'object' ? { context: entry.context } : {}),
  };
}

const state = (): LogState => {
  const current = appLog();
  return { folder: current.folder, file: current.file(), errorsToday: current.errorsToday, lastError: current.lastError };
};

/** The report "Copy diagnostic report" puts on the clipboard: the machine, then the newest lines. */
function report(): string {
  const gpuInfo = app.getGPUFeatureStatus();
  const lines = [
    `STOOK CREATOR FILMS ${version()} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome}`,
    `Windows ${release()} · ${cpus()[0]?.model ?? '?'} ×${cpus().length} · ${Math.round(totalmem() / 1024 ** 3)} GB RAM · ${app.getLocale()}`,
    `GPU: webgl2 ${gpuInfo.webgl2}, video_decode ${gpuInfo.video_decode}, video_encode ${gpuInfo.video_encode}`,
    `Log: ${appLog().file()}`,
    '',
    appLog().tail(300),
  ];
  return lines.join('\n');
}

export function registerLogHandlers(): void {
  const current = appLog();
  current.info('main', `Started ${version()}`, { electron: process.versions.electron, packaged: app.isPackaged });

  process.on('uncaughtException', (error) => current.error('main', error, { kind: 'uncaughtException' }));
  process.on('unhandledRejection', (reason) => current.error('main', reason, { kind: 'unhandledRejection' }));
  app.on('render-process-gone', (_event, contents, details) =>
    current.error('renderer', `The page's process went away: ${details.reason}`, { exitCode: details.exitCode, url: contents.getURL().slice(0, 120) }),
  );
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    current.error(details.type === 'GPU' ? 'gpu' : 'child', `${details.type} process went away: ${details.reason}`, { exitCode: details.exitCode, name: details.name });
  });
  app.on('browser-window-created', (_event, window: BrowserWindow) => {
    window.on('unresponsive', () => current.warn('renderer', 'A window stopped responding', { title: window.getTitle() }));
  });
  app.on('before-quit', () => current.flush());

  ipcMain.on(IPC.logWrite, (event, raw: unknown) => {
    // Only the app's own pages may write.
    if (!webContents.fromId(event.sender.id)) return;
    const entry = fromPage(raw);
    if (entry) current.write(entry);
  });
  ipcMain.handle(IPC.logState, () => state());
  ipcMain.handle(IPC.logReport, () => report());
  ipcMain.handle(IPC.logOpen, async () => {
    current.flush();
    await shell.openPath(current.folder);
  });
}
