import { PictureInPicture2, PanelsTopLeft } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { useWorkspaceStore, type DetachablePanel } from '@renderer/store/useWorkspaceStore';

/**
 * The button on a panel's header that sends it to a window of its own, and
 * brings it back. One button, the same place, on every panel that can move.
 */

export function DetachButton({ panel }: { panel: DetachablePanel }): JSX.Element {
  const t = useT();
  const detached = useWorkspaceStore((state) => state.detached[panel]);
  const toggle = useWorkspaceStore((state) => state.toggleDetached);

  return (
    <button
      type="button"
      data-testid={`detach-${panel}`}
      aria-pressed={detached}
      className="tool-button tool-button-dense w-6 px-0"
      onClick={() => toggle(panel)}
      {...tip(detached ? t('panel.dock') : t('panel.detach'))}
    >
      {detached ? <PanelsTopLeft size={13} /> : <PictureInPicture2 size={13} />}
    </button>
  );
}

export default DetachButton;
