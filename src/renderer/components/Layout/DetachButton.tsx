import { PanelsTopLeft, PictureInPicture2 } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { useWorkspaceStore, type DetachablePanel } from '@renderer/store/useWorkspaceStore';
import { usePanelWindow } from './panelWindowContext';

/**
 * The button on a panel's header that sends it to a window of its own. One
 * button, the same place, on every panel that can move.
 *
 * In the panel's own window the same button, in the same place, brings it
 * back - "Back to editor", in words while the window is wide enough. That
 * window has no bar of its own (Layout/PanelWindow): the panel's header is
 * its title bar, so the way back belongs there. A panel carried along in
 * another panel's window (the mixer beside a detached timeline) still offers
 * to go out on its own.
 */

export function DetachButton({
  panel,
  wordless = false,
}: {
  panel: DetachablePanel;
  /** A header with no room for words (the timeline's, over its 168px of track names). */
  wordless?: boolean;
}): JSX.Element | null {
  const t = useT();
  const detached = useWorkspaceStore((state) => state.detached[panel]);
  const setDetached = useWorkspaceStore((state) => state.setDetached);
  const scope = usePanelWindow();

  if (detached) {
    if (scope?.panel !== panel) return null;
    return (
      <button
        type="button"
        data-testid={`dock-${panel}`}
        className={`tool-button tool-button-dense shrink-0 font-normal ${wordless ? 'w-6 px-0' : ''}`}
        onClick={scope.dock}
        {...tip(t('panel.dock'), { named: false })}
      >
        <PanelsTopLeft size={13} aria-hidden />
        {/* Words while the window has room for them; a narrow one keeps the
            icon, and the words stay for a screen reader. */}
        <span className={wordless ? 'sr-only' : 'max-[519px]:sr-only'}>{t('panel.dockShort')}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid={`detach-${panel}`}
      className="tool-button tool-button-dense w-6 px-0"
      onClick={() => setDetached(panel, true)}
      {...tip(t('panel.detach'))}
    >
      <PictureInPicture2 size={13} />
    </button>
  );
}

export default DetachButton;
