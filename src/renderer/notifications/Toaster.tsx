import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { currentLocale, useT } from '@renderer/i18n';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { useNotifications, type AppNotification, type NotificationTone } from './notifications';

const ICONS: Record<NotificationTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

/** Icon colours, each 3:1 or better on panel-800 (WCAG 1.4.11). */
const ICON_CLASS: Record<NotificationTone, string> = {
  info: 'text-sky-300',
  success: 'text-success',
  warning: 'text-amber-300',
  error: 'text-red-300',
};

/**
 * The toasts, bottom right, over whatever screen is showing.
 *
 * They do not take the pointer: the corner they sit in is the end of the
 * timeline, and a toast that swallowed a click meant for a clip would be
 * worse than no toast. Only the close button is clickable. The container is
 * a polite live region, and a problem is announced at once (role="alert").
 */
export function Toaster(): JSX.Element {
  const t = useT();
  const toasts = useNotifications((state) => state.toasts);
  const dismiss = useNotifications((state) => state.dismiss);
  const view = useSessionStore((state) => state.view);
  const shown = toasts.filter((toast) => toast.view === view);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toasts"
      className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[min(380px,calc(100vw-32px))] flex-col items-stretch gap-2"
    >
      {shown.map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : undefined}
            data-tone={toast.tone}
            className="scf-rise flex items-start gap-2.5 rounded-menu border border-panel-600 bg-panel-800 px-3 py-2.5 shadow-xl shadow-black/50"
          >
            <Icon size={16} className={`mt-px shrink-0 ${ICON_CLASS[toast.tone]}`} aria-hidden />
            <p className="min-w-0 flex-1 break-words text-sm text-slate-100">{toast.message}</p>
            <button
              type="button"
              className="pointer-events-auto -mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-slate-400 hover:bg-panel-700 hover:text-slate-100"
              aria-label={t('notify.dismiss')}
              title={t('notify.dismiss')}
              onClick={() => dismiss(toast.id)}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function HistoryRow({ entry }: { entry: AppNotification }): JSX.Element {
  const Icon = ICONS[entry.tone];
  const time = new Date(entry.at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' });
  return (
    <li className="flex items-start gap-2 rounded-control px-2 py-1.5 hover:bg-panel-700/60">
      <Icon size={14} className={`mt-0.5 shrink-0 ${ICON_CLASS[entry.tone]}`} aria-hidden />
      <span className="min-w-0 flex-1 break-words text-xs text-slate-200">{entry.message}</span>
      <time className="timecode shrink-0 text-2xs text-slate-400" dateTime={new Date(entry.at).toISOString()}>
        {time}
      </time>
    </li>
  );
}

/**
 * The toolbar's bell: the recent messages, newest first. A dot says there are
 * some that have not been looked at.
 */
export function NotificationsButton(): JSX.Element {
  const t = useT();
  const history = useNotifications((state) => state.history);
  const unread = useNotifications((state) => state.unread);
  const markRead = useNotifications((state) => state.markRead);
  const clearHistory = useNotifications((state) => state.clearHistory);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    markRead();
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, markRead, history.length]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={`tool-button relative w-7 px-0 ${open ? 'tool-button-active' : ''}`}
        aria-label={t('notify.history')}
        title={t('notify.history')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="notifications-button"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={14} />
        {unread > 0 && !open && (
          <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent-hover" />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('notify.history')}
          className="scf-menu absolute right-0 top-full z-[95] mt-1 w-[380px] rounded-menu border border-panel-600 bg-panel-800 p-1 shadow-2xl shadow-black/60"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-xs font-semibold text-slate-200">{t('notify.history')}</span>
            {history.length > 0 && (
              <button type="button" className="text-2xs text-slate-400 hover:text-slate-200" onClick={clearHistory}>
                {t('notify.clear')}
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-slate-400">{t('notify.historyEmpty')}</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {history.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
