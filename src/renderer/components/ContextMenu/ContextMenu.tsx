import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';

/**
 * Menus: right-click menus, and the menus that drop from a button (the
 * application menu in the title bar, the media panel's "+").
 *
 * Deliberately unstyled per call site: each panel supplies items, this owns
 * placement, dismissal and keyboard handling so the behaviour is identical
 * wherever a menu opens.
 *
 * An item can open a submenu - the application menu is File, Edit, View... -
 * which opens beside it on hover or with the right arrow, the way a Windows
 * menu does. An item can carry a tick (View > Media), announced as a
 * checkbox item.
 *
 * It grows out of the point that was clicked - from its top corner, or its
 * bottom corner when it had to open upwards near the edge of the window - in
 * a little over a tenth of a second. Menus open dozens of times an hour, so
 * the motion only says where the menu came from and gets out of the way.
 */

export interface ContextMenuItem {
  /** A separator ignores every other field. */
  separator?: boolean;
  label?: string;
  icon?: LucideIcon;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  shortcut?: string;
  disabled?: boolean;
  /** Renders in red - deletions and other destructive actions. */
  danger?: boolean;
  /** A tick beside it: the item is an on/off setting and this is its state. */
  checked?: boolean;
  /** Items of a menu that opens beside this one. */
  submenu?: ContextMenuItem[];
  onSelect?(): void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Opened from the keyboard: the first item starts highlighted. */
  keyboard?: boolean;
  /** Names the menu for a screen reader, e.g. "Application menu". */
  label?: string;
}

export interface ContextMenuProps extends ContextMenuState {
  onClose(): void;
}

interface Level {
  items: ContextMenuItem[];
  /** Where it opens: a point for the first menu, the item's box for a submenu. */
  anchor: { x: number; y: number } | DOMRect;
  active: number;
}

const MARGIN = 8;

/** Keeps a menu fully on screen when opened near an edge. */
function place(anchor: Level['anchor'], width: number, height: number): { left: number; top: number; origin: string } {
  if (anchor instanceof DOMRect) {
    // Beside the item, its first entry level with it; to the left when the
    // right has no room, as Windows does.
    const right = anchor.right - 2;
    const left = right + width + MARGIN > window.innerWidth ? Math.max(MARGIN, anchor.left - width + 2) : right;
    const top = Math.max(MARGIN, Math.min(anchor.top - 5, window.innerHeight - height - MARGIN));
    return { left, top, origin: `top ${left < anchor.left ? 'right' : 'left'}` };
  }
  const { x, y } = anchor;
  const left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN));
  // Near the bottom the menu flips above the cursor rather than being clipped.
  const flipped = y + height + MARGIN > window.innerHeight;
  const top = flipped ? Math.max(MARGIN, y - height) : y;
  const horizontal = left < x ? 'right' : 'left';
  return { left, top, origin: `${flipped ? 'bottom' : 'top'} ${horizontal}` };
}

const selectableIndexes = (items: ContextMenuItem[]): number[] =>
  items.flatMap((item, index) => (item.separator || item.disabled ? [] : [index]));

let menuSerial = 0;

export function ContextMenu({ x, y, items, keyboard = false, label, onClose }: ContextMenuProps): JSX.Element {
  const idPrefix = useRef(`scf-menu-${(menuSerial += 1)}`).current;
  const [levels, setLevels] = useState<Level[]>(() => [
    { items, anchor: { x, y }, active: keyboard ? (selectableIndexes(items)[0] ?? -1) : -1 },
  ]);
  /** The menu the arrow keys are moving in: the deepest one the keyboard entered. */
  const [focusLevel, setFocusLevel] = useState(0);
  const panelRefs = useRef<Array<HTMLDivElement | null>>([]);
  const hoverTimer = useRef<number | undefined>(undefined);

  // Where the keyboard was when the menu opened - usually the button that
  // opened it. Choosing an item, or Escape, puts focus back there before the
  // item runs, so a dialog it opens knows where to return focus when it closes.
  const returnFocus = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  const restoreFocus = useCallback(() => {
    const element = returnFocus.current;
    if (element instanceof HTMLElement && element.isConnected && element !== document.body) {
      element.focus({ preventScroll: true });
    }
  }, []);

  // A new set of items (the same menu reopened elsewhere) starts over.
  useEffect(() => {
    setLevels([{ items, anchor: { x, y }, active: keyboard ? (selectableIndexes(items)[0] ?? -1) : -1 }]);
    setFocusLevel(0);
  }, [items, x, y, keyboard]);

  // Placed straight on the elements, after every render and before paint.
  // Kept out of React state on purpose: a position stored as state is a
  // second render per change, and while an update of another priority is
  // pending React replays the menu's state and hands it a new array each
  // time - which re-ran this and set the position again, for ever.
  useLayoutEffect(() => {
    // Layout size, not getBoundingClientRect: the menu is measured on its first
    // frame, mid-entrance at 95% scale, and a rect that size let menus opened
    // near the edge spill a few pixels out of the window (the project stress
    // test caught 7 in 100).
    levels.forEach((level, index) => {
      const element = panelRefs.current[index];
      if (!element) return;
      const spot = place(level.anchor, element.offsetWidth, element.offsetHeight);
      element.style.left = `${spot.left}px`;
      element.style.top = `${spot.top}px`;
      element.style.transformOrigin = spot.origin;
    });
  });

  // The panel being driven holds the focus, so a screen reader follows the
  // highlighted item through aria-activedescendant.
  useEffect(() => {
    panelRefs.current[focusLevel]?.focus({ preventScroll: true });
  }, [focusLevel, levels.length]);

  const run = useCallback(
    (item: ContextMenuItem) => {
      if (item.disabled || item.separator || item.submenu) return;
      restoreFocus();
      onClose();
      item.onSelect?.();
    },
    [onClose, restoreFocus],
  );

  /** Open the submenu of item `index` in level `depth`, measured from its row. */
  const openSubmenu = useCallback((depth: number, index: number, fromKeyboard: boolean) => {
    const row = document.getElementById(`${idPrefix}-${depth}-${index}`);
    setLevels((current) => {
      const item = current[depth]?.items[index];
      if (!item?.submenu || !row) return current;
      // Already open from this item: leave it (and where the keys are in it).
      if (current[depth].active === index && current[depth + 1]?.items === item.submenu && current.length === depth + 2) {
        return current;
      }
      const next = current.slice(0, depth + 1);
      next[depth] = { ...next[depth], active: index };
      next.push({
        items: item.submenu,
        anchor: row.getBoundingClientRect(),
        active: fromKeyboard ? (selectableIndexes(item.submenu)[0] ?? -1) : -1,
      });
      return next;
    });
    if (fromKeyboard) setFocusLevel(depth + 1);
  }, [idPrefix]);

  const setActive = useCallback((depth: number, index: number) => {
    setLevels((current) => {
      if (current[depth]?.active === index && current.length === depth + 1) return current;
      const next = current.slice(0, depth + 1);
      next[depth] = { ...next[depth], active: index };
      return next;
    });
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const inside = panelRefs.current.some((panel) => panel?.contains(event.target as Node));
      if (!inside) onClose();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const level = levels[focusLevel];
      if (!level) return;
      const selectable = selectableIndexes(level.items);
      const activeItem = level.items[level.active];

      const back = (): void => {
        setLevels((current) => current.slice(0, focusLevel));
        setFocusLevel(focusLevel - 1);
      };

      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          if (focusLevel > 0) {
            back();
            return;
          }
          restoreFocus();
          onClose();
          return;
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          if (selectable.length === 0) return;
          const current = selectable.indexOf(level.active);
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const next = current < 0 ? (step > 0 ? 0 : selectable.length - 1) : (current + step + selectable.length) % selectable.length;
          setActive(focusLevel, selectable[next]);
          return;
        }
        case 'Home':
        case 'End':
          event.preventDefault();
          if (selectable.length) setActive(focusLevel, event.key === 'Home' ? selectable[0] : selectable[selectable.length - 1]);
          return;
        case 'ArrowRight':
          event.preventDefault();
          if (activeItem?.submenu && !activeItem.disabled) openSubmenu(focusLevel, level.active, true);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          if (focusLevel > 0) back();
          return;
        case 'Enter':
        case ' ':
          if (level.active < 0 || !activeItem) return;
          event.preventDefault();
          if (activeItem.submenu) openSubmenu(focusLevel, level.active, true);
          else run(activeItem);
          return;
        default:
          // Every other key stays with the menu: a letter must not reach the
          // editor's tool keys while a menu is open over it.
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) event.preventDefault();
          return;
      }
    };

    // Any scroll or resize invalidates the anchor point, so close rather than
    // leaving a menu floating over unrelated content.
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });

    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [levels, focusLevel, onClose, openSubmenu, restoreFocus, run, setActive]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  return (
    <>
      {levels.map((level, depth) => {
        const activeId = level.active >= 0 ? `${idPrefix}-${depth}-${level.active}` : undefined;
        return (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={depth}
            ref={(element) => {
              panelRefs.current[depth] = element;
            }}
            role="menu"
            tabIndex={-1}
            aria-label={depth === 0 ? label : levels[depth - 1]?.items[levels[depth - 1].active]?.label}
            aria-activedescendant={activeId}
            data-state="open"
            className="scf-menu fixed z-[100] min-w-[208px] overflow-hidden rounded-menu border border-panel-600/80 bg-panel-800/95 p-1 shadow-2xl shadow-black/60 ring-1 ring-black/40 outline-none backdrop-blur-md"
            onContextMenu={(event) => event.preventDefault()}
          >
            {level.items.map((item, index) =>
              item.separator ? (
                // eslint-disable-next-line react/no-array-index-key
                <div key={`sep-${index}`} className="mx-2 my-1 h-px bg-panel-600/70" role="separator" />
              ) : (
                <button
                  // eslint-disable-next-line react/no-array-index-key
                  key={`${item.label}-${index}`}
                  id={`${idPrefix}-${depth}-${index}`}
                  type="button"
                  tabIndex={-1}
                  role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={item.checked === undefined ? undefined : item.checked}
                  aria-haspopup={item.submenu ? 'menu' : undefined}
                  // The key is announced as a shortcut, not read as part of
                  // the name: the item is "Save", not "Save Ctrl+S".
                  aria-keyshortcuts={item.shortcut}
                  aria-expanded={item.submenu ? levels[depth + 1] !== undefined && level.active === index : undefined}
                  disabled={item.disabled}
                  onMouseEnter={() => {
                    window.clearTimeout(hoverTimer.current);
                    setFocusLevel(depth);
                    if (item.submenu && !item.disabled) {
                      // Its own submenu stays open while the pointer is on it.
                      if (levels[depth + 1]?.items !== item.submenu) setActive(depth, index);
                      // A short pause, so a pointer crossing the list on its
                      // way to an open submenu does not swap it for another.
                      hoverTimer.current = window.setTimeout(() => openSubmenu(depth, index, false), 90);
                    } else {
                      setActive(depth, index);
                    }
                  }}
                  onClick={() => (item.submenu ? openSubmenu(depth, index, true) : run(item))}
                  className={`group flex h-control w-full items-center gap-2.5 rounded-control px-2.5 text-left text-xs transition-colors duration-100
                    disabled:pointer-events-none disabled:opacity-40
                    ${item.danger ? 'text-red-300' : 'text-slate-200'}
                    ${level.active === index ? (item.danger ? 'bg-red-500/15 text-red-200' : 'bg-accent/15 text-white') : ''}`}
                >
                  {item.checked ? (
                    <Check size={14} className="shrink-0 text-accent-hover" />
                  ) : item.icon ? (
                    <item.icon
                      size={14}
                      className={`shrink-0 transition-colors duration-100 ${
                        level.active === index ? (item.danger ? 'text-red-300' : 'text-accent-hover') : 'text-slate-400'
                      }`}
                    />
                  ) : (
                    <span className="w-[14px] shrink-0" />
                  )}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <kbd aria-hidden className="shrink-0 rounded border border-panel-600 bg-panel-900 px-1.5 py-px font-sans text-2xs text-slate-400">
                      {item.shortcut}
                    </kbd>
                  )}
                  {item.submenu && <ChevronRight size={13} className="shrink-0 text-slate-400" />}
                </button>
              ),
            )}
          </div>
        );
      })}
    </>
  );
}

export default ContextMenu;
