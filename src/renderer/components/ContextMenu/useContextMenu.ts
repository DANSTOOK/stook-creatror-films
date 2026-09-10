import { useCallback, useState } from 'react';
import type { ContextMenuItem, ContextMenuState } from './ContextMenu';

/**
 * Open/close state for a context menu.
 *
 * `open` takes the triggering event so callers never have to remember to call
 * `preventDefault`, which is what otherwise leaves the OS menu showing on top.
 */
export function useContextMenu(): {
  menu: ContextMenuState | null;
  open(event: { preventDefault(): void; clientX: number; clientY: number }, items: ContextMenuItem[]): void;
  close(): void;
} {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const open = useCallback(
    (
      event: { preventDefault(): void; clientX: number; clientY: number },
      items: ContextMenuItem[],
    ) => {
      event.preventDefault();
      if (items.length === 0) return;
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [],
  );

  const close = useCallback(() => setMenu(null), []);

  return { menu, open, close };
}
