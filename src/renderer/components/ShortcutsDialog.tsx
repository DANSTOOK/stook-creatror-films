import { useMemo, useState } from 'react';
import { Keyboard, Search } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT, type MessageKey } from '@renderer/i18n';

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
 *
 * Both columns are messages, not only the descriptions: a Spanish keyboard
 * says Mayús, Supr and Inicio where an English one says Shift, Delete and
 * Home.
 */

interface Shortcut {
  keys: MessageKey;
  what: MessageKey;
}

interface Group {
  title: MessageKey;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: Group[] = [
  {
    title: 'keys.groupPlaying',
    items: [
      { keys: 'keys.space', what: 'keys.playPause' },
      { keys: 'keys.jkl', what: 'keys.shuttle' },
      { keys: 'keys.arrows', what: 'keys.step' },
      { keys: 'keys.homeEnd', what: 'keys.startEnd' },
      { keys: 'keys.io', what: 'keys.marks' },
      { keys: 'keys.clearMarksKeys', what: 'keys.clearMarks' },
    ],
  },
  {
    title: 'keys.groupEditing',
    items: [
      { keys: 'keys.comma', what: 'keys.insert' },
      { keys: 'keys.fullStop', what: 'keys.overwrite' },
      { keys: 'keys.b', what: 'keys.split' },
      { keys: 'keys.clipboardKeys', what: 'keys.clipboard' },
      { keys: 'keys.delete', what: 'keys.remove' },
      { keys: 'keys.undoKeys', what: 'keys.undo' },
      // Both redo keys work: Ctrl+Y is the Windows habit, Ctrl+Shift+Z the one
      // Premiere, Resolve and every Mac app use.
      { keys: 'keys.redoKeys', what: 'keys.redo' },
      { keys: 'keys.linkKeys', what: 'keys.link' },
      { keys: 'keys.altClick', what: 'keys.oneOfGroup' },
      { keys: 'keys.speedKeys', what: 'keys.speed' },
    ],
  },
  {
    title: 'keys.groupTools',
    items: [
      { keys: 'keys.v', what: 'keys.select' },
      { keys: 'keys.c', what: 'keys.razor' },
      { keys: 'keys.h', what: 'keys.pan' },
      { keys: 'keys.t', what: 'keys.trim' },
      { keys: 'keys.s', what: 'keys.snapping' },
      { keys: 'keys.plusMinus', what: 'keys.zoom' },
      { keys: 'keys.ctrlWheel', what: 'keys.zoomPointer' },
    ],
  },
  {
    title: 'keys.groupProject',
    items: [
      { keys: 'keys.newKeys', what: 'keys.new' },
      { keys: 'keys.saveKeys', what: 'keys.save' },
      { keys: 'keys.saveAsKeys', what: 'keys.saveAs' },
      { keys: 'keys.openKeys', what: 'keys.open' },
      { keys: 'keys.importKeys', what: 'keys.import' },
      { keys: 'keys.exportKeys', what: 'keys.export' },
      { keys: 'keys.panelKeys', what: 'keys.panels' },
      { keys: 'keys.menuKeys', what: 'keys.menu' },
      { keys: 'keys.question', what: 'keys.thisList' },
      { keys: 'keys.esc', what: 'keys.closeOpen' },
    ],
  },
];

export interface ShortcutsDialogProps {
  onClose(): void;
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const translated = SHORTCUT_GROUPS.map((group) => ({
      title: t(group.title),
      items: group.items.map((item) => ({ id: item.keys, keys: t(item.keys), what: t(item.what) })),
    }));
    const needle = query.trim().toLowerCase();
    if (!needle) return translated;
    return translated
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) => item.keys.toLowerCase().includes(needle) || item.what.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [query, t]);

  return (
    <Dialog
      title={t('keys.title')}
      icon={Keyboard}
      onClose={onClose}
      testId="shortcuts-dialog"
      widthClass="w-[640px]"
      bodyClassName=""
      footer={
        <button type="button" className="button-primary" onClick={onClose}>
          {t('dialog.close')}
        </button>
      }
    >
      <div className="sticky top-0 z-10 border-b border-panel-700 bg-panel-900 px-4 py-2">
        <label className="relative block">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            data-autofocus
            className="numeric-input w-full pl-8"
            placeholder={t('keys.search')}
            aria-label={t('keys.searchLabel')}
            data-testid="shortcuts-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="space-y-4 p-4">
        {groups.length === 0 && <p className="text-xs text-slate-400">{t('keys.nothing')}</p>}
        {groups.map((group) => (
          <section key={group.title} className="space-y-1">
            <span className="section-title">{group.title}</span>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.id} className="flex items-baseline gap-3 rounded-control px-1.5 py-1 hover:bg-panel-800">
                  <kbd className="shrink-0 rounded-control border border-panel-600 bg-panel-950 px-1.5 py-0.5 font-sans text-2xs text-slate-200">
                    {item.keys}
                  </kbd>
                  <span className="text-xs leading-relaxed text-slate-300">{item.what}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
