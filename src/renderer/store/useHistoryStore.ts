import { create } from 'zustand';
import type { ProjectState } from '@shared/types';
import { createId } from '@shared/utils/id';
import type { LibrarySnapshot } from '@renderer/media/bins';

/**
 * Undo / redo via the Command pattern.
 *
 * A command owns both directions of an edit. Most edits are expressed as
 * snapshot commands (cheap, because a project document is small and structurally
 * shared), but the interface deliberately allows hand-written commands for
 * operations where a full snapshot would be wasteful.
 */

export interface Command {
  id: string;
  label: string;
  /** Timestamp used to coalesce rapid edits such as a slider drag. */
  timestamp: number;
  /** Merge key: consecutive commands sharing one may be coalesced. */
  mergeKey?: string;
  apply(project: ProjectState): ProjectState;
  revert(project: ProjectState): ProjectState;
  /**
   * Set when the step edited the media library's bins rather than the
   * timeline. Bins live beside the project, not in it, so the project store
   * restores this side itself.
   */
  library?: { before: LibrarySnapshot; after: LibrarySnapshot };
}

const MERGE_WINDOW_MS = 500;
const MAX_HISTORY = 200;

/**
 * A bin edit - new, renamed or deleted bin, a clip filed somewhere else - as
 * one undo step. The project is untouched; the library snapshots are the step.
 */
export function createLibraryCommand(label: string, before: LibrarySnapshot, after: LibrarySnapshot): Command {
  return {
    id: createId('cmd'),
    label,
    timestamp: Date.now(),
    apply: (project) => project,
    revert: (project) => project,
    library: { before, after },
  };
}

/** A command that simply swaps between two whole-project snapshots. */
export function createSnapshotCommand(
  label: string,
  before: ProjectState,
  after: ProjectState,
  mergeKey?: string,
): Command {
  return {
    id: createId('cmd'),
    label,
    timestamp: Date.now(),
    mergeKey,
    apply: () => after,
    revert: () => before,
  };
}

interface HistoryState {
  undoStack: Command[];
  redoStack: Command[];
  canUndo: boolean;
  canRedo: boolean;

  /**
   * Record an already-applied edit.
   *
   * The project store applies the change first and then pushes the command, so
   * the UI never renders an intermediate state.
   */
  push(command: Command): void;
  /** Pop the newest command and hand back the reverted project. */
  undo(current: ProjectState): ProjectState | null;
  redo(current: ProjectState): ProjectState | null;
  /** The step `undo` would take back, without taking it. */
  peekUndo(): Command | undefined;
  /** The step `redo` would reapply, without reapplying it. */
  peekRedo(): Command | undefined;
  clear(): void;
  labels(): { undo: string | null; redo: string | null };
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  push(command) {
    const { undoStack } = get();
    const previous = undoStack[undoStack.length - 1];

    // Coalesce a continuous gesture (dragging a slider, scrubbing a value) into
    // one undo step: keep the original "before" but adopt the new "after".
    const shouldMerge =
      previous !== undefined &&
      command.mergeKey !== undefined &&
      previous.mergeKey === command.mergeKey &&
      command.timestamp - previous.timestamp < MERGE_WINDOW_MS;

    const merged: Command = shouldMerge
      ? { ...previous, apply: command.apply, timestamp: command.timestamp }
      : command;

    const nextStack = shouldMerge
      ? [...undoStack.slice(0, -1), merged]
      : [...undoStack, merged].slice(-MAX_HISTORY);

    set({
      undoStack: nextStack,
      redoStack: [],
      canUndo: nextStack.length > 0,
      canRedo: false,
    });
  },

  undo(current) {
    const { undoStack, redoStack } = get();
    const command = undoStack[undoStack.length - 1];
    if (!command) return null;

    const nextUndo = undoStack.slice(0, -1);
    const nextRedo = [...redoStack, command];

    set({
      undoStack: nextUndo,
      redoStack: nextRedo,
      canUndo: nextUndo.length > 0,
      canRedo: true,
    });

    return command.revert(current);
  },

  redo(current) {
    const { undoStack, redoStack } = get();
    const command = redoStack[redoStack.length - 1];
    if (!command) return null;

    const nextRedo = redoStack.slice(0, -1);
    const nextUndo = [...undoStack, command];

    set({
      undoStack: nextUndo,
      redoStack: nextRedo,
      canUndo: true,
      canRedo: nextRedo.length > 0,
    });

    return command.apply(current);
  },

  peekUndo() {
    const { undoStack } = get();
    return undoStack[undoStack.length - 1];
  },

  peekRedo() {
    const { redoStack } = get();
    return redoStack[redoStack.length - 1];
  },

  clear() {
    set({ undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  },

  labels() {
    const { undoStack, redoStack } = get();
    return {
      undo: undoStack[undoStack.length - 1]?.label ?? null,
      redo: redoStack[redoStack.length - 1]?.label ?? null,
    };
  },
}));
