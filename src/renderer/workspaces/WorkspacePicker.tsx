import { LayoutTemplate } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT, type MessageKey } from '@renderer/i18n';
import { WORKSPACE_IDS, applyWorkspace, useWorkspace, type WorkspaceId } from './workspaces';

/** The title bar's workspace picker: Editing, Color or Audio (workspaces.ts). */
export function WorkspacePicker(): JSX.Element {
  const t = useT();
  const current = useWorkspace((state) => state.current);
  return (
    <label className="relative flex items-center" {...tip(t('workspace.label'), { hint: t('workspace.hint'), named: false })}>
      <span className="sr-only">{t('workspace.label')}</span>
      <LayoutTemplate size={13} aria-hidden className="pointer-events-none absolute left-2 text-slate-400" />
      <select
        data-testid="workspace-picker"
        className="numeric-input h-7 w-[104px] pl-7 pr-1 text-2xs"
        value={current}
        onChange={(event) => applyWorkspace(event.target.value as WorkspaceId)}
      >
        {WORKSPACE_IDS.map((id) => (
          <option key={id} value={id}>
            {t(`workspace.${id}` as MessageKey)}
          </option>
        ))}
      </select>
    </label>
  );
}
