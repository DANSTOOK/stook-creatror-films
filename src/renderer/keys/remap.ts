import { create } from 'zustand';
import type { MessageKey } from '@renderer/i18n';

/**
 * Keys of one's own. The editor's keys are answered in several places - the
 * transport, the timeline, the app - each by the key it was written for; so
 * rather than teach every one of them a table, a key chosen here is turned
 * into the editor's own key before any of them sees it: press F for Split,
 * and the editor sees B. The key the action had is then free - it does
 * nothing, unless another action was given it. Chosen in the keyboard list
 * (ShortcutsDialog), kept between sessions.
 *
 * Installed first, in the capture phase of the window (main.tsx), so it runs
 * before every handler; the key it sends is marked, so it is not turned again.
 */

export interface RemappableAction {
  id: string;
  /** The editor's own key for it, as comboOf writes keys. */
  combo: string;
  label: MessageKey;
}

export const REMAPPABLE: readonly RemappableAction[] = [
  { id: 'playPause', combo: 'Space', label: 'remap.playPause' },
  { id: 'split', combo: 'B', label: 'remap.split' },
  { id: 'markIn', combo: 'I', label: 'remap.markIn' },
  { id: 'markOut', combo: 'O', label: 'remap.markOut' },
  { id: 'marker', combo: 'M', label: 'remap.marker' },
  { id: 'insert', combo: ',', label: 'remap.insert' },
  { id: 'overwrite', combo: '.', label: 'remap.overwrite' },
  { id: 'remove', combo: 'Delete', label: 'remap.remove' },
  { id: 'rippleDelete', combo: 'Shift+Delete', label: 'remap.rippleDelete' },
  { id: 'rippleTrimStart', combo: 'Q', label: 'remap.rippleTrimStart' },
  { id: 'rippleTrimEnd', combo: 'W', label: 'remap.rippleTrimEnd' },
  { id: 'undo', combo: 'Ctrl+Z', label: 'remap.undo' },
  { id: 'redo', combo: 'Ctrl+Y', label: 'remap.redo' },
  { id: 'select', combo: 'V', label: 'remap.select' },
  { id: 'razor', combo: 'C', label: 'remap.razor' },
  { id: 'pan', combo: 'H', label: 'remap.pan' },
  { id: 'trim', combo: 'T', label: 'remap.trim' },
  { id: 'snapping', combo: 'S', label: 'remap.snapping' },
  { id: 'zoomIn', combo: '=', label: 'remap.zoomIn' },
  { id: 'zoomOut', combo: '-', label: 'remap.zoomOut' },
  { id: 'transition', combo: 'Ctrl+T', label: 'remap.transition' },
  { id: 'speed', combo: 'Ctrl+R', label: 'remap.speed' },
  { id: 'detach', combo: 'Ctrl+Alt+S', label: 'remap.detach' },
  { id: 'keyframes', combo: 'Shift+K', label: 'remap.keyframes' },
  { id: 'title', combo: 'Ctrl+Alt+T', label: 'remap.title' },
  { id: 'fullscreen', combo: 'Shift+F', label: 'remap.fullscreen' },
  { id: 'loop', combo: 'R', label: 'remap.loop' },
  { id: 'save', combo: 'Ctrl+S', label: 'remap.save' },
  { id: 'import', combo: 'Ctrl+I', label: 'remap.import' },
  { id: 'export', combo: 'Ctrl+E', label: 'remap.export' },
];

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** A key press as a combo: "Ctrl+Alt+Shift+K", the key itself upper case, the space bar "Space". Null for a modifier alone. */
export function comboOf(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  // A shifted symbol is its own key ("+", "?"): Shift is only written for letters and named keys.
  const shift = event.shiftKey && (key.length > 1 || /[A-Z]/.test(key));
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

const CODES: Record<string, string> = {
  Space: 'Space',
  ',': 'Comma',
  '.': 'Period',
  '=': 'Equal',
  '-': 'Minus',
  '/': 'Slash',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Enter',
  Escape: 'Escape',
};

/** The key event a combo is: what the editor's handlers would get from a real press. */
export function eventInit(combo: string): KeyboardEventInit {
  const parts = combo.split('+');
  // "Ctrl++" has a "+" for its key: the last part, or "+" when it came out empty.
  const key = parts.at(-1) === '' ? '+' : (parts.at(-1) as string);
  const mods = new Set(parts.slice(0, -1));
  const single = key.length === 1;
  return {
    key: key === 'Space' ? ' ' : single && /[A-Z]/.test(key) && !mods.has('Shift') ? key.toLowerCase() : key,
    code: CODES[key] ?? (single && /[A-Z]/.test(key) ? `Key${key}` : single && /[0-9]/.test(key) ? `Digit${key}` : key),
    ctrlKey: mods.has('Ctrl'),
    altKey: mods.has('Alt'),
    shiftKey: mods.has('Shift'),
    bubbles: true,
    cancelable: true,
  };
}

const KEY = 'scf.keys';

interface RemapState {
  /** Action id -> the key chosen for it, for the actions given one. */
  custom: Record<string, string>;
  assign(id: string, combo: string): void;
  reset(id?: string): void;
}

function saved(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([id, combo]) => typeof combo === 'string' && REMAPPABLE.some((action) => action.id === id))) as Record<string, string>;
  } catch {
    return {};
  }
}

function remember(custom: Record<string, string>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(custom));
  } catch {
    // Not kept: it still works for this session.
  }
}

export const useRemapStore = create<RemapState>((set, get) => ({
  custom: typeof window === 'undefined' ? {} : saved(),
  assign(id, combo) {
    const action = REMAPPABLE.find((candidate) => candidate.id === id);
    if (!action) return;
    const custom = { ...get().custom };
    if (combo === action.combo) delete custom[id];
    else custom[id] = combo;
    set({ custom });
    remember(custom);
  },
  reset(id) {
    const custom = id ? Object.fromEntries(Object.entries(get().custom).filter(([key]) => key !== id)) : {};
    set({ custom });
    remember(custom);
  },
}));

/** The key an action answers to now. */
export const effectiveCombo = (action: RemappableAction, custom: Record<string, string>): string => custom[action.id] ?? action.combo;

/** The other actions that answer to `combo` now, apart from `id`: what a new key would take from. */
export function clashes(id: string, combo: string, custom: Record<string, string>): RemappableAction[] {
  return REMAPPABLE.filter((action) => action.id !== id && effectiveCombo(action, custom) === combo);
}

/** What a press means once keys are one's own: the editor's key to send instead, 'swallow', or null to leave it. */
export function remapPress(combo: string, custom: Record<string, string>): string | 'swallow' | null {
  const chosen = REMAPPABLE.find((action) => custom[action.id] === combo);
  if (chosen) return chosen.combo === combo ? null : chosen.combo;
  // The editor's key for an action moved elsewhere does nothing now.
  if (REMAPPABLE.some((action) => action.combo === combo && custom[action.id] && custom[action.id] !== combo)) return 'swallow';
  return null;
}

/** Key events this module sent, so they are not turned again. */
const sent = new WeakSet<Event>();
/** While a key is being chosen in the list, nothing is turned. */
let capturing = false;
export const setCapturing = (on: boolean): void => {
  capturing = on;
};

let installed = false;

export function installKeyRemap(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'keydown',
    (event) => {
      if (capturing || sent.has(event)) return;
      const custom = useRemapStore.getState().custom;
      if (Object.keys(custom).length === 0) return;
      const target = event.target as HTMLElement | null;
      // Typing a name or a number is typing, not a command.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && !event.ctrlKey && !event.altKey) return;
      const combo = comboOf(event);
      if (!combo) return;
      const meaning = remapPress(combo, custom);
      if (meaning === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (meaning === 'swallow') return;
      const replay = new KeyboardEvent('keydown', eventInit(meaning));
      sent.add(replay);
      (target ?? document.body).dispatchEvent(replay);
    },
    true,
  );
}
