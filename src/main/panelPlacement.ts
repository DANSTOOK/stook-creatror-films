/**
 * Where a panel's own window may open (renderer/components/Layout/PanelWindow).
 *
 * The window opens where it was last, which can be on a monitor that is no
 * longer there - the laptop is off its dock - and a window opened there is
 * lost off every screen, with no title bar to drag it back by. Pure geometry,
 * kept apart from Electron so it can be tested.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Where the window should be: unchanged if a usable piece of its title bar
 * (`barHeight` tall) is on one of `displays` (their work areas), otherwise
 * centred on `fallback`, shrunk to fit it if need be.
 */
export function placePanelWindow(bounds: Rect, barHeight: number, displays: Rect[], fallback: Rect): Rect {
  // Inset, so a bar that only grazes a screen's edge by a pixel or two - which
  // cannot be grabbed - does not count as on it.
  const bar: Rect = { x: bounds.x + 8, y: bounds.y + 4, width: Math.max(1, bounds.width - 16), height: Math.max(1, barHeight - 8) };
  if (displays.some((area) => overlaps(bar, area))) return bounds;
  const width = Math.min(bounds.width, fallback.width);
  const height = Math.min(bounds.height, fallback.height);
  return {
    x: Math.round(fallback.x + (fallback.width - width) / 2),
    y: Math.round(fallback.y + (fallback.height - height) / 2),
    width,
    height,
  };
}
