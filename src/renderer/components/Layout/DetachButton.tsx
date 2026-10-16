import { PictureInPicture2 } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { useWorkspaceStore, type DetachablePanel } from '@renderer/store/useWorkspaceStore';

/**
 * The button on a panel's header that sends it to a window of its own. One
 * button, the same place, on every panel that can move.
 *
 * Once the panel is out it has nothing to show here: its window's own bar
 * carries the way back, in words (Layout/PanelWindow), so the header does not
 * hold a second, wordless copy of the same control.
 */

export function DetachButton({ panel }: { panel: DetachablePanel }): JSX.Element | null {
  const t = useT();
  const detached = useWorkspaceStore((state) => state.detached[panel]);
  const setDetached = useWorkspaceStore((state) => state.setDetached);
  if (detached) return null;

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
