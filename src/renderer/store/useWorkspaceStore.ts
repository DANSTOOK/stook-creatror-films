import { create } from 'zustand';

/**
 * Which panels are open in a window of their own.
 *
 * A machine with two monitors wants the viewer on one and the timeline on the
 * other; a colourist wants the scopes and the inspector where the picture is
 * not. So each of these panels can be put in its own window and dragged to
 * another screen, the way Premiere undocks a panel.
 *
 * A setting of this machine, not of a project - which screen somebody has is
 * not part of the edit - so it lives in localStorage beside the panel sizes
 * and the language.
 */

export type DetachablePanel = 'viewer' | 'media' | 'inspector' | 'mixer';

export const DETACHABLE_PANELS: readonly DetachablePanel[] = ['viewer', 'media', 'inspector', 'mixer'];

const STORAGE_KEY = 'scf.detachedPanels';

type Detached = Record<DetachablePanel, boolean>;

const NONE: Detached = { viewer: false, media: false, inspector: false, mixer: false };

function load(): Detached {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return NONE;
    const parsed = JSON.parse(stored) as Partial<Record<string, unknown>>;
    const detached = { ...NONE };
    for (const panel of DETACHABLE_PANELS) detached[panel] = parsed[panel] === true;
    return detached;
  } catch {
    return NONE;
  }
}

function save(detached: Detached): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(detached));
  } catch {
    // A layout that cannot be remembered still works for this session.
  }
}

interface WorkspaceState {
  detached: Detached;
  isDetached(panel: DetachablePanel): boolean;
  setDetached(panel: DetachablePanel, detached: boolean): void;
  toggleDetached(panel: DetachablePanel): void;
  /** Everything back in the main window. */
  dockAll(): void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  detached: typeof window === 'undefined' ? { ...NONE } : load(),

  isDetached: (panel) => get().detached[panel],

  setDetached(panel, detached) {
    const next = { ...get().detached, [panel]: detached };
    save(next);
    set({ detached: next });
  },

  toggleDetached(panel) {
    get().setDetached(panel, !get().detached[panel]);
  },

  dockAll() {
    save(NONE);
    set({ detached: { ...NONE } });
  },
}));
