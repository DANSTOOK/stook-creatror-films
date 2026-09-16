import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Right-click menu, shared by every panel.
 *
 * Deliberately unstyled per call site: each panel supplies items, this owns
 * placement, dismissal and keyboard handling so the behaviour is identical
 * wherever a menu opens.
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
  onSelect?(): void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface ContextMenuProps extends ContextMenuState {
  onClose(): void;
}

/** Keeps the menu fully on screen when opened near an edge. */
function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
): { left: number; top: number; origin: string } {
  const margin = 8;
  const left = Math.max(margin, Math.min(x, window.innerWidth - width - margin));
  // Near the bottom the menu flips above the cursor rather than being clipped.
  const flipped = y + height + margin > window.innerHeight;
  const top = flipped ? Math.max(margin, y - height) : y;
  const horizontal = left < x ? 'right' : 'left';
  return { left, top, origin: `${flipped ? 'bottom' : 'top'} ${horizontal}` };
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, origin: 'top left' });
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.separator && !item.disabled);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    // Layout size, not getBoundingClientRect: the menu is measured on its first
    // frame, mid-entrance at 95% scale, and a rect that size let menus opened
    // near the edge spill a few pixels out of the window (the project stress
    // test caught 7 in 100).
    setPosition(clampToViewport(x, y, element.offsetWidth, element.offsetHeight));
  }, [x, y]);

  const run = useCallback(
    (item: ContextMenuItem) => {
      if (item.disabled || item.separator) return;
      onClose();
      item.onSelect?.();
    },
    [onClose],
  );

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (selectable.length === 0) return;

        const current = selectable.findIndex(({ index }) => index === activeIndex);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = (current + step + selectable.length) % selectable.length;
        setActiveIndex(selectable[next].index);
        return;
      }

      if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault();
        run(items[activeIndex]);
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
  }, [activeIndex, items, onClose, run, selectable]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="scf-menu fixed z-[100] min-w-[208px] overflow-hidden rounded-lg border border-panel-600/80 bg-panel-800/95 p-1 shadow-2xl shadow-black/60 ring-1 ring-black/40 backdrop-blur-md"
      style={{ left: position.left, top: position.top, transformOrigin: position.origin }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`sep-${index}`} className="mx-2 my-1 h-px bg-panel-600/70" role="separator" />
        ) : (
          <button
            // eslint-disable-next-line react/no-array-index-key
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => run(item)}
            className={`group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-xs transition-colors duration-100
              disabled:pointer-events-none disabled:opacity-40
              ${item.danger ? 'text-red-300' : 'text-slate-200'}
              ${activeIndex === index ? (item.danger ? 'bg-red-500/15 text-red-200' : 'bg-accent/15 text-white') : ''}`}
          >
            {item.icon ? (
              <item.icon
                size={14}
                className={`shrink-0 transition-colors duration-100 ${
                  activeIndex === index ? (item.danger ? 'text-red-300' : 'text-accent-hover') : 'text-slate-400'
                }`}
              />
            ) : (
              <span className="w-[14px] shrink-0" />
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <kbd className="shrink-0 rounded border border-panel-600 bg-panel-900 px-1.5 py-px font-sans text-2xs text-slate-400">
                {item.shortcut}
              </kbd>
            )}
          </button>
        ),
      )}
    </div>
  );
}

export default ContextMenu;
