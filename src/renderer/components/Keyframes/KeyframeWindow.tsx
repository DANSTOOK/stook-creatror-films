import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { TooltipLayer } from '@renderer/components/Tooltip/Tooltip';
import { useDetachedWindow } from '@renderer/components/Layout/useDetachedWindow';
import { useT } from '@renderer/i18n';
import { KeyframeEditor } from './KeyframeEditor';

/**
 * The keyframe editor's window: opened from the timeline's toolbar, the
 * inspector, the Window menu or Shift+K, beside the editor or on a second
 * screen. Like a detached panel (Layout/PanelWindow) it is the same React tree
 * and the same store as the editor, so what it shows is the selected clip as
 * it is, and what it changes is changed everywhere at once. Its size and
 * place are remembered.
 */

interface KeyframeWindowState {
  open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
}

export const useKeyframeWindow = create<KeyframeWindowState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open })),
}));

function OpenWindow(): JSX.Element | null {
  const t = useT();
  const hide = useKeyframeWindow((state) => state.hide);
  const { host, popout } = useDetachedWindow({ name: 'keyframes', title: t('kf.title'), onClose: hide, width: 980, height: 540 });
  if (!host || !popout) return null;
  return createPortal(
    <>
      <div data-testid="keyframe-window" className="panel-window flex min-h-0 min-w-0 flex-1 [&>*]:min-w-0 [&>*]:flex-1">
        <KeyframeEditor onClose={hide} />
      </div>
      <TooltipLayer view={popout} />
    </>,
    host,
  );
}

/** Mounted once by App: the window, while it is open. */
export function KeyframeWindow(): JSX.Element | null {
  const open = useKeyframeWindow((state) => state.open);
  return open ? <OpenWindow /> : null;
}
