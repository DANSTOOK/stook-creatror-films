import { useMemo, useState } from 'react';
import { Keyboard, Search, X } from 'lucide-react';

/**
 * Every key the editor answers to, in one place.
 *
 * Premiere and Resolve both keep a keyboard map, and for good reason: an
 * editor built for the keyboard is unusable until you know the keys, and a
 * tooltip only tells you about the button you already found. This is the list
 * for the things that have no button at all - J/K/L, the marks, the
 * three-point edits.
 *
 * It is written by hand rather than gathered from the code, so it can lie if
 * nobody keeps it honest. The interface test presses a sample of these and
 * checks they still do what this says.
 */

interface Shortcut {
  keys: string;
  what: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: Group[] = [
  {
    title: 'Playing and moving',
    items: [
      { keys: 'Space', what: 'Play or pause' },
      { keys: 'J / K / L', what: 'Backwards, stop, forwards - press again to go faster' },
      { keys: '← / →', what: 'One frame; with Shift, ten' },
      { keys: 'Home / End', what: 'To the start, to the end' },
      { keys: 'I / O', what: 'Mark in, mark out' },
      { keys: 'Ctrl+Shift+I / O / X', what: 'Clear the in point, the out point, both' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: ', (comma)', what: 'Insert the marked length at the playhead, pushing what follows' },
      { keys: '. (full stop)', what: 'Overwrite in place, leaving the length alone' },
      { keys: 'B', what: 'Split at the playhead' },
      { keys: 'Ctrl+C / X / V', what: 'Copy, cut, paste at the playhead' },
      { keys: 'Delete', what: 'Remove the selected clips' },
      { keys: 'Ctrl+Z / Ctrl+Y', what: 'Undo, redo' },
      { keys: 'Ctrl+L / Ctrl+Shift+L', what: 'Link the selected clips, unlink them' },
      { keys: 'Alt+click', what: 'One clip of a linked group, without breaking the link' },
      { keys: 'Ctrl+R', what: 'Speed / Duration for the selected clip' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { keys: 'V', what: 'Select' },
      { keys: 'C', what: 'Razor' },
      { keys: 'H', what: 'Pan' },
      { keys: 'T', what: 'Trim - a join rolls, a free edge ripples, the top slips, the bottom slides' },
      { keys: 'S', what: 'Snapping on or off' },
      { keys: '+ / -', what: 'Zoom in, zoom out' },
      { keys: 'Ctrl+wheel', what: 'Zoom around the pointer' },
    ],
  },
  {
    title: 'The project',
    items: [
      { keys: 'Ctrl+S', what: 'Save' },
      { keys: 'Ctrl+Shift+S', what: 'Save as' },
      { keys: 'Ctrl+O', what: 'Open' },
      { keys: '?', what: 'This list' },
      { keys: 'Esc', what: 'Close what is open' },
    ],
  },
];

export interface ShortcutsDialogProps {
  onClose(): void;
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps): JSX.Element {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return SHORTCUT_GROUPS;
    return SHORTCUT_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => item.keys.toLowerCase().includes(needle) || item.what.toLowerCase().includes(needle),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  return (
    <div className="scf-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        data-testid="shortcuts-dialog"
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="scf-dialog panel flex max-h-[86vh] w-[640px] flex-col shadow-2xl shadow-black/60"
      >
        <header className="panel-header justify-between">
          <span className="flex items-center gap-2">
            <Keyboard size={13} />
            Keyboard shortcuts
          </span>
          <button type="button" className="tool-button" onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>

        <div className="border-b border-panel-700 px-4 py-2">
          <label className="relative block">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              className="numeric-input w-full pl-8"
              placeholder="Search the keys"
              aria-label="Search shortcuts"
              data-testid="shortcuts-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {groups.length === 0 && (
            <p className="text-xs text-slate-400">Nothing here answers to that.</p>
          )}
          {groups.map((group) => (
            <section key={group.title} className="space-y-1">
              <span className="section-title">{group.title}</span>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.keys} className="flex items-baseline gap-3 rounded px-1.5 py-1 hover:bg-panel-800">
                    <kbd className="shrink-0 rounded border border-panel-600 bg-panel-950 px-1.5 py-0.5 font-sans text-2xs text-slate-200">
                      {item.keys}
                    </kbd>
                    <span className="text-xs leading-relaxed text-slate-300">{item.what}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
