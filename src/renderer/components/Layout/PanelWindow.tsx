import { useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { TooltipLayer } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import type { DetachablePanel } from '@renderer/store/useWorkspaceStore';
import { PANEL_NAME } from './panelInfo';
import { PanelWindowContext, type PanelWindowScope } from './panelWindowContext';
import { focusDetachedWindow, useDetachedWindow } from './useDetachedWindow';

/**
 * A panel in a window of its own, for a second monitor.
 *
 * The window-opening machinery - same-origin `window.open`, styles copied in,
 * the root mirrored, keys forwarded to the editor, bounds remembered, the
 * headers along the top turned into the window's title bar - all lives in
 * `useDetachedWindow`, shared with the text-to-speech window. This component
 * is the panel's part: it names the window after the panel, portals the panel
 * into it edge to edge, and tells the panel's header which window it is in (so
 * the "Back to editor" button there sends it home) through PanelWindowContext.
 *
 * The window is the panel and nothing else: the panel fills it at any size,
 * and the panel's own header is the window's title bar. The way back is that
 * header's own detach button, turned round - "Back to editor", in words, where
 * the panel was sent out from.
 */

export interface PanelWindowProps {
  panel: DetachablePanel;
  /** The window was closed, or "Back to editor" pressed: the panel goes back. */
  onClose(): void;
  children: ReactNode;
  width?: number;
  height?: number;
}

/**
 * Brings a detached panel's window to the front - the title bar's list of
 * panels that are out uses it, so a window lost behind others is one click
 * away. False when the panel has no window open.
 */
export function focusPanelWindow(panel: DetachablePanel): boolean {
  return focusDetachedWindow(panel);
}

export function PanelWindow({ panel, onClose, children, width = 900, height = 620 }: PanelWindowProps): JSX.Element | null {
  const t = useT();
  const title = t('panel.windowTitle', { name: t(PANEL_NAME[panel]) });
  const scope = useMemo<PanelWindowScope>(() => ({ panel, dock: onClose }), [panel, onClose]);
  const { host, popout } = useDetachedWindow({ name: panel, title, onClose, width, height });

  if (!host || !popout) return null;
  return createPortal(
    <PanelWindowContext.Provider value={scope}>
      {/* Whatever panel is put here fills it, including one (the mixer) that
          takes only the width of its content when docked. Edge to edge: the
          window's frame is the panel's frame (`panel-window` in index.css). */}
      <div data-testid={`panel-window-${panel}`} className="panel-window flex min-h-0 min-w-0 flex-1 [&>*]:min-w-0 [&>*]:flex-1">
        {children}
      </div>
      {/* Tips for the controls in this window, drawn in this window. */}
      <TooltipLayer view={popout} />
    </PanelWindowContext.Provider>,
    host,
  );
}

export default PanelWindow;
