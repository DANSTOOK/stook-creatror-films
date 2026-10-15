import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { acceleratorLabel, flattenMenu, rank, type PaletteCommand } from './commands';

/**
 * Find a function by typing its name.
 *
 * An editor this size has more in it than anyone can remember where, and the
 * menus only help once you know which menu. This is the same idea as VS
 * Code's command palette and Resolve's own search: type a word, see what
 * matches, press Enter.
 *
 * The list is the application menu itself (commands.ts), so there is no
 * second list of features to keep in step - and nothing here can offer
 * something the menus cannot do. Each row says where it lives and what key
 * runs it, which teaches the menu and the keyboard rather than replacing
 * them.
 */

export interface CommandPaletteProps {
  onClose(): void;
  closing?: boolean;
}

export function CommandPalette({ onClose, closing }: CommandPaletteProps): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const [commands, setCommands] = useState<PaletteCommand[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Asked for once, when it opens: the menu's enabled state is the state of
  // the project right now, and the menu is rebuilt whenever that changes.
  useEffect(() => {
    let cancelled = false;
    void window.filmora
      ?.appMenuModel()
      .then((entries) => {
        if (!cancelled) setCommands(flattenMenu(entries));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => rank(commands, query), [commands, query]);

  // A new query makes the first row the one Enter runs.
  useEffect(() => setActive(0), [query]);

  // Keep the chosen row in sight when the arrows walk past the edge.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (command: PaletteCommand | undefined): void => {
    if (!command || !command.enabled) return;
    // Closed first: the command may open a dialog of its own, and two modals
    // fighting over the focus is worse than either.
    onClose();
    window.filmora?.appMenuInvoke(command.id);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => (matches.length === 0 ? 0 : (index + 1) % matches.length));
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => (matches.length === 0 ? 0 : (index - 1 + matches.length) % matches.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(matches[active]);
    }
  };

  return (
    <Dialog
      title={t('palette.title')}
      icon={Search}
      onClose={onClose}
      closing={closing}
      testId="command-palette"
      widthClass="w-[560px]"
      bodyClassName=""
    >
      <div className="border-b border-panel-700 bg-panel-900 px-4 py-2">
        <label className="relative block">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            data-autofocus
            className="numeric-input w-full pl-8"
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.title')}
            data-testid="palette-search"
            // The list is the listbox this field drives, as the ARIA combobox
            // pattern has it: the field keeps the focus, the rows do not.
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={matches[active] ? `palette-item-${matches[active].id}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
      </div>

      <ul
        id="palette-results"
        ref={listRef}
        role="listbox"
        aria-label={t('palette.title')}
        className="max-h-[320px] overflow-y-auto p-1.5"
        data-testid="palette-results"
      >
        {matches.length === 0 && <li className="px-2 py-3 text-xs text-slate-400">{t('palette.nothing')}</li>}
        {matches.map((command, index) => {
          const keys = acceleratorLabel(command.accelerator);
          return (
            <li
              key={command.id}
              id={`palette-item-${command.id}`}
              role="option"
              aria-selected={index === active}
              aria-disabled={!command.enabled}
              data-testid={`palette-item-${command.id}`}
              data-active={index === active ? 'true' : undefined}
              className={`flex cursor-pointer items-center gap-3 rounded-control px-2 py-1.5 ${
                index === active ? 'bg-accent/20 ring-1 ring-accent/40' : 'hover:bg-panel-800'
              } ${command.enabled ? '' : 'opacity-40'}`}
              onMouseMove={() => setActive(index)}
              onClick={() => run(command)}
            >
              <span className="min-w-0 flex-1 truncate text-xs text-slate-100">
                {command.label}
                {command.checked !== undefined && (
                  <span className="ml-2 text-2xs text-slate-400">
                    {command.checked ? t('palette.on') : t('palette.off')}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-2xs text-slate-500">{command.group}</span>
              {keys && (
                <kbd className="shrink-0 rounded-control border border-panel-600 bg-panel-950 px-1.5 py-0.5 font-sans text-2xs text-slate-300">
                  {keys}
                </kbd>
              )}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
