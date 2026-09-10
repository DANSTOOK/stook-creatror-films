import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Right-click menu, shared by every panel.
 *
 * Deliberately unstyled per call site: each panel supplies items, this owns
 * placement, dismissal and keyboard handling so the behaviour is identical
 * wherever a menu opens.
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
): { left: number; top: number } {
  const margin = 8;
  const left = Math.max(margin, Math.min(x, window.innerWidth - width - margin));
  // Near the bottom the menu flips above the cursor rather than being clipped.
  const top =
    y + height + margin > window.innerHeight ? Math.max(margin, y - height) : y;
  return { left, top };
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.separator && !item.disabled);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition(clampToViewport(x, y, rect.width, rect.height));
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
      className="fixed z-[100] min-w-[196px] overflow-hidden rounded-md border border-panel-600 bg-panel-800 py-1 shadow-xl shadow-black/50"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`sep-${index}`} className="my-1 h-px bg-panel-600" role="separator" />
        ) : (
          <button
            // eslint-disable-next-line react/no-array-index-key
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => run(item)}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors
              disabled:opacity-40 disabled:pointer-events-none
              ${item.danger ? 'text-red-400' : 'text-slate-200'}
              ${activeIndex === index ? (item.danger ? 'bg-red-950/50' : 'bg-panel-700') : ''}`}
          >
            {item.icon ? (
              <item.icon size={13} className="shrink-0 opacity-80" />
            ) : (
              <span className="w-[13px] shrink-0" />
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className="shrink-0 text-2xs text-slate-500">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

export default ContextMenu;
