import type { CaptionLook, CaptionPreset, CaptionTrackSettings } from '@shared/types';

/**
 * How a captions track looks: one look for every caption on it, as Resolve
 * styles a subtitle track and Premiere a caption track - captions are read
 * as a set, and one that looks different from its neighbours reads as a
 * mistake.
 *
 * Each preset has a look of its own, and a track starts on its preset's.
 * From there the font (the three bundled families, or any on this computer),
 * the size, the colour, an outline or a band behind the text, and whether
 * they sit at the bottom or the top of the title-safe area can be changed.
 */

/** The largest and smallest a caption's letters may be, in px of a 1080-line frame. */
export const MIN_CAPTION_SIZE = 16;
export const MAX_CAPTION_SIZE = 160;

export function presetLook(preset: CaptionPreset): CaptionLook {
  const social = preset === 'social';
  return {
    fontFamily: 'Inter',
    fontWeight: social ? 800 : 600,
    // The size a full line just fits at: see captionRender.captionStyle.
    fontSize: null,
    color: '#ffffff',
    outline: { enabled: true, color: '#000000', width: social ? 5 : 3 },
    box: { enabled: false, color: '#000000', opacity: 0.6 },
    position: 'bottom',
  };
}

/** A track's look: its own, or its preset's. */
export const lookOf = (settings: Pick<CaptionTrackSettings, 'preset' | 'look'>): CaptionLook => settings.look ?? presetLook(settings.preset);

const HEX = /^#[0-9a-f]{6}$/i;
const colour = (value: unknown, fallback: string): string => (typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback);
const within = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** A look with every field present and in range; what is missing or wrong takes the preset's value. */
export function normalizeLook(raw: unknown, preset: CaptionPreset): CaptionLook {
  const base = presetLook(preset);
  const source = (raw ?? {}) as Partial<Record<keyof CaptionLook, unknown>>;
  const outline = (source.outline ?? {}) as Partial<Record<keyof CaptionLook['outline'], unknown>>;
  const box = (source.box ?? {}) as Partial<Record<keyof CaptionLook['box'], unknown>>;
  const family = typeof source.fontFamily === 'string' ? source.fontFamily.replace(/["\\]/g, '').trim() : '';
  return {
    fontFamily: family || base.fontFamily,
    fontWeight: Math.round(within(source.fontWeight, 100, 900, base.fontWeight) / 100) * 100,
    fontSize: typeof source.fontSize === 'number' && Number.isFinite(source.fontSize) ? within(source.fontSize, MIN_CAPTION_SIZE, MAX_CAPTION_SIZE, 46) : null,
    color: colour(source.color, base.color),
    outline: {
      enabled: typeof outline.enabled === 'boolean' ? outline.enabled : base.outline.enabled,
      color: colour(outline.color, base.outline.color),
      width: within(outline.width, 0, 20, base.outline.width),
    },
    box: {
      enabled: typeof box.enabled === 'boolean' ? box.enabled : base.box.enabled,
      color: colour(box.color, base.box.color),
      opacity: within(box.opacity, 0, 1, base.box.opacity),
    },
    position: source.position === 'top' ? 'top' : 'bottom',
  };
}
