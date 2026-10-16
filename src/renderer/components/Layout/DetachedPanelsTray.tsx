import { PanelsTopLeft, PictureInPicture2 } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { DETACHABLE_PANELS, useWorkspaceStore } from '@renderer/store/useWorkspaceStore';
import { focusPanelWindow } from './PanelWindow';
import { PANEL_ICON, PANEL_NAME } from './panelInfo';

/**
 * Where the panels went.
 *
 * A panel sent to its own window leaves the editor's layout altogether - the
 * rest closes over the space it had - so the editor says, in its title bar,
 * which panels are out: one button each, which brings that window to the
 * front when it is lost behind others or on a screen out of sight, and one
 * that puts them all back. Nothing is shown while every panel is at home.
 */
export function DetachedPanelsTray(): JSX.Element | null {
  const t = useT();
  const detached = useWorkspaceStore((state) => state.detached);
  const dockAll = useWorkspaceStore((state) => state.dockAll);
  const out = DETACHABLE_PANELS.filter((panel) => detached[panel]);
  if (out.length === 0) return null;

  return (
    <div
      role="group"
      data-testid="detached-panels"
      aria-label={t('panel.elsewhere')}
      className="app-no-drag flex h-7 min-w-0 items-center gap-0.5 rounded-control border border-panel-700 pl-1.5 pr-0.5"
    >
      <PictureInPicture2 size={13} aria-hidden className="mr-0.5 shrink-0 text-slate-400" />
      {out.map((panel) => {
        const Icon = PANEL_ICON[panel];
        const name = t(PANEL_NAME[panel]);
        return (
          <button
            key={panel}
            type="button"
            data-testid={`detached-${panel}`}
            className="tool-button tool-button-dense min-w-0 gap-1 px-1.5"
            onClick={() => focusPanelWindow(panel)}
            {...tip(name, { hint: t('panel.focus', { name }), named: false })}
          >
            <Icon size={13} aria-hidden className="shrink-0" />
            {/* Named where the bar has room; a narrow editor keeps the icons,
                and the names stay for a screen reader and in the tips. */}
            <span className="truncate max-[1279px]:sr-only">{name}</span>
          </button>
        );
      })}
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-panel-700" />
      <button
        type="button"
        data-testid="dock-all"
        className="tool-button tool-button-dense w-6 shrink-0 px-0"
        onClick={dockAll}
        {...tip(t('panel.dockAll'))}
      >
        <PanelsTopLeft size={13} />
      </button>
    </div>
  );
}

export default DetachedPanelsTray;
