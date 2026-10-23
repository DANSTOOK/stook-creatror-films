import { create } from 'zustand';
import { showLibraryTab, type LibraryTab } from '@renderer/components/MediaLibrary/libraryTabs';

/**
 * Workspaces: the editor laid out for one kind of work, with one choice -
 * Resolve's pages and Premiere's workspaces, at this editor's size.
 *
 *   Editing  every panel out, the inspector on the clip's picture;
 *   Color    the library put away for a larger viewer, the video scopes
 *            open beside it, the inspector on Color;
 *   Audio    the mixer open, the inspector on Audio, the library on Sounds.
 *
 * Each panel listens for the choice (WORKSPACE_EVENT) and sets its own part,
 * as the library already does for its tabs; everything stays changeable by
 * hand afterwards. The last one chosen is remembered, to show in the picker.
 */

export type WorkspaceId = 'editing' | 'color' | 'audio';
export const WORKSPACE_IDS: readonly WorkspaceId[] = ['editing', 'color', 'audio'];

export interface Workspace {
  hidden: { media: boolean; inspector: boolean; timeline: boolean };
  mixer: boolean;
  scopes: boolean;
  inspectorTab: 'video' | 'color' | 'audio';
  libraryTab: LibraryTab | null;
}

export const WORKSPACES: Record<WorkspaceId, Workspace> = {
  editing: { hidden: { media: false, inspector: false, timeline: false }, mixer: false, scopes: false, inspectorTab: 'video', libraryTab: 'media' },
  color: { hidden: { media: true, inspector: false, timeline: false }, mixer: false, scopes: true, inspectorTab: 'color', libraryTab: null },
  audio: { hidden: { media: false, inspector: false, timeline: false }, mixer: true, scopes: false, inspectorTab: 'audio', libraryTab: 'sounds' },
};

export const WORKSPACE_EVENT = 'scf:workspace';
const KEY = 'scf.workspace';

function saved(): WorkspaceId {
  try {
    const value = window.localStorage.getItem(KEY);
    return WORKSPACE_IDS.includes(value as WorkspaceId) ? (value as WorkspaceId) : 'editing';
  } catch {
    return 'editing';
  }
}

export const useWorkspace = create<{ current: WorkspaceId }>(() => ({ current: typeof window === 'undefined' ? 'editing' : saved() }));

/** Lay the editor out for `id`: each panel takes its part from the event. */
export function applyWorkspace(id: WorkspaceId): void {
  useWorkspace.setState({ current: id });
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // Not kept: it applies now.
  }
  window.dispatchEvent(new CustomEvent<Workspace>(WORKSPACE_EVENT, { detail: WORKSPACES[id] }));
  const tab = WORKSPACES[id].libraryTab;
  if (tab) showLibraryTab(tab);
}

/** Listen for a workspace being chosen. */
export function onWorkspace(listener: (workspace: Workspace) => void): () => void {
  const handle = (event: Event): void => listener((event as CustomEvent<Workspace>).detail);
  window.addEventListener(WORKSPACE_EVENT, handle);
  return () => window.removeEventListener(WORKSPACE_EVENT, handle);
}
