import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * What a panel says when it has nothing to show: a picture of what belongs
 * there, a line saying so, and one saying how to fill it - centred in the
 * room it has, so a big window on a second screen does not read as broken.
 * Apple's guidance for an empty view is the same three things.
 */
export function PanelEmptyState({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <span aria-hidden className="mb-1 grid h-10 w-10 place-items-center rounded-lg border border-panel-700 bg-panel-800 text-slate-400">
        <Icon size={18} />
      </span>
      <p className="text-sm font-semibold text-slate-200">{title}</p>
      <p className="max-w-[300px] text-xs text-slate-400">{hint}</p>
      {children}
    </div>
  );
}

export default PanelEmptyState;
