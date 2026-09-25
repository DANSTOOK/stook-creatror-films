import { create } from 'zustand';
import { useSessionStore } from '@renderer/store/useSessionStore';

/**
 * One way for the app to tell the user something happened.
 *
 * There used to be four: a line of text in the toolbar, a banner parked at
 * the top of the media panel (import errors, "already in the library", the
 * project format it had picked), another above the timeline for drops, and a
 * copy of the toolbar line on the start screen - where "Saved to ..." from a
 * project that was no longer open sat indefinitely. The banners never went
 * away on their own, and each pushed its panel's contents down.
 *
 * Now every message is a toast in the bottom-right corner, as in Premiere and
 * in Windows itself, that goes on its own; and every message is also kept in
 * a short history, so one that went by too fast can be read again.
 */

export type NotificationTone = 'info' | 'success' | 'warning' | 'error';

export interface AppNotification {
  id: number;
  message: string;
  tone: NotificationTone;
  /** When it was raised, for the history. */
  at: number;
  /**
   * The screen it was raised on. A toast about the project in the editor is
   * not shown over the start screen, and the reverse: going home after a
   * save does not carry "Saved to ..." along.
   */
  view: 'editor' | 'home';
}

/** How long each kind stays up. Problems stay longer: they may need reading twice. */
const DURATION_MS: Record<NotificationTone, number> = {
  info: 5000,
  success: 5000,
  warning: 9000,
  error: 12000,
};

/** How many are kept for the history. */
const HISTORY_LIMIT = 40;
/** How many toasts are on screen at once; older ones leave early. */
const VISIBLE_LIMIT = 3;

interface NotificationState {
  toasts: AppNotification[];
  history: AppNotification[];
  /** History entries raised since the history was last opened. */
  unread: number;
  dismiss(id: number): void;
  markRead(): void;
  clearHistory(): void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useNotifications = create<NotificationState>((set) => ({
  toasts: [],
  history: [],
  unread: 0,
  dismiss(id) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
  markRead() {
    set({ unread: 0 });
  },
  clearHistory() {
    set({ history: [], unread: 0 });
  },
}));

/**
 * Raise a message. Returns its id, so a message about work in progress
 * ("Importing...") can be taken down when the work ends.
 *
 * The same text raised again replaces the one on screen instead of stacking a
 * second copy under it.
 */
export function notify(
  message: string,
  tone: NotificationTone = 'info',
  options: { persistent?: boolean } = {},
): number {
  const id = nextId;
  nextId += 1;
  const entry: AppNotification = {
    id,
    message,
    tone,
    at: Date.now(),
    view: useSessionStore.getState().view === 'home' ? 'home' : 'editor',
  };
  const { toasts, history, unread, dismiss } = useNotifications.getState();
  for (const toast of toasts) if (toast.message === message) dismiss(toast.id);
  const kept = useNotifications.getState().toasts;
  for (const toast of kept.slice(0, Math.max(0, kept.length - (VISIBLE_LIMIT - 1)))) dismiss(toast.id);

  useNotifications.setState({
    toasts: [...useNotifications.getState().toasts, entry],
    // A message about work still going is not history yet.
    history: options.persistent ? history : [entry, ...history].slice(0, HISTORY_LIMIT),
    unread: options.persistent ? unread : unread + 1,
  });
  if (!options.persistent) {
    timers.set(id, setTimeout(() => useNotifications.getState().dismiss(id), DURATION_MS[tone]));
  }
  return id;
}

/** Take a message down early. */
export const dismissNotification = (id: number): void => useNotifications.getState().dismiss(id);

