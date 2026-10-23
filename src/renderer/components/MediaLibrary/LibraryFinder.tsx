import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Info, Search } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';

/**
 * The top of the Titles, Transitions, Effects and Stickers tabs: one row
 * with a search and the category picker - a drop-down that lists each
 * category with how many it holds - instead of a wall of chips that took
 * three or four lines of a narrow panel. It stays at the top while the grid
 * scrolls under it, as the browsers in Final Cut and Resolve do. The tab's
 * hint is behind the (i), and still read out with each tile.
 */

export interface FinderOption {
  id: string;
  label: string;
  /** How many the category holds (what the search leaves of it). */
  count: number;
  /** A whole family: shown in bold, with its groups indented under it. */
  heading?: boolean;
  indent?: boolean;
}

interface Props {
  query: string;
  onQuery(query: string): void;
  placeholder: string;
  searchTestId: string;
  options: readonly FinderOption[];
  value: string;
  onChange(id: string): void;
  /** Each option is `${filterTestId}-${id}`; the button that opens them `${filterTestId}-menu`. */
  filterTestId: string;
  /** The tab's hint: the (i)'s tooltip, and the description of each tile (`hintId`). */
  hint: string;
  hintId: string;
  categoriesLabel: string;
}

export function LibraryFinder({ query, onQuery, placeholder, searchTestId, options, value, onChange, filterTestId, hint, hintId, categoriesLabel }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const holder = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.id === value) ?? options[0];

  // A press anywhere else, or Escape, puts the list away.
  useEffect(() => {
    if (!open) return undefined;
    const doc = holder.current?.ownerDocument ?? document;
    const away = (event: PointerEvent): void => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    doc.addEventListener('pointerdown', away, true);
    doc.addEventListener('keydown', escape, true);
    return () => {
      doc.removeEventListener('pointerdown', away, true);
      doc.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  return (
    <div ref={holder} className="sticky top-0 z-20 -mx-2 -mt-2 mb-2 flex items-center gap-1.5 bg-panel-900 px-2 pb-2 pt-2">
      <p id={hintId} className="sr-only">
        {hint}
      </p>
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{placeholder}</span>
        <Search size={13} aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          data-testid={searchTestId}
          placeholder={placeholder}
          className="numeric-input h-7 w-full pl-7 pr-2 text-left"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.stopPropagation();
              onQuery('');
            }
          }}
        />
      </label>
      <div className="relative shrink-0">
        <button
          type="button"
          data-testid={`${filterTestId}-menu`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`${categoriesLabel}: ${current?.label ?? ''}`}
          className={`tool-button tool-button-dense h-7 max-w-[118px] gap-1 px-2 text-2xs ${value !== options[0]?.id ? 'tool-button-active' : ''}`}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="truncate">{current?.label}</span>
          <ChevronDown size={12} aria-hidden className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={categoriesLabel}
            className="scf-rise absolute right-0 top-full z-30 mt-1 max-h-[60vh] w-max min-w-[180px] max-w-[240px] overflow-y-auto rounded-lg bg-panel-800 p-1 shadow-xl shadow-black/30 ring-1 ring-panel-600"
          >
            {options.map((option) => {
              const selected = option.id === value;
              return (
                <li key={option.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-testid={`${filterTestId}-${option.id}`}
                    disabled={option.count === 0 && !selected}
                    className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors disabled:opacity-40 ${
                      selected ? 'bg-accent/15 text-accent-hover' : 'text-slate-200 hover:bg-panel-700'
                    } ${option.heading ? 'mt-1 font-semibold' : ''} ${option.indent ? 'pl-5' : ''}`}
                    onClick={() => {
                      onChange(option.id);
                      setOpen(false);
                    }}
                  >
                    <Check size={12} aria-hidden className={`shrink-0 ${selected ? '' : 'invisible'}`} />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <span className="shrink-0 tabular-nums text-2xs text-slate-400">{option.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <span className="flex h-7 w-5 shrink-0 cursor-help items-center justify-center text-slate-400 hover:text-slate-200" {...tip(hint)}>
        <Info size={13} aria-hidden />
      </span>
    </div>
  );
}
