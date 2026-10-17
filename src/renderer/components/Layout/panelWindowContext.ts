import { createContext, useContext } from 'react';
import type { DetachablePanel } from '@renderer/store/useWorkspaceStore';

/**
 * Which panel's own window a component is drawn in, and how to send that
 * panel back - or null in the editor's window.
 *
 * A panel's window has no bar of its own: the panel's header is the window's
 * title bar (Layout/PanelWindow). So the way back has to live in that header,
 * and the button that sent the panel out is the one place every header
 * already has for it (Layout/DetachButton).
 */
export interface PanelWindowScope {
  panel: DetachablePanel;
  dock(): void;
}

export const PanelWindowContext = createContext<PanelWindowScope | null>(null);

export function usePanelWindow(): PanelWindowScope | null {
  return useContext(PanelWindowContext);
}
