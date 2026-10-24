import { t } from '@renderer/i18n';

/**
 * The page's side of the app's log (main/logging/log.ts): its uncaught
 * errors, the promises nobody caught, its console's errors and warnings, and
 * every error notice it shows - each sent to the main process, which writes
 * it down with the time and where it came from.
 *
 * The console stays as it was - this only listens - and the main process
 * folds a message repeated within seconds into one line, so a fault in a
 * render loop cannot flood the file.
 */

type Level = 'error' | 'warn' | 'info';

const describe = (value: unknown): { message: string; stack?: string } => {
  if (value instanceof Error) return { message: value.message || value.name, stack: value.stack };
  if (typeof value === 'string') return { message: value };
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
};

function send(level: Level, source: string, value: unknown, context?: Record<string, unknown>): void {
  try {
    const { message, stack } = describe(value);
    window.filmora?.logWrite?.({ level, source, message, ...(stack ? { stack } : {}), ...(context ? { context } : {}) });
  } catch {
    // The log is a help, never a cause.
  }
}

export const logError = (source: string, value: unknown, context?: Record<string, unknown>): void => send('error', source, value, context);
export const logWarn = (source: string, value: unknown, context?: Record<string, unknown>): void => send('warn', source, value, context);

let installed = false;

/** Listen for what goes wrong on the page from now on. Once. */
export function captureErrors(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    // A resource that did not load (an <img>, a <video>) reaches here with no error object.
    if (!event.error && event.target && event.target !== window) {
      const target = event.target as { tagName?: string; src?: string };
      send('warn', 'resource', `${target.tagName ?? 'element'} did not load`, { src: String(target.src ?? '').slice(0, 200) });
      return;
    }
    // The browser's own notice that a resize was handled a frame late: harmless, and not the app's error.
    if (!event.error && /^ResizeObserver loop/.test(event.message ?? '')) return;
    send('error', 'window', event.error ?? event.message, { at: `${event.filename ?? ''}:${event.lineno ?? 0}:${event.colno ?? 0}` });
  }, true);
  window.addEventListener('unhandledrejection', (event) => send('error', 'promise', event.reason));

  const original = { error: console.error.bind(console), warn: console.warn.bind(console) };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    // An Error keeps its stack; anything else is joined into one line.
    send('error', 'console', args.length === 1 ? args[0] : args.map((arg) => describe(arg).message).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    send('warn', 'console', args.map((arg) => describe(arg).message).join(' '));
  };
}

/** Help > Copy diagnostic report: the machine and the newest lines, on the clipboard. */
export async function copyDiagnostics(): Promise<void> {
  const { notify } = await import('@renderer/notifications/notifications');
  try {
    const report = await window.filmora.logReport();
    await window.filmora.clipboardWrite(report);
    notify(t('diag.copied'), 'success');
  } catch (error) {
    const { errorText } = await import('@renderer/errorText');
    notify(errorText(error), 'error');
  }
}
