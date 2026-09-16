import { useMemo } from 'react';
import { create } from 'zustand';
import { isDirty, librarySignature, type SavedMarker } from '@renderer/project/projectSession';
import { useHistoryStore } from './useHistoryStore';
import { useProjectStore } from './useProjectStore';

/**
 * Which screen is showing, and which project file is open.
 *
 * Kept apart from the project store on purpose: the project store is the
 * document, and this is the session around it - the start screen, the file it
 * came from, and whether it has been saved since.
 */

export type AppView = 'home' | 'editor';
export type SaveChoice = 'save' | 'discard' | 'cancel';

interface SessionState {
  view: AppView;
  /** The .scf this project lives in; null until it is first saved. */
  projectPath: string | null;
  projectName: string;
  saved: SavedMarker | null;
  /** The "save changes?" question on screen, if any. */
  unsavedPrompt: { name: string; resolve(choice: SaveChoice): void } | null;

  setView(view: AppView): void;
  /** Start working on a project - new, created or opened - and show the editor. */
  startProject(path: string | null, name: string, marker: SavedMarker): void;
  /** Back to the start screen with nothing open: what was left is saved or was let go. */
  closeProject(): void;
  markSaved(marker: SavedMarker, path: string, name: string): void;
  /** Ask whether to save; resolves with the answer. */
  askToSave(): Promise<SaveChoice>;
  answerPrompt(choice: SaveChoice): void;
}

/** Automation can start straight in the editor: `?start=editor` (see main/index.ts). */
function initialView(): AppView {
  try {
    return new URLSearchParams(window.location.search).get('start') === 'editor' ? 'editor' : 'home';
  } catch {
    return 'home';
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  view: initialView(),
  projectPath: null,
  projectName: 'Untitled project',
  saved: null,
  unsavedPrompt: null,

  setView(view) {
    set({ view });
  },

  startProject(path, name, marker) {
    set({ projectPath: path, projectName: name, saved: path ? marker : null, view: 'editor' });
  },

  closeProject() {
    set({ projectPath: null, projectName: 'Untitled project', saved: null, view: 'home' });
  },

  markSaved(marker, path, name) {
    set({ saved: marker, projectPath: path, projectName: name });
  },

  askToSave() {
    // A question already on screen is answered as "cancel" rather than stacked.
    get().unsavedPrompt?.resolve('cancel');
    return new Promise<SaveChoice>((resolve) => {
      set({ unsavedPrompt: { name: get().projectName, resolve } });
    });
  },

  answerPrompt(choice) {
    const prompt = get().unsavedPrompt;
    set({ unsavedPrompt: null });
    prompt?.resolve(choice);
  },
}));

/** The newest undo step and the library, as they are now. */
export function currentMarker(): SavedMarker {
  const { assets, bins } = useProjectStore.getState();
  return { undoTopId: useHistoryStore.getState().peekUndo()?.id ?? null, library: librarySignature(assets, bins) };
}

export const documentIsDirty = (): boolean => isDirty(useSessionStore.getState().saved, currentMarker());

/** Reactive version of `documentIsDirty`, for the header and the window title. */
export function useIsDirty(): boolean {
  const saved = useSessionStore((state) => state.saved);
  const undoTopId = useHistoryStore((state) => state.undoStack[state.undoStack.length - 1]?.id ?? null);
  const assets = useProjectStore((state) => state.assets);
  const bins = useProjectStore((state) => state.bins);
  const library = useMemo(() => librarySignature(assets, bins), [assets, bins]);
  return isDirty(saved, { undoTopId, library });
}
