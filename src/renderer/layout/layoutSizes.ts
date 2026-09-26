/**
 * Sizes of the resizable panels, and the rules that keep the editor usable.
 *
 * Every border between panels drags, the way it does in DaVinci Resolve: the
 * media panel and the inspector get wider or narrower, the timeline taller or
 * shorter, and the preview takes whatever is left. The preview never drops
 * below a working size, however far a border is pulled, and double-clicking a
 * border (or "Reset layout") puts it back.
 *
 * The layout is a preference about this window, not part of the project, so
 * it lives in localStorage rather than in the saved file. Pure apart from the
 * two storage helpers, which swallow every failure: a blocked or empty store
 * just means the defaults.
 */

export interface PanelLayout {
  mediaWidth: number;
  inspectorWidth: number;
  timelineHeight: number;
}

export type LayoutKey = keyof PanelLayout;

interface Limit {
  min: number;
  max: number;
}

export const DEFAULT_LAYOUT: PanelLayout = {
  mediaWidth: 260,
  inspectorWidth: 300,
  timelineHeight: 300,
};

export const LAYOUT_LIMITS: Record<LayoutKey, Limit> = {
  mediaWidth: { min: 200, max: 640 },
  inspectorWidth: { min: 240, max: 640 },
  timelineHeight: { min: 170, max: 900 },
};

/** Width and height the preview keeps, whatever the other panels do. */
export const MIN_PREVIEW_WIDTH = 320;
export const MIN_PREVIEW_HEIGHT = 200;

/**
 * Smaller windows. Below NARROW_WINDOW_PX the side panels start narrower -
 * only where they are at their default width: a width somebody chose is
 * kept. Below COMPACT_WINDOW_PX they fold away and the title bar's buttons
 * bring them back on demand, so the viewer never shrinks to a thumbnail,
 * which is what a 1280px window with both panels open used to leave it.
 */
export const NARROW_WINDOW_PX = 1440;
export const COMPACT_WINDOW_PX = 1280;
export const NARROW_WIDTHS = { mediaWidth: 220, inspectorWidth: 264 } as const;
/**
 * In a short window the picture is limited by height, not width: an
 * untouched timeline takes about a third of the window there instead of its
 * usual 300px (a 760px laptop window gets 258px, and the picture the rest).
 */
export const SHORT_WINDOW_PX = 900;
export const SHORT_TIMELINE_SHARE = 0.34;

/** The layout as a window this wide shows it: narrower side panels where they are untouched. */
export function responsiveLayout(layout: PanelLayout, windowWidth: number, windowHeight = 0): PanelLayout {
  const short = windowHeight > 0 && windowHeight < SHORT_WINDOW_PX && layout.timelineHeight === DEFAULT_LAYOUT.timelineHeight;
  const timelineHeight = short
    ? Math.max(LAYOUT_LIMITS.timelineHeight.min, Math.round(windowHeight * SHORT_TIMELINE_SHARE))
    : layout.timelineHeight;
  if (!(windowWidth > 0) || windowWidth >= NARROW_WINDOW_PX) return { ...layout, timelineHeight };
  return {
    ...layout,
    timelineHeight,
    mediaWidth: layout.mediaWidth === DEFAULT_LAYOUT.mediaWidth ? NARROW_WIDTHS.mediaWidth : layout.mediaWidth,
    inspectorWidth: layout.inspectorWidth === DEFAULT_LAYOUT.inspectorWidth ? NARROW_WIDTHS.inspectorWidth : layout.inspectorWidth,
  };
}

/** A window too narrow for both side panels and a usable viewer. */
export const isCompactWindow = (windowWidth: number): boolean => windowWidth > 0 && windowWidth < COMPACT_WINDOW_PX;

/** Keyboard step for a focused border; Shift moves four times as far. */
export const LAYOUT_STEP_PX = 16;

export const LAYOUT_STORAGE_KEY = 'scf.panelLayout.v1';

function clampOne(value: number, limit: Limit, ceiling: number): number {
  const top = Math.max(limit.min, Math.min(limit.max, ceiling));
  const safe = Number.isFinite(value) ? value : limit.min;
  return Math.round(Math.min(top, Math.max(limit.min, safe)));
}

/**
 * Fit a layout into the space the editor has.
 *
 * `space` is the area below the toolbar. Before it has been measured (zero),
 * only the fixed limits apply. When the window is too small for every minimum
 * at once, the minimums win and the page scrolls nothing - the preview is what
 * gives way last.
 */
export function clampLayout(layout: PanelLayout, space: { width: number; height: number }): PanelLayout {
  const width = space.width > 0 ? space.width : Number.POSITIVE_INFINITY;
  const height = space.height > 0 ? space.height : Number.POSITIVE_INFINITY;

  // Widening the media panel stops where the preview would get too narrow; it
  // does not push the inspector smaller.
  const inspectorAsIs = clampOne(layout.inspectorWidth, LAYOUT_LIMITS.inspectorWidth, Number.POSITIVE_INFINITY);
  const mediaWidth = clampOne(layout.mediaWidth, LAYOUT_LIMITS.mediaWidth, width - MIN_PREVIEW_WIDTH - inspectorAsIs);
  const inspectorWidth = clampOne(
    layout.inspectorWidth,
    LAYOUT_LIMITS.inspectorWidth,
    width - MIN_PREVIEW_WIDTH - mediaWidth,
  );
  const timelineHeight = clampOne(layout.timelineHeight, LAYOUT_LIMITS.timelineHeight, height - MIN_PREVIEW_HEIGHT);

  return { mediaWidth, inspectorWidth, timelineHeight };
}

/** `layout` with one panel grown by `growPx` (negative shrinks it), then fitted. */
export function resizePanel(
  layout: PanelLayout,
  key: LayoutKey,
  growPx: number,
  space: { width: number; height: number },
): PanelLayout {
  return clampLayout({ ...layout, [key]: layout[key] + growPx }, space);
}

/** A stored layout, field by field: anything missing or malformed takes its default. */
export function parseLayout(raw: string | null): PanelLayout {
  if (!raw) return { ...DEFAULT_LAYOUT };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
  const source = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<Record<LayoutKey, unknown>>;
  const field = (key: LayoutKey): number => {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LAYOUT[key];
  };
  return clampLayout(
    { mediaWidth: field('mediaWidth'), inspectorWidth: field('inspectorWidth'), timelineHeight: field('timelineHeight') },
    { width: 0, height: 0 },
  );
}

export function loadLayout(): PanelLayout {
  try {
    return parseLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: PanelLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage blocked: the layout simply does not survive a restart.
  }
}
